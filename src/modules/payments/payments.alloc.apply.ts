import { CollectionRequest, Collection, PaymentAllocation, type Payment } from '../../models';
import { enqueueAfterCommit } from '../../lib/queue';
import { invoices } from '../billing/billing.public';
import { JOBS, PAYMENTS_QUEUE } from './payments.constants';
import { postAdvance } from './payments.advances';
import { n, societyToday } from './payments.shared';
import { requestOutstanding } from './payments.alloc.plan';
import type { AllocationPlan, AnyCtx, Transaction } from './payments.types';

/**
 * Writes a plan: invoice updates through module 11 `applyAllocation`, collection requests (`paidPaise`, status), one
 * `payment_allocations` row per line, and the advance row for the rest (`PAYMENT_EXCESS`). Called by the settle core with
 * the unit lock held; lock order inside: invoices (module 11), then requests, then collections (BR-12-19).
 */

/** Request status after a change of `paidPaise` (BR-12-18): `PAID` when `paid >= amount` (VOLUNTARY after the first payment). */
export function requestStatusFor(
  r: { amountPaise: number; paidPaise: number },
  mode: string,
): 'OPEN' | 'PART_PAID' | 'PAID' {
  if (r.paidPaise <= 0) return 'OPEN';
  if (mode === 'VOLUNTARY') return 'PAID';
  return r.paidPaise >= r.amountPaise ? 'PAID' : 'PART_PAID';
}

/** Moves `paidPaise` of a request by `delta` (negative on reversal) and refreshes status; queues the totals refresh. */
export async function moveRequestPaid(
  ctx: AnyCtx,
  requestId: number,
  societyId: number,
  delta: number,
  t: Transaction,
): Promise<{ fundId: number | null; collectionId: number }> {
  const r = await CollectionRequest.findOne({
    where: { id: requestId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!r) throw new Error(`collection request ${requestId} missing`);
  const c = await Collection.findOne({
    where: { id: r.collectionId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
    paranoid: false,
  });
  if (!c) throw new Error(`collection ${r.collectionId} missing`);
  const paid = n(r.paidPaise) + delta;
  if (paid < 0) throw new Error(`collection request ${requestId} would go below zero`);
  const keep = r.status === 'WAIVED' || r.status === 'CANCELLED' ? r.status : undefined;
  await r.update(
    {
      paidPaise: paid,
      status: keep ?? requestStatusFor({ amountPaise: n(r.amountPaise), paidPaise: paid }, c.amountMode),
      lastPaidAt: delta > 0 ? new Date() : r.lastPaidAt,
      updatedBy: ctx.user?.id ?? null,
      version: n(r.version) + 1,
    },
    { transaction: t },
  );
  enqueueAfterCommit(t, PAYMENTS_QUEUE, JOBS.refreshCollectionTotals, { collectionId: n(c.id) });
  return { fundId: c.fundId === null ? null : n(c.fundId), collectionId: n(c.id) };
}

/** A mandatory collection's invoice mirrors its request: payments on the invoice move the request's `paidPaise` too. */
export async function mirrorRequestForInvoice(
  ctx: AnyCtx,
  societyId: number,
  invoiceId: number,
  delta: number,
  t: Transaction,
): Promise<void> {
  const r = await CollectionRequest.findOne({
    where: { societyId, invoiceId },
    attributes: ['id'],
    transaction: t,
  });
  if (r) await moveRequestPaid(ctx, n(r.id), societyId, delta, t);
}

/** Applies the plan for an already inserted effective payment. */
export async function applyPlan(
  ctx: AnyCtx,
  payment: Payment,
  plan: AllocationPlan,
  t: Transaction,
): Promise<void> {
  const societyId = n(payment.societyId);
  const today = await societyToday(societyId);
  for (const line of plan.lines) {
    if (line.targetType === 'INVOICE') {
      await invoices.applyAllocation(ctx, line.id, line.amountPaise, t);
      await mirrorRequestForInvoice(ctx, societyId, line.id, line.amountPaise, t);
    } else {
      await moveRequestPaid(ctx, line.id, societyId, line.amountPaise, t);
    }
    await PaymentAllocation.create(
      {
        societyId,
        unitId: n(payment.unitId),
        source: 'PAYMENT',
        paymentId: n(payment.id),
        unitAdvanceId: null,
        targetType: line.targetType,
        invoiceId: line.targetType === 'INVOICE' ? line.id : null,
        collectionRequestId: line.targetType === 'COLLECTION_REQUEST' ? line.id : null,
        amountPaise: line.amountPaise,
        reversalOfId: null,
        reasonCode: 'ALLOCATED',
        allocatedOn: today,
        createdBy: ctx.user?.id ?? null,
        updatedBy: null,
      },
      { transaction: t },
    );
  }
  if (plan.advancePaise > 0)
    await postAdvance(
      ctx,
      societyId,
      n(payment.unitId),
      {
        entryType: 'PAYMENT_EXCESS',
        amountPaise: plan.advancePaise,
        paymentId: n(payment.id),
        dedupeKey: `EXCESS:payment:${payment.id}`,
        narration: `Advance from payment ${payment.receiptNo ?? `#${payment.id}`}`,
      },
      t,
    );
}

export { requestOutstanding };
