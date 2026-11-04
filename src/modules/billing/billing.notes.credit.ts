import { Op, QueryTypes } from 'sequelize';
import { BillingNote, Invoice, InvoiceLine, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { percentOf } from '../../lib/money';
import { audit } from '../../utils/audit';
import { financialYearOf, nextNumber } from '../../utils/numberSequences';
import { ForbiddenError, UnprocessableError, ValidationError } from '../../utils/errors';
import {
  AUDIT,
  APPROVAL_TYPES,
  GST_HALF_RATE_PCT,
  type LineKind,
  type NoteReasonCode,
} from './billing.constants';
import {
  emitInvoiceChanged,
  enqueueRenderPdf,
  notifyBillAfterCommit,
  queueAdvanceApplyAfterCommit,
} from './billing.invoices.effects';
import {
  cancelPending,
  creditDocumentJournal,
  invalidState,
  lockInvoice,
  lockUnitRow,
  rebalance,
  societyIdOfCall,
  societyIdOfInvoice,
  staleVersion,
} from './billing.invoices.shared';
import { unitLedger } from './billing.ledger.service';
import {
  journalLinesWithFunds,
  loadNoteDto,
  lockNoteChain,
  type CallCtx,
  type NoteDto,
} from './billing.notes.shared';
import { billingPorts } from './billing.ports';
import { societyToday } from './billing.runs.shared';
import type { Transaction } from './billing.types';

/**
 * Credit notes (BR-11-41 to BR-11-45, 8.15): creation reserves the amounts on the lines, issue gives the gapless number, applies
 * the credit to the invoice (BR-11-42), posts ledger and journal. Cancellation and write-off notes are built in
 * `billing.notes.cancel.ts` and issued here.
 *
 * Every credited amount, tax and round-off included, sits on a note line that points at the line it credits
 * (`refInvoiceLineId`); a line's `creditedPaise` is the sum of the absolute amounts of such note lines, so releasing a note is
 * the exact reverse and a cancellation note simply credits every open line.
 */
export interface CreditDraftLine {
  lineKind: LineKind;
  chargeHeadId: number | null;
  headKey: string | null;
  description: string;
  amountPaise: number;
  isTaxable: boolean;
  ledgerAccountCode: string;
  refInvoiceLineId: number | null;
}

export interface CreditDraft {
  reasonCode: NoteReasonCode;
  remarks: string;
  approvalType: 'CREDIT_NOTE' | 'INVOICE_CANCEL' | 'WRITE_OFF' | null;
  lines: CreditDraftLine[];
  dedupeKey?: string | null;
}

const PENDING = ['PENDING_APPROVAL', 'CHANGES_REQUESTED'] as const;
export const CREDITABLE = ['CHARGE', 'INTEREST', 'LATE_FEE'];

/** Lines of the invoice and of its issued debit notes, locked, with the debit notes. */
export async function lockInvoiceLines(societyId: number, invoice: Invoice, t: Transaction) {
  const debitNotes = await BillingNote.findAll({
    where: { societyId, invoiceId: invoice.id!, noteType: 'DEBIT', status: 'ISSUED' },
    order: [['id', 'ASC']],
    transaction: t,
  });
  const lines = await InvoiceLine.findAll({
    where: {
      societyId,
      [Op.or]: [
        { invoiceId: invoice.id! },
        { billingNoteId: { [Op.in]: debitNotes.map(d => Number(d.id)) } },
      ],
    },
    order: [
      ['invoiceId', 'ASC'],
      ['billingNoteId', 'ASC'],
      ['lineNo', 'ASC'],
    ],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  return { debitNotes, lines };
}

export const abs = (n: number) => Math.abs(n);
/** What is left to credit on a line; the sign of a round-off line is kept. */
export const openOf = (l: InvoiceLine): number =>
  Number(l.amountPaise) < 0
    ? -(abs(Number(l.amountPaise)) - Number(l.creditedPaise))
    : Number(l.amountPaise) - Number(l.creditedPaise);

/** Open pending notes of an invoice (reservations not yet applied). */
export const pendingNoteCount = (societyId: number, invoiceId: number, t: Transaction, exceptId?: number) =>
  BillingNote.count({
    where: {
      societyId,
      invoiceId,
      noteType: 'CREDIT',
      status: { [Op.in]: [...PENDING] },
      ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
    },
    transaction: t,
  });

/** An open cancellation request on the invoice blocks new notes (`409 INVOICE_CANCEL_PENDING`). */
export async function assertNoCancelPending(societyId: number, invoiceId: number, t: Transaction) {
  const open = await billingPorts().approvals.lockOpenForEntity(societyId, 'invoice', invoiceId, t);
  if (open && open.type === APPROVAL_TYPES.invoiceCancel) throw cancelPending();
}

/**
 * Tax of a user credit note (BR-11-41): CGST = SGST = `percentOf(taxable credited, 9 %)`; when the credited taxable value
 * reaches the whole taxable value of the invoice and its debit notes, the tax is what is left of theirs, to the paisa.
 * The tax is then spread over the tax lines that still have room.
 */
export async function creditTaxLines(
  all: { debitNotes: BillingNote[]; lines: InvoiceLine[] },
  credits: Map<number, number>,
): Promise<{ lineId: number; kind: 'CGST' | 'SGST'; amountPaise: number }[]> {
  const taxableLines = all.lines.filter(l => l.isTaxable && CREDITABLE.includes(l.lineKind));
  const newTaxable = taxableLines.reduce((a, l) => a + (credits.get(Number(l.id)) ?? 0), 0);
  if (newTaxable === 0) return [];
  const totalTaxable = taxableLines.reduce((a, l) => a + Number(l.amountPaise), 0);
  const before = taxableLines.reduce((a, l) => a + Number(l.creditedPaise), 0);
  const available = all.lines
    .filter(l => l.lineKind === 'CGST' || l.lineKind === 'SGST')
    .reduce((a, l) => a + Number(l.amountPaise) - Number(l.creditedPaise), 0);
  let half = percentOf(newTaxable, GST_HALF_RATE_PCT);
  if (before + newTaxable >= totalTaxable) half = Math.floor(available / 2);
  const out: { lineId: number; kind: 'CGST' | 'SGST'; amountPaise: number }[] = [];
  for (const kind of ['CGST', 'SGST'] as const) {
    let left = Math.min(half, Math.floor(available / 2));
    for (const l of all.lines.filter(x => x.lineKind === kind)) {
      const take = Math.min(left, Number(l.amountPaise) - Number(l.creditedPaise));
      if (take > 0) {
        out.push({ lineId: Number(l.id), kind, amountPaise: take });
        left -= take;
      }
    }
  }
  return out;
}

/** Validates the requested lines of a user credit note and returns the draft lines with the tax. */
export async function buildUserCreditLines(
  societyId: number,
  invoice: Invoice,
  input: { invoiceLineId: number; amountPaise: number }[],
  t: Transaction,
): Promise<{ lines: CreditDraftLine[]; reservations: Map<number, number> }> {
  const all = await lockInvoiceLines(societyId, invoice, t);
  const byId = new Map(all.lines.map(l => [Number(l.id), l]));
  const errors: { field: string; message: string; maxAllowedPaise?: number }[] = [];
  const credits = new Map<number, number>();
  input.forEach((row, i) => {
    const l = byId.get(row.invoiceLineId);
    if (!l || !CREDITABLE.includes(l.lineKind)) {
      errors.push({ field: `lines[${i}].invoiceLineId`, message: 'This line cannot be credited' });
      return;
    }
    const max = Number(l.amountPaise) - Number(l.creditedPaise);
    if (row.amountPaise > max)
      errors.push({
        field: `lines[${i}].amountPaise`,
        message: 'More than the line can still be credited',
        maxAllowedPaise: max,
      });
    credits.set(row.invoiceLineId, row.amountPaise);
  });
  if (errors.some(e => e.maxAllowedPaise === undefined)) throw new ValidationError(errors);
  if (errors.length)
    throw new UnprocessableError(
      'CREDIT_EXCEEDS_LINE',
      'A credit is more than the line can still be credited',
      errors,
    );
  const lines: CreditDraftLine[] = [];
  for (const [id, amount] of credits) {
    const l = byId.get(id)!;
    lines.push({
      lineKind: l.lineKind,
      chargeHeadId: l.chargeHeadId,
      headKey: l.headKey,
      description: `Credit: ${l.description}`.slice(0, 300),
      amountPaise: amount,
      isTaxable: l.isTaxable,
      ledgerAccountCode: l.ledgerAccountCode,
      refInvoiceLineId: id,
    });
  }
  for (const tx of await creditTaxLines(all, credits)) {
    const l = byId.get(tx.lineId)!;
    lines.push({
      lineKind: tx.kind,
      chargeHeadId: null,
      headKey: null,
      description: `Credit: ${l.description}`.slice(0, 300),
      amountPaise: tx.amountPaise,
      isTaxable: false,
      ledgerAccountCode: l.ledgerAccountCode,
      refInvoiceLineId: tx.lineId,
    });
  }
  const total = lines.reduce((a, l) => a + l.amountPaise, 0);
  const owed = Number(invoice.totalPaise) + Number(invoice.debitedPaise) - Number(invoice.creditedPaise);
  if (total > owed)
    throw new UnprocessableError('CREDIT_EXCEEDS_LINE', 'The credit is more than the invoice still owes', [
      { field: 'lines', message: 'More than the invoice still owes', maxAllowedPaise: owed },
    ]);
  const reservations = new Map<number, number>();
  for (const l of lines)
    reservations.set(l.refInvoiceLineId!, (reservations.get(l.refInvoiceLineId!) ?? 0) + abs(l.amountPaise));
  return { lines, reservations };
}

/** Adds (or, with a negative sign, releases) reservations on lines. */
export async function reserveOnLines(
  reservations: Map<number, number>,
  sign: 1 | -1,
  userId: number | null,
  t: Transaction,
): Promise<void> {
  for (const [lineId, amount] of reservations) {
    const l = await InvoiceLine.findByPk(lineId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!l) continue;
    l.creditedPaise = Math.max(0, Number(l.creditedPaise) + sign * amount);
    l.updatedBy = userId;
    await l.save({ transaction: t });
  }
}

/** Inserts a credit note (status `PENDING_APPROVAL`) and its lines. The number comes at issue. */
export async function insertCreditNote(
  ctx: CallCtx,
  invoice: Invoice,
  draft: CreditDraft,
  t: Transaction,
): Promise<BillingNote> {
  const userId = ctx.user?.id ?? null;
  const sum = (k: LineKind) =>
    draft.lines.filter(l => l.lineKind === k).reduce((a, l) => a + l.amountPaise, 0);
  const subtotal = draft.lines
    .filter(l => CREDITABLE.includes(l.lineKind) || l.lineKind === 'WRITE_OFF')
    .reduce((a, l) => a + l.amountPaise, 0);
  const cgst = sum('CGST');
  const sgst = sum('SGST');
  const total = draft.lines.reduce((a, l) => a + l.amountPaise, 0);
  const note = await BillingNote.create(
    {
      societyId: Number(invoice.societyId),
      noteType: 'CREDIT',
      noteNo: null,
      financialYear: null,
      invoiceId: Number(invoice.id),
      unitId: Number(invoice.unitId),
      billToResidentId: Number(invoice.billToResidentId),
      billToName: invoice.billToName,
      reasonCode: draft.reasonCode,
      status: 'PENDING_APPROVAL',
      approvalType: draft.approvalType,
      approvalRequestId: null,
      noteDate: null,
      subtotalPaise: subtotal,
      cgstPaise: cgst,
      sgstPaise: sgst,
      taxPaise: cgst + sgst,
      roundOffPaise: 0,
      totalPaise: total,
      appliedToInvoicePaise: 0,
      excessToAdvancePaise: 0,
      interestFromDate: null,
      interestToDate: null,
      lateFeePolicyId: null,
      dedupeKey: draft.dedupeKey ?? null,
      remarks: draft.remarks.slice(0, 500),
      rejectedReason: null,
      issuedAt: null,
      pdfFileId: null,
      pdfStatus: 'PENDING',
      createdBy: userId,
      updatedBy: userId,
      version: 1,
    },
    { transaction: t },
  );
  await insertNoteLines(Number(invoice.societyId), Number(note.id), draft.lines, userId, t);
  return note;
}

export async function insertNoteLines(
  societyId: number,
  noteId: number,
  lines: CreditDraftLine[],
  userId: number | null,
  t: Transaction,
): Promise<void> {
  let lineNo = 0;
  for (const l of lines)
    await InvoiceLine.create(
      {
        societyId,
        invoiceId: null,
        billingNoteId: noteId,
        lineNo: ++lineNo,
        lineKind: l.lineKind,
        chargeHeadId: l.chargeHeadId,
        headKey: l.headKey,
        description: l.description,
        quantity: null,
        ratePaise: null,
        amountPaise: l.amountPaise,
        isTaxable: false,
        billingRuleVersionId: null,
        periodFrom: null,
        periodTo: null,
        prorationDays: null,
        periodDays: null,
        refInvoiceLineId: l.refInvoiceLineId,
        computation: null,
        ledgerAccountCode: l.ledgerAccountCode,
        creditedPaise: 0,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction: t },
    );
}

/** BR-11-47 recomputed from the lines and the issued credit notes of the invoice and its debit notes. */
export async function recomputeNonInterestBearing(invoiceId: number, t: Transaction): Promise<number> {
  const [row] = await sequelize.query<{ n: string | number | null }>(
    `SELECT COALESCE(SUM(l.amountPaise - COALESCE((
              SELECT SUM(cl.amountPaise) FROM invoice_lines cl JOIN billing_notes cn ON cn.id = cl.billingNoteId
               WHERE cl.refInvoiceLineId = l.id AND cn.noteType = 'CREDIT' AND cn.status = 'ISSUED'), 0)), 0) AS n
       FROM invoice_lines l
       LEFT JOIN charge_heads h ON h.id = l.chargeHeadId
       LEFT JOIN billing_notes dn ON dn.id = l.billingNoteId
      WHERE (l.invoiceId = :invoiceId OR (dn.invoiceId = :invoiceId AND dn.noteType = 'DEBIT' AND dn.status = 'ISSUED'))
        AND (l.lineKind IN ('INTEREST', 'LATE_FEE') OR (l.lineKind = 'CHARGE' AND h.interestBearing = 0))`,
    { replacements: { invoiceId }, type: QueryTypes.SELECT, transaction: t },
  );
  return Number(row?.n ?? 0);
}

/** `409`-style guards of a credit note on an invoice. */
export function assertNoteable(inv: Invoice): void {
  if (inv.status === 'CANCELLED') throw invalidState('This invoice is cancelled');
}

/** Releases the reservations of a pending note and marks it REJECTED (reject, withdraw, cancel). Idempotent. */
export async function releaseNote(
  ctx: CallCtx,
  societyId: number,
  note: BillingNote,
  reason: string,
  t: Transaction,
): Promise<boolean> {
  if (note.status !== 'PENDING_APPROVAL' && note.status !== 'CHANGES_REQUESTED') return false;
  const lines = await InvoiceLine.findAll({ where: { billingNoteId: note.id! }, transaction: t });
  const res = new Map<number, number>();
  for (const l of lines)
    if (l.refInvoiceLineId)
      res.set(
        Number(l.refInvoiceLineId),
        (res.get(Number(l.refInvoiceLineId)) ?? 0) + abs(Number(l.amountPaise)),
      );
  await reserveOnLines(res, -1, ctx.user?.id ?? null, t);
  note.status = 'REJECTED';
  note.rejectedReason = reason.slice(0, 500);
  note.updatedBy = ctx.user?.id ?? null;
  note.version = Number(note.version) + 1;
  await note.save({ transaction: t });
  const writeOff = note.reasonCode === 'WRITE_OFF';
  await audit(
    ctx,
    {
      action: writeOff ? AUDIT.writeOffRejected : AUDIT.creditNoteRejected,
      entityType: 'billing_note',
      entityId: Number(note.id),
      societyId,
      after: { status: 'REJECTED', reason },
    },
    t,
  );
  return true;
}

export interface IssueOptions {
  /** The audit action when the note is issued; defaults by reason code. */
  auditAction?: string;
  /** The invoice is closed by this note (cancellation): the caller sets CANCELLED after. */
  notify?: boolean;
}

/**
 * Issues a credit note (BR-11-42): number, date, application to the invoice, ledger, journal, audit, effects. The invoice and
 * the note are locked and loaded by the caller. Module 12 releases allocations first when the credit exceeds what is owed.
 */
export async function issueCreditNote(
  ctx: CallCtx,
  societyId: number,
  invoice: Invoice,
  note: BillingNote,
  t: Transaction,
  opts: IssueOptions = {},
): Promise<{ appliedPaise: number; excessPaise: number }> {
  const today = await societyToday(societyId);
  const ports = billingPorts();
  if (await ports.journal.isDateLocked(societyId, today))
    throw new UnprocessableError('PERIOD_LOCKED', 'The books are locked for the note date');
  const total = Number(note.totalPaise);
  const before = Number(invoice.outstandingPaise);
  let released = false;
  if (total > before) {
    await ports.payments.onInvoiceCancelled(ctx as never, Number(invoice.id), t);
    await invoice.reload({ transaction: t });
    released = true;
  }
  const owed = Number(invoice.outstandingPaise);
  if (total > owed)
    throw new UnprocessableError('CREDIT_EXCEEDS_LINE', 'The credit is more than the invoice still owes', [
      { field: 'lines', message: 'More than the invoice still owes', maxAllowedPaise: owed },
    ]);
  const noteNo = await nextNumber(societyId, 'CREDIT_NOTE', { date: today, transaction: t });
  const userId = ctx.user?.id ?? null;
  const excess = Math.max(0, total - before);
  note.noteNo = noteNo;
  note.financialYear = financialYearOf(today);
  note.noteDate = today;
  note.status = 'ISSUED';
  note.appliedToInvoicePaise = total;
  note.excessToAdvancePaise = excess;
  note.issuedAt = now();
  note.updatedBy = userId;
  note.version = Number(note.version) + 1;
  await note.save({ transaction: t });

  invoice.creditedPaise = Number(invoice.creditedPaise) + total;
  if (note.reasonCode === 'WRITE_OFF') invoice.writtenOffPaise = Number(invoice.writtenOffPaise) + total;
  rebalance(invoice, today, userId);
  invoice.nonInterestBearingPaise = await recomputeNonInterestBearing(Number(invoice.id), t);
  await invoice.save({ transaction: t });

  const lines = await InvoiceLine.findAll({
    where: { billingNoteId: note.id! },
    order: [['lineNo', 'ASC']],
    transaction: t,
  });
  await unitLedger.post(
    ctx,
    {
      unitId: Number(note.unitId),
      entryType: 'CREDIT_NOTE',
      refType: 'billing_note',
      refId: Number(note.id),
      debitPaise: 0,
      creditPaise: total,
      date: today,
      narration: `Credit note ${noteNo} on ${invoice.invoiceNo}`,
    },
    t,
  );
  const writeOff = note.reasonCode === 'WRITE_OFF';
  await ports.journal.post(
    ctx as never,
    {
      date: today,
      voucherType: writeOff ? 'WRITE_OFF' : 'CREDIT_NOTE',
      refType: 'billing_note',
      refId: Number(note.id),
      narration: `${writeOff ? 'Write-off' : 'Credit note'} ${noteNo} on ${invoice.invoiceNo}`,
      lines: creditDocumentJournal(
        Number(note.unitId),
        total,
        await journalLinesWithFunds(societyId, invoice, lines, t),
      ),
    },
    t,
  );
  await audit(
    ctx,
    {
      action: opts.auditAction ?? (writeOff ? AUDIT.writeOffIssued : AUDIT.creditNoteIssued),
      entityType: 'billing_note',
      entityId: Number(note.id),
      entityLabel: noteNo,
      societyId,
      after: { invoiceId: Number(invoice.id), totalPaise: total, excessToAdvancePaise: excess },
    },
    t,
  );
  emitInvoiceChanged(t, { ...invoice.get(), societyId });
  enqueueRenderPdf(t, { kind: 'note', id: Number(note.id), societyId });
  if (released) queueAdvanceApplyAfterCommit(t, societyId, [Number(invoice.unitId)]);
  if (opts.notify !== false)
    notifyBillAfterCommit(
      t,
      'billing.credit_note_issued',
      {
        societyId,
        unitId: Number(invoice.unitId),
        residentId: Number(invoice.billToResidentId),
        relation: invoice.billToRelation,
        date: today,
      },
      { noteNo, invoiceNo: invoice.invoiceNo, amountPaise: total },
    );
  return { appliedPaise: total, excessPaise: excess };
}

// ------------------------------------------------------------------ route 8.15

export async function createCreditNote(
  ctx: CallCtx,
  invoiceId: number,
  input: {
    reasonCode: NoteReasonCode;
    remarks: string;
    lines: { invoiceLineId: number; amountPaise: number }[];
  },
): Promise<NoteDto> {
  const societyId = await societyIdOfInvoice(ctx, invoiceId);
  const noteId = await sequelize.transaction(async t => {
    await assertNoCancelPending(societyId, invoiceId, t);
    const peek = await Invoice.findOne({
      where: { id: invoiceId, societyId },
      attributes: ['unitId'],
      transaction: t,
    });
    if (peek) await lockUnitRow(societyId, Number(peek.unitId), t);
    const invoice = await lockInvoice(societyId, invoiceId, t);
    assertNoteable(invoice);
    const built = await buildUserCreditLines(societyId, invoice, input.lines, t);
    const note = await insertCreditNote(
      ctx,
      invoice,
      {
        reasonCode: input.reasonCode,
        remarks: input.remarks,
        approvalType: 'CREDIT_NOTE',
        lines: built.lines,
      },
      t,
    );
    await reserveOnLines(built.reservations, 1, ctx.user?.id ?? null, t);
    const req = await billingPorts().approvals.request(
      ctx as never,
      {
        type: APPROVAL_TYPES.creditNote,
        entityType: 'billing_note',
        entityId: Number(note.id),
        title: `Credit note on ${invoice.invoiceNo}`,
        amountPaise: Number(note.totalPaise),
        summary: input.remarks,
        payload: { invoiceId, reasonCode: input.reasonCode, totalPaise: Number(note.totalPaise) },
      },
      t,
    );
    note.approvalRequestId = req.id;
    await note.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.creditNoteRequested,
        entityType: 'billing_note',
        entityId: Number(note.id),
        societyId,
        after: { invoiceId, totalPaise: Number(note.totalPaise), reasonCode: input.reasonCode },
      },
      t,
    );
    if (req.status === 'APPROVED') await issueCreditNote(ctx, societyId, invoice, note, t);
    return Number(note.id);
  });
  return loadNoteDto(societyId, noteId);
}

// ------------------------------------------------------------------ module 14 callbacks

/** `onApproved` of `CREDIT_NOTE` and `WRITE_OFF` (entity `billing_note`). */
export async function onNoteApproved(ctx: CallCtx, noteId: number, t: Transaction): Promise<void> {
  const societyId = await societyIdOfCall(ctx);
  const { note, invoice } = await lockNoteChain(societyId, noteId, t);
  if (note.status === 'ISSUED') return;
  if (note.status !== 'PENDING_APPROVAL') throw invalidState('This note is not waiting for approval');
  assertNoteable(invoice);
  if (note.reasonCode === 'WRITE_OFF' && Number(note.totalPaise) > Number(invoice.outstandingPaise))
    throw new UnprocessableError(
      'WRITE_OFF_EXCEEDS_OUTSTANDING',
      'The write-off is more than the invoice still owes',
    );
  await issueCreditNote(ctx, societyId, invoice, note, t);
}

export async function onNoteRejected(
  ctx: CallCtx,
  noteId: number,
  reason: string,
  t: Transaction,
): Promise<void> {
  const societyId = await societyIdOfCall(ctx);
  const { note } = await lockNoteChain(societyId, noteId, t);
  await releaseNote(ctx, societyId, note, reason || 'Rejected', t);
}

export async function onNoteChangesRequested(ctx: CallCtx, noteId: number, t: Transaction): Promise<void> {
  const societyId = await societyIdOfCall(ctx);
  const { note } = await lockNoteChain(societyId, noteId, t);
  if (note.status !== 'PENDING_APPROVAL') return;
  note.status = 'CHANGES_REQUESTED';
  note.updatedBy = ctx.user?.id ?? null;
  note.version = Number(note.version) + 1;
  await note.save({ transaction: t });
}

// ------------------------------------------------------------------ 8.19 patch and withdraw

export async function patchCreditNote(
  ctx: CallCtx,
  noteId: number,
  input: { remarks?: string; lines?: { invoiceLineId: number; amountPaise: number }[]; version: number },
): Promise<NoteDto> {
  const societyId = await societyIdOfCall(ctx);
  await sequelize.transaction(async t => {
    const { note, invoice } = await lockNoteChain(societyId, noteId, t);
    if (
      note.noteType !== 'CREDIT' ||
      note.status !== 'CHANGES_REQUESTED' ||
      note.approvalType !== 'CREDIT_NOTE'
    )
      throw invalidState('Only a credit note with requested changes can be edited');
    if (Number(note.version) !== input.version) throw staleVersion();
    if (note.createdBy !== ctx.user?.id) throw new ForbiddenError();
    assertNoteable(invoice);
    const userId = ctx.user?.id ?? null;
    if (input.lines) {
      // release the old reservations, then reserve the new lines
      const old = await InvoiceLine.findAll({
        where: { billingNoteId: note.id! },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      const res = new Map<number, number>();
      for (const l of old)
        if (l.refInvoiceLineId)
          res.set(
            Number(l.refInvoiceLineId),
            (res.get(Number(l.refInvoiceLineId)) ?? 0) + abs(Number(l.amountPaise)),
          );
      await reserveOnLines(res, -1, userId, t);
      await sequelize.query('DELETE FROM invoice_lines WHERE billingNoteId = :id', {
        replacements: { id: Number(note.id) },
        transaction: t,
      });
      const built = await buildUserCreditLines(societyId, invoice, input.lines, t);
      await insertNoteLines(societyId, noteId, built.lines, userId, t);
      await reserveOnLines(built.reservations, 1, userId, t);
      const sum = (k: LineKind) =>
        built.lines.filter(l => l.lineKind === k).reduce((a, l) => a + l.amountPaise, 0);
      const total = built.lines.reduce((a, l) => a + l.amountPaise, 0);
      note.subtotalPaise = built.lines
        .filter(l => CREDITABLE.includes(l.lineKind))
        .reduce((a, l) => a + l.amountPaise, 0);
      note.cgstPaise = sum('CGST');
      note.sgstPaise = sum('SGST');
      note.taxPaise = sum('CGST') + sum('SGST');
      note.totalPaise = total;
    }
    if (input.remarks !== undefined) note.remarks = input.remarks;
    note.status = 'PENDING_APPROVAL';
    note.updatedBy = userId;
    note.version = Number(note.version) + 1;
    await note.save({ transaction: t });
    await billingPorts().approvals.resubmit(
      ctx as never,
      Number(note.approvalRequestId),
      {
        title: `Credit note on ${invoice.invoiceNo}`,
        amountPaise: Number(note.totalPaise),
        payload: { invoiceId: Number(invoice.id), totalPaise: Number(note.totalPaise) },
      },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT.creditNoteResubmitted,
        entityType: 'billing_note',
        entityId: noteId,
        societyId,
        after: { totalPaise: Number(note.totalPaise) },
      },
      t,
    );
  });
  return loadNoteDto(societyId, noteId);
}

export async function withdrawNote(
  ctx: CallCtx,
  noteId: number,
  input: { reason: string; version: number },
): Promise<NoteDto> {
  const societyId = await societyIdOfCall(ctx);
  await sequelize.transaction(async t => {
    const { note } = await lockNoteChain(societyId, noteId, t);
    if (
      note.noteType !== 'CREDIT' ||
      (note.status !== 'PENDING_APPROVAL' && note.status !== 'CHANGES_REQUESTED')
    )
      throw invalidState('Only a pending credit note can be withdrawn');
    if (Number(note.version) !== input.version) throw staleVersion();
    const isOwner = note.createdBy === ctx.user?.id;
    if (!isOwner && !ctx.permissions?.has('finance.billing.edit')) throw new ForbiddenError();
    if (note.approvalRequestId)
      await billingPorts().approvals.cancel(ctx as never, Number(note.approvalRequestId), input.reason, t);
    await note.reload({ transaction: t });
    await releaseNote(ctx, societyId, note, input.reason, t);
    await audit(
      ctx,
      {
        action: AUDIT.creditNoteWithdrawn,
        entityType: 'billing_note',
        entityId: noteId,
        societyId,
        reason: input.reason,
      },
      t,
    );
  });
  return loadNoteDto(societyId, noteId);
}
