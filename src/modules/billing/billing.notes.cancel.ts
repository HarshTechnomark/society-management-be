import { Invoice, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { rateUnits, roundHalfUp } from '../../lib/money';
import { audit } from '../../utils/audit';
import { ConflictError, UnprocessableError, ValidationError } from '../../utils/errors';
import { APPROVAL_TYPES, AUDIT } from './billing.constants';
import {
  emitInvoiceChanged,
  notifyBillAfterCommit,
  queueAdvanceApplyAfterCommit,
} from './billing.invoices.effects';
import { invalidState, lockInvoice, lockUnitRow, societyIdOfInvoice } from './billing.invoices.shared';
import {
  CREDITABLE,
  abs,
  assertNoCancelPending,
  assertNoteable,
  creditTaxLines,
  insertCreditNote,
  issueCreditNote,
  lockInvoiceLines,
  openOf,
  pendingNoteCount,
  reserveOnLines,
  type CreditDraftLine,
} from './billing.notes.credit';
import { loadNoteDto, type CallCtx, type NoteDto } from './billing.notes.shared';
import { billingPorts } from './billing.ports';
import { societyToday } from './billing.runs.shared';
import type { Transaction } from './billing.types';

/**
 * Cancellation, write-off and the by-source functions for other modules (BR-11-44, BR-11-45, BR-11-50a, BR-11-50b; 8.17).
 * A cancellation credits every open line (tax and round-off included) with a `CANCELLATION` credit note and closes the invoice.
 */

/** Credit note lines for every open line of the invoice and its debit notes, capped at what the invoice still owes. */
async function fullCreditLines(
  societyId: number,
  invoice: Invoice,
  t: Transaction,
): Promise<{ lines: CreditDraftLine[]; reservations: Map<number, number> }> {
  const all = await lockInvoiceLines(societyId, invoice, t);
  const lines: CreditDraftLine[] = all.lines
    .filter(l => openOf(l) !== 0)
    .map(l => ({
      lineKind: l.lineKind,
      chargeHeadId: l.chargeHeadId,
      headKey: l.headKey,
      description: `Credit: ${l.description}`.slice(0, 300),
      amountPaise: openOf(l),
      isTaxable: false,
      ledgerAccountCode: l.ledgerAccountCode,
      refInvoiceLineId: Number(l.id),
    }));
  // after a write-off the lines hold more than is owed: take the difference off the last charge lines
  const owed = Number(invoice.totalPaise) + Number(invoice.debitedPaise) - Number(invoice.creditedPaise);
  let diff = lines.reduce((a, l) => a + l.amountPaise, 0) - owed;
  for (let i = lines.length - 1; i >= 0 && diff > 0; i--) {
    const l = lines[i]!;
    if (!CREDITABLE.includes(l.lineKind)) continue;
    const cut = Math.min(diff, l.amountPaise);
    l.amountPaise -= cut;
    diff -= cut;
  }
  const kept = lines.filter(l => l.amountPaise !== 0);
  const reservations = new Map<number, number>();
  for (const l of kept) reservations.set(l.refInvoiceLineId!, abs(l.amountPaise));
  return { lines: kept, reservations };
}

/**
 * Issues the `CANCELLATION` credit note directly and closes the invoice (`CANCELLED`, `cancelledAt`, outstanding 0). When
 * the invoice was paid, module 12 releases the allocations first (inside the credit note issue), and the advance is re-applied
 * after commit. Caller locked the unit and the invoice.
 */
export async function cancelInvoiceNow(
  ctx: CallCtx,
  societyId: number,
  invoice: Invoice,
  reason: string,
  approvalType: 'INVOICE_CANCEL' | null,
  t: Transaction,
  bySource = false,
): Promise<{ noteId: number | null; noteNo: string | null }> {
  const hadPaid = Number(invoice.paidPaise) > 0;
  const built = await fullCreditLines(societyId, invoice, t);
  let noteId: number | null = null;
  let noteNo: string | null = null;
  if (built.lines.length) {
    const note = await insertCreditNote(
      ctx,
      invoice,
      { reasonCode: 'CANCELLATION', remarks: reason, approvalType, lines: built.lines },
      t,
    );
    await reserveOnLines(built.reservations, 1, ctx.user?.id ?? null, t);
    await issueCreditNote(ctx, societyId, invoice, note, t, { notify: false });
    noteId = Number(note.id);
    noteNo = note.noteNo;
  } else if (hadPaid) {
    await billingPorts().payments.onInvoiceCancelled(ctx as never, Number(invoice.id), t);
    await invoice.reload({ transaction: t });
  }
  const today = await societyToday(societyId);
  invoice.status = 'CANCELLED';
  invoice.outstandingPaise = 0;
  invoice.cancelledAt = now();
  invoice.settledOn = invoice.settledOn ?? today;
  invoice.updatedBy = ctx.user?.id ?? null;
  invoice.version = Number(invoice.version) + 1;
  await invoice.save({ transaction: t });
  await audit(
    ctx,
    {
      action: bySource ? AUDIT.invoiceCancelledBySource : AUDIT.invoiceCancelled,
      entityType: 'invoice',
      entityId: Number(invoice.id),
      entityLabel: invoice.invoiceNo,
      societyId,
      reason,
      after: { noteNo },
    },
    t,
  );
  emitInvoiceChanged(t, { ...invoice.get(), societyId });
  if (hadPaid) queueAdvanceApplyAfterCommit(t, societyId, [Number(invoice.unitId)]);
  notifyBillAfterCommit(
    t,
    'billing.invoice_cancelled',
    {
      societyId,
      unitId: Number(invoice.unitId),
      residentId: Number(invoice.billToResidentId),
      relation: invoice.billToRelation,
      date: today,
    },
    { invoiceNo: invoice.invoiceNo },
  );
  return { noteId, noteNo };
}

async function lockForNote(societyId: number, invoiceId: number, t: Transaction): Promise<Invoice> {
  const peek = await Invoice.findOne({
    where: { id: invoiceId, societyId },
    attributes: ['unitId'],
    transaction: t,
  });
  if (peek) await lockUnitRow(societyId, Number(peek.unitId), t);
  return lockInvoice(societyId, invoiceId, t);
}

// ------------------------------------------------------------------ cancel (8.17, invoices.requestCancel)

export async function requestCancelIn(
  ctx: CallCtx,
  societyId: number,
  invoiceId: number,
  reason: string,
  t: Transaction,
): Promise<{ approvalRequestId: number; status: string }> {
  const ports = billingPorts();
  const open = await ports.approvals.lockOpenForEntity(societyId, 'invoice', invoiceId, t);
  if (open && open.type === APPROVAL_TYPES.invoiceCancel)
    throw new ConflictError(
      'APPROVAL_ALREADY_PENDING',
      'A cancellation request is already open for this invoice',
    );
  const invoice = await lockForNote(societyId, invoiceId, t);
  if (invoice.status === 'CANCELLED') throw invalidState('This invoice is already cancelled');
  if (await pendingNoteCount(societyId, invoiceId, t))
    throw new ConflictError('CREDIT_NOTE_PENDING', 'A credit note is waiting for approval on this invoice');
  const req = await ports.approvals.request(
    ctx as never,
    {
      type: APPROVAL_TYPES.invoiceCancel,
      entityType: 'invoice',
      entityId: invoiceId,
      title: `Cancel ${invoice.invoiceNo}`,
      amountPaise: Number(invoice.outstandingPaise) + Number(invoice.paidPaise),
      summary: reason,
      payload: { reason, totalPaise: Number(invoice.totalPaise), paidPaise: Number(invoice.paidPaise) },
    },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.invoiceCancelRequested,
      entityType: 'invoice',
      entityId: invoiceId,
      entityLabel: invoice.invoiceNo,
      societyId,
      reason,
    },
    t,
  );
  if (req.status === 'APPROVED') await cancelInvoiceNow(ctx, societyId, invoice, reason, 'INVOICE_CANCEL', t);
  return { approvalRequestId: req.id, status: req.status };
}

export async function requestCancel(
  ctx: CallCtx,
  invoiceId: number,
  reason: string,
  t: Transaction,
): Promise<{ approvalRequestId: number; status: string }> {
  return requestCancelIn(ctx, await societyIdOfInvoice(ctx, invoiceId), invoiceId, reason, t);
}

/** Route 8.17: own transaction; the result tells the controller whether to answer 202 or 200. */
export async function cancelInvoiceRoute(ctx: CallCtx, invoiceId: number, reason: string) {
  const societyId = await societyIdOfInvoice(ctx, invoiceId);
  return sequelize.transaction(t => requestCancelIn(ctx, societyId, invoiceId, reason, t));
}

/** `onApproved` of `INVOICE_CANCEL` (entity `invoice`). */
export async function onCancelApproved(ctx: CallCtx, invoiceId: number, t: Transaction): Promise<void> {
  const societyId = await societyIdOfInvoice(ctx, invoiceId);
  const invoice = await lockForNote(societyId, invoiceId, t);
  if (invoice.status === 'CANCELLED') return;
  if (await pendingNoteCount(societyId, invoiceId, t))
    throw new ConflictError('CREDIT_NOTE_PENDING', 'A credit note is waiting for approval on this invoice');
  await cancelInvoiceNow(ctx, societyId, invoice, 'Cancelled after approval', 'INVOICE_CANCEL', t);
}

// ------------------------------------------------------------------ write-off (8.17)

export async function requestWriteOff(
  ctx: CallCtx,
  invoiceId: number,
  input: { amountPaise: number; reason: string },
): Promise<NoteDto> {
  const societyId = await societyIdOfInvoice(ctx, invoiceId);
  const noteId = await sequelize.transaction(async t => {
    await assertNoCancelPending(societyId, invoiceId, t);
    const invoice = await lockForNote(societyId, invoiceId, t);
    if (invoice.status === 'CANCELLED' || invoice.status === 'PAID')
      throw invalidState('Nothing is owed on this invoice that can be written off');
    if (input.amountPaise > Number(invoice.outstandingPaise))
      throw new UnprocessableError(
        'WRITE_OFF_EXCEEDS_OUTSTANDING',
        'The write-off is more than the invoice still owes',
        [
          {
            field: 'amountPaise',
            message: 'More than the outstanding amount',
            maxAllowedPaise: Number(invoice.outstandingPaise),
          },
        ],
      );
    const note = await insertCreditNote(
      ctx,
      invoice,
      {
        reasonCode: 'WRITE_OFF',
        remarks: input.reason,
        approvalType: 'WRITE_OFF',
        lines: [
          {
            lineKind: 'WRITE_OFF',
            chargeHeadId: null,
            headKey: null,
            description: `Write-off: ${input.reason}`.slice(0, 300),
            amountPaise: input.amountPaise,
            isTaxable: false,
            ledgerAccountCode: '5900',
            refInvoiceLineId: null,
          },
        ],
      },
      t,
    );
    const req = await billingPorts().approvals.request(
      ctx as never,
      {
        type: APPROVAL_TYPES.writeOff,
        entityType: 'billing_note',
        entityId: Number(note.id),
        title: `Write off ${invoice.invoiceNo}`,
        amountPaise: input.amountPaise,
        summary: input.reason,
        payload: { invoiceId, outstandingPaise: Number(invoice.outstandingPaise) },
      },
      t,
    );
    note.approvalRequestId = req.id;
    await note.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.writeOffRequested,
        entityType: 'billing_note',
        entityId: Number(note.id),
        societyId,
        reason: input.reason,
        after: { invoiceId, amountPaise: input.amountPaise },
      },
      t,
    );
    if (req.status === 'APPROVED') await issueCreditNote(ctx, societyId, invoice, note, t);
    return Number(note.id);
  });
  return loadNoteDto(societyId, noteId);
}

// ------------------------------------------------------------------ by source (modules 09, 13, 18)

const REF_TYPE = /^[a-z_]{2,40}$/;
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;

async function sourceInvoice(
  ctx: CallCtx,
  invoiceId: number,
  input: { refType: string; refId: number; reason: string },
  t: Transaction,
): Promise<{ societyId: number; invoice: Invoice }> {
  const errors = [];
  if (typeof input.refType !== 'string' || !REF_TYPE.test(input.refType))
    errors.push({ field: 'refType', message: 'Use lower-case letters and underscores, 2 to 40 characters' });
  if (!Number.isSafeInteger(input.refId) || input.refId < 1)
    errors.push({ field: 'refId', message: 'Must be a positive whole number' });
  if (typeof input.reason !== 'string' || input.reason.trim().length < 5 || input.reason.length > 500)
    errors.push({ field: 'reason', message: 'Must be 5 to 500 characters' });
  if (errors.length) throw new ValidationError(errors);
  const societyId = await societyIdOfInvoice(ctx, invoiceId);
  const invoice = await lockForNote(societyId, invoiceId, t);
  if (
    invoice.invoiceType !== 'ADHOC' ||
    invoice.refType !== input.refType ||
    Number(invoice.refId) !== input.refId
  )
    throw new UnprocessableError('INVOICE_SOURCE_MISMATCH', 'This invoice was not raised for that source');
  if (invoice.status === 'CANCELLED') throw invalidState('This invoice is cancelled');
  await assertNoCancelPending(societyId, invoiceId, t);
  return { societyId, invoice };
}

/** BR-11-50a: a system credit note for a percentage of the charge line (module 18 refunds), no approval. */
export async function creditBySource(
  ctx: CallCtx,
  invoiceId: number,
  input: { refType: string; refId: number; percent: string; reason: string },
  t: Transaction,
): Promise<{ noteId: number; noteNo: string; totalPaise: number }> {
  if (typeof input.percent !== 'string' || !PERCENT.test(input.percent))
    throw new ValidationError([{ field: 'percent', message: 'Use a percentage such as 50.0000' }]);
  const units = rateUnits(input.percent);
  if (units < 1n || units > 1_000_000n)
    throw new ValidationError([{ field: 'percent', message: 'Between 0.0001 and 100.0000' }]);
  const { societyId, invoice } = await sourceInvoice(ctx, invoiceId, input, t);
  const all = await lockInvoiceLines(societyId, invoice, t);
  const charge = all.lines.find(l => l.invoiceId !== null && l.lineKind === 'CHARGE');
  if (!charge) throw invalidState('This invoice has no charge line');
  let lines: CreditDraftLine[];
  let reservations: Map<number, number>;
  if (units === 1_000_000n) {
    ({ lines, reservations } = await fullCreditLines(societyId, invoice, t));
    if (!lines.length)
      throw new UnprocessableError('CREDIT_EXCEEDS_LINE', 'Nothing is left to credit on this invoice');
  } else {
    const amount = roundHalfUp(BigInt(charge.amountPaise) * units, 1_000_000n);
    const max = Number(charge.amountPaise) - Number(charge.creditedPaise);
    if (amount < 1 || amount > max)
      throw new UnprocessableError(
        'CREDIT_EXCEEDS_LINE',
        'The credit is more than the line can still be credited',
        [{ field: 'percent', message: 'More than the line can still be credited', maxAllowedPaise: max }],
      );
    lines = [
      {
        lineKind: 'CHARGE',
        chargeHeadId: charge.chargeHeadId,
        headKey: charge.headKey,
        description: `Credit: ${charge.description}`.slice(0, 300),
        amountPaise: amount,
        isTaxable: charge.isTaxable,
        ledgerAccountCode: charge.ledgerAccountCode,
        refInvoiceLineId: Number(charge.id),
      },
    ];
    for (const tx of await creditTaxLines(all, new Map([[Number(charge.id), amount]]))) {
      const src = all.lines.find(l => Number(l.id) === tx.lineId)!;
      lines.push({
        lineKind: tx.kind,
        chargeHeadId: null,
        headKey: null,
        description: `Credit: ${src.description}`.slice(0, 300),
        amountPaise: tx.amountPaise,
        isTaxable: false,
        ledgerAccountCode: src.ledgerAccountCode,
        refInvoiceLineId: tx.lineId,
      });
    }
    reservations = new Map();
    for (const l of lines)
      reservations.set(l.refInvoiceLineId!, (reservations.get(l.refInvoiceLineId!) ?? 0) + l.amountPaise);
  }
  const note = await insertCreditNote(
    ctx,
    invoice,
    { reasonCode: 'SOURCE_REFUND', remarks: input.reason, approvalType: null, lines },
    t,
  );
  await reserveOnLines(reservations, 1, ctx.user?.id ?? null, t);
  await issueCreditNote(ctx, societyId, invoice, note, t, { auditAction: AUDIT.creditNoteIssuedBySource });
  return { noteId: Number(note.id), noteNo: note.noteNo!, totalPaise: Number(note.totalPaise) };
}

/** BR-11-50b: cancels an unpaid hold invoice without approval. */
export async function cancelBySource(
  ctx: CallCtx,
  invoiceId: number,
  input: { refType: string; refId: number; reason: string },
  t: Transaction,
): Promise<{ noteId: number; noteNo: string }> {
  const { societyId, invoice } = await sourceInvoice(ctx, invoiceId, input, t);
  const allocations = await billingPorts().payments.listAllocationsForInvoice(societyId, invoiceId);
  if (Number(invoice.paidPaise) > 0 || allocations.length)
    throw new UnprocessableError('INVOICE_HAS_ALLOCATIONS', 'A payment was allocated to this invoice');
  if (await pendingNoteCount(societyId, invoiceId, t))
    throw new ConflictError('CREDIT_NOTE_PENDING', 'A credit note is waiting for approval on this invoice');
  if (invoice.status !== 'ISSUED')
    throw invalidState('Only an unpaid issued invoice can be cancelled this way');
  assertNoteable(invoice);
  const r = await cancelInvoiceNow(ctx, societyId, invoice, input.reason, null, t, true);
  if (!r.noteId || !r.noteNo) throw invalidState('Nothing is open on this invoice');
  return { noteId: r.noteId, noteNo: r.noteNo };
}
