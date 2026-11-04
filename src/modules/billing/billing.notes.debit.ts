import { BillingNote, ChargeHead, Invoice, InvoiceLine, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { NotFoundError, UnprocessableError } from '../../utils/errors';
import { financialYearOf, nextNumber } from '../../utils/numberSequences';
import { AUDIT, type NoteReasonCode } from './billing.constants';
import { buildDocument, type DocLineInput } from './billing.invoices.build';
import { emitInvoiceChanged, enqueueRenderPdf, notifyBillAfterCommit } from './billing.invoices.effects';
import {
  debitDocumentJournal,
  fundFor,
  lockInvoice,
  lockUnitRow,
  rebalance,
  societyIdOfInvoice,
} from './billing.invoices.shared';
import { unitLedger } from './billing.ledger.service';
import { assertNoCancelPending, assertNoteable, recomputeNonInterestBearing } from './billing.notes.credit';
import { loadNoteDto, type CallCtx, type NoteDto } from './billing.notes.shared';
import { billingPorts } from './billing.ports';
import { loadBillingSettings, societyToday } from './billing.runs.shared';
import type { Transaction } from './billing.types';

/**
 * Debit notes (BR-11-46, 8.16). `issueDebitNote` is the shared core: the debit note route calls it, and the late fee job of 11.5
 * calls it for interest and late fee notes (lines of kind `INTEREST` or `LATE_FEE`, `dedupeKey`, interest window, policy).
 * The caller has locked the unit row and the invoice (`FOR UPDATE`) and checked its own rules; no approval is involved.
 */
export interface DebitNoteInput {
  reasonCode: NoteReasonCode;
  remarks: string;
  lines: DocLineInput[];
  dedupeKey?: string | null;
  interestFromDate?: string | null;
  interestToDate?: string | null;
  lateFeePolicyId?: number | null;
  /** Skip the "cancellation pending" check (the job checks its own). */
  notify?: boolean;
}

export async function issueDebitNote(
  ctx: CallCtx,
  societyId: number,
  invoice: Invoice,
  input: DebitNoteInput,
  t: Transaction,
): Promise<BillingNote> {
  assertNoteable(invoice);
  const settings = await loadBillingSettings(societyId);
  const today = await societyToday(societyId);
  const ports = billingPorts();
  if (await ports.journal.isDateLocked(societyId, today))
    throw new UnprocessableError('PERIOD_LOCKED', 'The books are locked for the note date');
  const lines: DocLineInput[] = [];
  for (const l of input.lines)
    lines.push({
      ...l,
      fundId: await fundFor(societyId, l.head, { refType: invoice.refType, refId: invoice.refId }),
    });
  const doc = buildDocument(lines, {
    applyGst: settings.applyGst,
    exemptLimitPaise: settings.gstExemptLimitPaise,
    roundToRupee: settings.roundToRupee,
    mode: 'DEBIT',
    parentGstApplied: Boolean(invoice.gstApplied),
  });
  const userId = ctx.user?.id ?? null;
  const noteNo = await nextNumber(societyId, 'DEBIT_NOTE', { date: today, transaction: t });
  const note = await BillingNote.create(
    {
      societyId,
      noteType: 'DEBIT',
      noteNo,
      financialYear: financialYearOf(today),
      invoiceId: Number(invoice.id),
      unitId: Number(invoice.unitId),
      billToResidentId: Number(invoice.billToResidentId),
      billToName: invoice.billToName,
      reasonCode: input.reasonCode,
      status: 'ISSUED',
      approvalType: null,
      approvalRequestId: null,
      noteDate: today,
      subtotalPaise: doc.subtotalPaise,
      cgstPaise: doc.cgstPaise,
      sgstPaise: doc.sgstPaise,
      taxPaise: doc.cgstPaise + doc.sgstPaise,
      roundOffPaise: doc.roundOffPaise,
      totalPaise: doc.totalPaise,
      appliedToInvoicePaise: 0,
      excessToAdvancePaise: 0,
      interestFromDate: input.interestFromDate ?? null,
      interestToDate: input.interestToDate ?? null,
      lateFeePolicyId: input.lateFeePolicyId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      remarks: input.remarks.slice(0, 500),
      rejectedReason: null,
      issuedAt: now(),
      pdfFileId: null,
      pdfStatus: 'PENDING',
      createdBy: userId,
      updatedBy: userId,
      version: 1,
    },
    { transaction: t },
  );
  let lineNo = 0;
  for (const l of doc.lines)
    await InvoiceLine.create(
      {
        societyId,
        invoiceId: null,
        billingNoteId: Number(note.id),
        lineNo: ++lineNo,
        lineKind: l.lineKind,
        chargeHeadId: l.chargeHeadId,
        headKey: l.headKey,
        description: l.description,
        quantity: null,
        ratePaise: null,
        amountPaise: l.amountPaise,
        isTaxable: l.isTaxable,
        billingRuleVersionId: null,
        periodFrom: null,
        periodTo: null,
        prorationDays: null,
        periodDays: null,
        refInvoiceLineId: null,
        computation: null,
        ledgerAccountCode: l.ledgerAccountCode,
        creditedPaise: 0,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction: t },
    );
  invoice.debitedPaise = Number(invoice.debitedPaise) + doc.totalPaise;
  rebalance(invoice, today, userId);
  invoice.nonInterestBearingPaise = await recomputeNonInterestBearing(Number(invoice.id), t);
  await invoice.save({ transaction: t });
  await unitLedger.post(
    ctx,
    {
      unitId: Number(invoice.unitId),
      entryType: 'DEBIT_NOTE',
      refType: 'billing_note',
      refId: Number(note.id),
      debitPaise: doc.totalPaise,
      creditPaise: 0,
      date: today,
      narration: `Debit note ${noteNo} on ${invoice.invoiceNo}`,
    },
    t,
  );
  await ports.journal.post(
    ctx as never,
    {
      date: today,
      voucherType: 'DEBIT_NOTE',
      refType: 'billing_note',
      refId: Number(note.id),
      narration: `Debit note ${noteNo} on ${invoice.invoiceNo}`,
      lines: debitDocumentJournal(Number(invoice.unitId), doc.totalPaise, doc.lines),
    },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.debitNoteIssued,
      entityType: 'billing_note',
      entityId: Number(note.id),
      entityLabel: noteNo,
      societyId,
      after: { invoiceId: Number(invoice.id), totalPaise: doc.totalPaise, reasonCode: input.reasonCode },
    },
    t,
  );
  emitInvoiceChanged(t, { ...invoice.get(), societyId });
  enqueueRenderPdf(t, { kind: 'note', id: Number(note.id), societyId });
  if (input.notify !== false)
    notifyBillAfterCommit(
      t,
      'billing.debit_note_issued',
      {
        societyId,
        unitId: Number(invoice.unitId),
        residentId: Number(invoice.billToResidentId),
        relation: invoice.billToRelation,
        date: today,
      },
      { noteNo, invoiceNo: invoice.invoiceNo, amountPaise: doc.totalPaise },
    );
  return note;
}

/** Heads of an admin document: known, active, not a system head (404 / 422 as in 8.14 and 8.16). */
export async function loadUserHeads(
  societyId: number,
  ids: number[],
  t: Transaction,
): Promise<Map<number, ChargeHead>> {
  const out = new Map<number, ChargeHead>();
  for (const id of new Set(ids)) {
    const h = await ChargeHead.findOne({ where: { id, societyId }, transaction: t });
    if (!h) throw new NotFoundError('CHARGE_HEAD_NOT_FOUND', 'Charge head not found');
    if (h.isSystem)
      throw new UnprocessableError('CHARGE_HEAD_NOT_ALLOWED', 'A system charge head cannot be used here', [
        { field: 'chargeHeadId', message: `${h.key} is a system head` },
      ]);
    if (h.status !== 'ACTIVE')
      throw new UnprocessableError('CHARGE_HEAD_ARCHIVED', 'This charge head is archived', [
        { field: 'chargeHeadId', message: `${h.key} is archived` },
      ]);
    out.set(id, h);
  }
  return out;
}

/** Route 8.16. */
export async function createDebitNote(
  ctx: CallCtx,
  invoiceId: number,
  input: {
    reasonCode: NoteReasonCode;
    remarks: string;
    lines: { chargeHeadId: number; description: string; amountPaise: number }[];
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
    const heads = await loadUserHeads(
      societyId,
      input.lines.map(l => l.chargeHeadId),
      t,
    );
    const note = await issueDebitNote(
      ctx,
      societyId,
      invoice,
      {
        reasonCode: input.reasonCode,
        remarks: input.remarks,
        lines: input.lines.map(l => ({
          head: heads.get(l.chargeHeadId)!,
          description: l.description,
          amountPaise: l.amountPaise,
        })),
      },
      t,
    );
    return Number(note.id);
  });
  return loadNoteDto(societyId, noteId);
}
