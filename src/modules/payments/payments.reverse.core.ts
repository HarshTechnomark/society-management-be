import { Op, literal } from 'sequelize';
import { Invoice, Payment, PaymentAllocation, UnitLedgerEntry } from '../../models';
import { enqueueAfterCommit } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { invoices, unitLedger } from '../billing/billing.public';
import {
  AUDIT,
  EFFECTIVE_STATUSES,
  JOBS,
  PAYMENTS_QUEUE,
  RT,
  type AllocReason,
  type ReversalReasonCode,
} from './payments.constants';
import { advanceBalance, lockUnitRow, postAdvance } from './payments.advances';
import { mirrorRequestForInvoice, moveRequestPaid } from './payments.alloc.apply';
import { mirrorJournal, receiptCreditLines, receiptDebitAccount, releaseJournal } from './payments.journal';
import { paymentsPorts } from './payments.ports';
import { bumpReceiptRevision, cancelReceipt } from './payments.receipts.core';
import {
  auditPayment,
  emitFinance,
  invalidState,
  lockUnit,
  n,
  paymentToAudit,
  societyToday,
  unitLabelOf,
  withSociety,
} from './payments.shared';
import type { AnyCtx, ReverseOptions, Transaction } from './payments.types';

/**
 * Reverse-allocation core (5.6), the one routine behind reverse, bounce, return, refund freeing, reallocation and invoice
 * cancellation. It never deletes: every live allocation gets a negative row (`reversalOfId`), module 11
 * `reverseAllocation` reopens the invoice, a collection request loses `paidPaise`, and, when asked, the money is credited
 * back to the unit's advance (`ALLOCATION_RELEASED`) with its journal (Dr receivable or fund, Cr `MEMBER_ADVANCES`).
 */

export interface LiveSelector {
  societyId: number;
  unitId: number;
  paymentId?: number;
  invoiceId?: number;
  collectionRequestId?: number;
  source?: 'PAYMENT' | 'ADVANCE';
}

/** Allocation rows that still count (positive and not reversed), locked, oldest first. */
export async function liveAllocations(sel: LiveSelector, t: Transaction): Promise<PaymentAllocation[]> {
  const where: Record<string | symbol, unknown> = {
    societyId: sel.societyId,
    unitId: sel.unitId,
    amountPaise: { [Op.gt]: 0 },
  };
  if (sel.paymentId) where.paymentId = sel.paymentId;
  if (sel.invoiceId) where.invoiceId = sel.invoiceId;
  if (sel.collectionRequestId) where.collectionRequestId = sel.collectionRequestId;
  if (sel.source) where.source = sel.source;
  return PaymentAllocation.findAll({
    where: {
      ...where,
      [Op.and]: [
        literal(
          'NOT EXISTS (SELECT 1 FROM payment_allocations r WHERE r.reversalOfId = PaymentAllocation.id)',
        ),
      ],
    },
    order: [['id', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}

export interface ReverseResult {
  freedPaise: number;
  invoicePaise: number;
  collectionPaise: number;
  reversalIds: number[];
  /** Payments (source `PAYMENT` rows) that lost money. */
  paymentIds: number[];
}

/**
 * Reverses live allocations picked by `sel`. `opts.limitPaise` stops once at least that much is freed (whole rows only,
 * newest first when `newestFirst`). Payment parts follow: `toInvoices` and `toCollections` shrink; `toAdvance` grows by what
 * was released to advance (a payment stays consistent with CHECK `ck_payments_split`). The caller holds the unit lock.
 */
export async function reverseLiveAllocations(
  baseCtx: AnyCtx,
  sel: LiveSelector,
  opts: ReverseOptions,
  t: Transaction,
): Promise<ReverseResult> {
  const ctx = withSociety(baseCtx, sel.societyId);
  let rows = await liveAllocations(sel, t);
  if (opts.newestFirst) rows = rows.reverse();
  const today = await societyToday(sel.societyId);
  const label = await unitLabelOf(sel.societyId, sel.unitId, t);
  const res: ReverseResult = {
    freedPaise: 0,
    invoicePaise: 0,
    collectionPaise: 0,
    reversalIds: [],
    paymentIds: [],
  };
  const partsByPayment = new Map<number, { inv: number; col: number }>();
  const fundParts = new Map<number | null, number>();
  for (const a of rows) {
    if (opts.limitPaise !== undefined && res.freedPaise >= opts.limitPaise) break;
    const amount = n(a.amountPaise);
    if (a.targetType === 'INVOICE') {
      await invoices.reverseAllocation(ctx, n(a.invoiceId), amount, t);
      await mirrorRequestForInvoice(ctx, sel.societyId, n(a.invoiceId), -amount, t);
      res.invoicePaise += amount;
    } else {
      const r = await moveRequestPaid(ctx, n(a.collectionRequestId), sel.societyId, -amount, t);
      fundParts.set(r.fundId, (fundParts.get(r.fundId) ?? 0) + amount);
      res.collectionPaise += amount;
    }
    const rev = await PaymentAllocation.create(
      {
        societyId: sel.societyId,
        unitId: sel.unitId,
        source: a.source,
        paymentId: a.paymentId,
        unitAdvanceId: a.unitAdvanceId,
        targetType: a.targetType,
        invoiceId: a.invoiceId,
        collectionRequestId: a.collectionRequestId,
        amountPaise: -amount,
        reversalOfId: n(a.id),
        reasonCode: opts.reasonCode,
        allocatedOn: today,
        createdBy: ctx.user?.id ?? null,
        updatedBy: null,
      },
      { transaction: t },
    );
    res.reversalIds.push(n(rev.id));
    res.freedPaise += amount;
    if (a.source === 'PAYMENT' && a.paymentId) {
      const cur = partsByPayment.get(n(a.paymentId)) ?? { inv: 0, col: 0 };
      if (a.targetType === 'INVOICE') cur.inv += amount;
      else cur.col += amount;
      partsByPayment.set(n(a.paymentId), cur);
    }
    if (opts.releaseToAdvance)
      await postAdvance(
        ctx,
        sel.societyId,
        sel.unitId,
        {
          entryType: 'ALLOCATION_RELEASED',
          amountPaise: amount,
          paymentId: a.paymentId ? n(a.paymentId) : null,
          invoiceId: a.invoiceId ? n(a.invoiceId) : null,
          dedupeKey: `RELEASE:alloc:${a.id}`,
          narration: 'Allocation released to advance',
        },
        t,
      );
  }
  res.paymentIds = [...partsByPayment.keys()];
  // Payment parts follow only when the money stays with the unit (released to advance): the sum then still equals the amount
  // (CHECK `ck_payments_split`). A full reversal or bounce zeroes the parts itself in one update with the new status.
  for (const [paymentId, parts] of opts.releaseToAdvance ? partsByPayment : []) {
    const p = await Payment.findOne({ where: { id: paymentId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!p) continue;
    await p.update(
      {
        toInvoicesPaise: n(p.toInvoicesPaise) - parts.inv,
        toCollectionsPaise: n(p.toCollectionsPaise) - parts.col,
        toAdvancePaise: n(p.toAdvancePaise) + (opts.releaseToAdvance ? parts.inv + parts.col : 0),
        version: n(p.version) + 1,
      },
      { transaction: t },
    );
  }
  if (opts.releaseToAdvance && res.freedPaise > 0)
    await paymentsPorts().journal.post(
      ctx as never,
      releaseJournal({ unitId: sel.unitId, label }, res.reversalIds[0]!, today, res.invoicePaise, fundParts),
      t,
    );
  return res;
}

/** BR-12-53 (module 11 hook): release every live allocation of an invoice, both `PAYMENT` and `ADVANCE` sources. Idempotent. */
export async function onInvoiceCancelled(baseCtx: AnyCtx, invoiceId: number, t: Transaction): Promise<void> {
  const inv = await Invoice.findByPk(invoiceId, {
    attributes: ['id', 'societyId', 'unitId'],
    transaction: t,
  });
  if (!inv) return;
  const societyId = n(inv.societyId);
  const unitId = n(inv.unitId);
  await lockUnitRow(societyId, unitId, t);
  const res = await reverseLiveAllocations(
    baseCtx,
    { societyId, unitId, invoiceId },
    { reasonCode: 'INVOICE_CANCELLED', releaseToAdvance: true },
    t,
  );
  if (res.freedPaise > 0)
    await audit(
      withSociety(baseCtx, societyId),
      {
        action: AUDIT.paymentReallocated,
        entityType: 'invoice',
        entityId: invoiceId,
        societyId,
        after: { releasedPaise: res.freedPaise, reasonCode: 'INVOICE_CANCELLED' },
      },
      t,
    );
  // receipts of the payments that lost money change (revision + 1, PDF re-rendered)
  for (const paymentId of res.paymentIds) {
    const p = await Payment.findByPk(paymentId, { transaction: t });
    if (p && p.receiptStatus === 'ISSUED') await bumpReceiptRevision(p, t);
  }
}

export interface ReversePaymentOptions {
  newStatus: 'REVERSED' | 'BOUNCED' | 'RETURNED';
  /** `reversalReasonCode` of the payment (REVERSED only). */
  reversalReasonCode?: ReversalReasonCode;
  reason?: string | null;
  /** Extra columns for the payment row (bounce reason and date, ...). */
  patch?: Partial<Payment>;
  auditAction?: string;
}

/**
 * Takes an effective payment out (reverse, bounce, return): reverses all its allocations (no release), removes its advance
 * part (if the advance was spent, the newest advance applications of the unit are reversed first), cancels the receipt,
 * posts the unit ledger debit (`PAYMENT_REVERSAL`) and the mirror journal, audits, and emits `payment.reversed`.
 */
export async function reversePaymentCore(
  baseCtx: AnyCtx,
  paymentId: number,
  opts: ReversePaymentOptions,
  t: Transaction,
): Promise<Payment> {
  const pre = await Payment.findByPk(paymentId, { attributes: ['societyId', 'unitId'], transaction: t });
  if (!pre) throw invalidState('Payment not found');
  const societyId = n(pre.societyId);
  const unitId = n(pre.unitId);
  const ctx = withSociety(baseCtx, societyId);
  await lockUnit(societyId, unitId, t);
  const p = await Payment.findOne({
    where: { id: paymentId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!p || !EFFECTIVE_STATUSES.includes(p.status))
    throw invalidState('Only an effective payment can be reversed');
  const before = paymentToAudit(p);
  const label = await unitLabelOf(societyId, unitId, t);
  const today = await societyToday(societyId);
  const credits = await receiptCreditLines(p, t);
  const debitAccount = receiptDebitAccount(p);
  const advancePart = n(p.toAdvancePaise);
  const original = await UnitLedgerEntry.findOne({
    where: { societyId, refType: 'payment', refId: paymentId, entryType: 'PAYMENT' },
    transaction: t,
  });

  await reverseLiveAllocations(
    ctx,
    { societyId, unitId, paymentId, source: 'PAYMENT' },
    {
      reasonCode: opts.newStatus === 'REVERSED' ? 'REVERSED' : (opts.newStatus as AllocReason),
      releaseToAdvance: false,
    },
    t,
  );
  if (advancePart > 0) {
    const bal = await advanceBalance(societyId, unitId, t);
    if (bal < advancePart)
      await reverseLiveAllocations(
        ctx,
        { societyId, unitId, source: 'ADVANCE' },
        {
          reasonCode: opts.newStatus === 'REVERSED' ? 'REVERSED' : (opts.newStatus as AllocReason),
          releaseToAdvance: true,
          newestFirst: true,
          limitPaise: advancePart - bal,
        },
        t,
      );
    await postAdvance(
      ctx,
      societyId,
      unitId,
      {
        entryType: 'EXCESS_REVERSED',
        amountPaise: -advancePart,
        paymentId,
        dedupeKey: `EXCESS_REV:payment:${paymentId}`,
        narration: `Advance removed: payment ${p.receiptNo ?? `#${paymentId}`} ${opts.newStatus.toLowerCase()}`,
      },
      t,
    );
  }
  if (original && n(original.creditPaise) > 0)
    await unitLedger.post(
      ctx,
      {
        unitId,
        entryType: 'PAYMENT_REVERSAL',
        refType: 'payment',
        refId: paymentId,
        debitPaise: n(original.creditPaise),
        creditPaise: 0,
        date: today,
        narration: `Receipt ${p.receiptNo ?? ''} ${opts.newStatus.toLowerCase()}`.trim(),
      },
      t,
    );
  await paymentsPorts().journal.post(ctx as never, mirrorJournal(p, credits, label, debitAccount, today), t);
  const reversed = opts.newStatus === 'REVERSED';
  await p.update(
    {
      ...(opts.patch ?? {}),
      status: opts.newStatus,
      toInvoicesPaise: 0,
      toCollectionsPaise: 0,
      toAdvancePaise: 0,
      referenceKey: reversed ? p.referenceKey : null,
      ...(reversed
        ? {
            reversedAt: new Date(),
            reversedBy: ctx.user?.id ?? null,
            reversalReasonCode: opts.reversalReasonCode ?? 'OTHER',
            reversalReason: opts.reason ?? null,
          }
        : {}),
      updatedBy: ctx.user?.id ?? null,
      version: n(p.version) + 1,
    },
    { transaction: t },
  );
  await cancelReceipt(ctx, p, t);
  await auditPayment(
    ctx,
    opts.auditAction ??
      (opts.newStatus === 'REVERSED'
        ? AUDIT.paymentReversed
        : opts.newStatus === 'BOUNCED'
          ? AUDIT.chequeBounced
          : AUDIT.chequeReturned),
    p,
    before,
    t,
    opts.reason,
  );
  emitFinance(t, societyId, RT.paymentReversed, {
    paymentId,
    unitLabel: label,
    amountPaise: n(p.amountPaise),
    status: opts.newStatus,
  });
  // applied advances and request totals may have changed
  enqueueAfterCommit(t, PAYMENTS_QUEUE, JOBS.applyAdvances, { societyId, unitId });
  return p;
}

export type { ReverseOptions };
