import { UniqueConstraintError } from 'sequelize';
import { paymentGateway } from '../../adapters';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { enqueueAfterCommit } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { AutopayMandate, Payment, PaymentOrder } from '../../models';
import { UnprocessableError } from '../../utils/errors';
import { systemCtx } from '../../types/context';
import { unitLedger } from '../billing/billing.public';
import { AUDIT, ERR, JOBS, NOTIFY, PAYMENTS_QUEUE, RT, type PaymentMethod } from './payments.constants';
import { applyPlan } from './payments.alloc.apply';
import { buildPlan, loadOpenTargets } from './payments.alloc.plan';
import { firstPaymentOfOrder } from './payments.duplicates';
import { captureJournal } from './payments.journal';
import { paymentsPorts } from './payments.ports';
import { issueReceipt } from './payments.receipts.core';
import {
  auditPayment,
  emitFinance,
  invalidState,
  lockUnit,
  moneyTx,
  n,
  societyToday,
  unitLabelOf,
  userName,
  withSociety,
} from './payments.shared';
import type { AllocationPlan, AnyCtx, OrderItem, SettleInput, Transaction } from './payments.types';

/**
 * The settle core. `settleInput` creates an effective payment (offline approval of a new entry, online capture);
 * `effectivatePending` turns an existing `PENDING_APPROVAL` payment effective; `settleCapture` is the 6.8 online entry
 * point. All run inside the caller's transaction: payment row, allocations, invoice updates through module 11, advance row,
 * receipt number, unit ledger credit, journal and audit commit together; notifications, the receipt PDF, advance
 * application and realtime go after commit.
 */

interface PlanSpec {
  mode: SettleInput['mode'];
  selected?: SettleInput['selected'];
  duesPaise?: number;
  advanceOnly?: boolean;
  visibilityUserId?: number;
}

async function planFor(
  societyId: number,
  unitId: number,
  amountPaise: number,
  spec: PlanSpec,
  t: Transaction,
): Promise<AllocationPlan> {
  const requestIds = (spec.selected ?? []).filter(s => s.targetType === 'COLLECTION_REQUEST').map(s => s.id);
  const open = spec.advanceOnly
    ? []
    : await loadOpenTargets(societyId, unitId, t, { visibilityUserId: spec.visibilityUserId, requestIds });
  return buildPlan(open, {
    mode: spec.mode,
    amountPaise,
    duesPaise: spec.duesPaise,
    selected: spec.selected,
    advanceOnly: spec.advanceOnly,
  });
}

const partsOf = (plan: AllocationPlan) => ({
  toInvoicesPaise: plan.lines.filter(l => l.targetType === 'INVOICE').reduce((a, l) => a + l.amountPaise, 0),
  toCollectionsPaise: plan.lines
    .filter(l => l.targetType === 'COLLECTION_REQUEST')
    .reduce((a, l) => a + l.amountPaise, 0),
  toAdvancePaise: plan.advancePaise,
});

/** Everything after the payment row is effective: allocation, receipt, ledger, journal, audit, after-commit effects. */
async function completeSettlement(
  ctx: AnyCtx,
  p: Payment,
  plan: AllocationPlan,
  auditAction: string,
  t: Transaction,
): Promise<void> {
  const societyId = n(p.societyId);
  const unitId = n(p.unitId);
  await applyPlan(ctx, p, plan, t);
  await issueReceipt(ctx, p, t);
  const label = await unitLabelOf(societyId, unitId, t);
  const credit = n(p.toInvoicesPaise) + n(p.toAdvancePaise); // BR-12-21: requests are not a due
  if (credit > 0)
    await unitLedger.post(
      ctx,
      {
        unitId,
        entryType: 'PAYMENT',
        refType: 'payment',
        refId: n(p.id),
        debitPaise: 0,
        creditPaise: credit,
        date: p.paymentDate,
        narration: `Receipt ${p.receiptNo}`,
      },
      t,
    );
  await paymentsPorts().journal.post(ctx as never, await captureJournal(p, label, t), t);
  await auditPayment(ctx, auditAction, p, null, t);
  const what = plan.lines.length
    ? plan.lines.length === 1
      ? plan.lines[0]!.label
      : `${plan.lines[0]!.label} +${plan.lines.length - 1}`
    : 'Advance';
  emitFinance(t, societyId, RT.paymentReceived, {
    paymentId: n(p.id),
    unitLabel: label,
    amountPaise: n(p.amountPaise),
    method: p.method,
    what,
    receiptNo: p.receiptNo,
    at: new Date().toISOString(),
  });
  enqueueAfterCommit(t, PAYMENTS_QUEUE, JOBS.applyAdvances, { societyId, unitId });
  if (p.payerUserId)
    t.afterCommit(async () => {
      try {
        await paymentsPorts().notifications.send(NOTIFY.receiptIssued, [n(p.payerUserId)], {
          societyId,
          paymentId: n(p.id),
          receiptNo: p.receiptNo,
          amountPaise: n(p.amountPaise),
        });
      } catch (err) {
        logger.error({ err }, 'receipt notification failed');
      }
    });
}

/**
 * Creates an effective payment and settles it. Idempotent: an existing payment with the same `gatewayPaymentId` or
 * `referenceKey` is returned unchanged (`created: false`). Takes the unit lock itself (BR-12-19 step 3).
 */
export async function settleInput(
  baseCtx: AnyCtx,
  input: SettleInput,
  t: Transaction,
): Promise<{ payment: Payment; created: boolean; plan: AllocationPlan | null }> {
  const ctx = withSociety(baseCtx, input.societyId);
  await lockUnit(input.societyId, input.unitId, t); // first: later reads see everything committed before the lock
  if (input.gatewayPaymentId) {
    const ex = await Payment.findOne({ where: { gatewayPaymentId: input.gatewayPaymentId }, transaction: t });
    if (ex) return { payment: ex, created: false, plan: null };
  }
  if (input.referenceKey) {
    const ex = await Payment.findOne({
      where: { societyId: input.societyId, referenceKey: input.referenceKey },
      transaction: t,
    });
    if (ex) return { payment: ex, created: false, plan: null };
  }
  const plan = await planFor(input.societyId, input.unitId, input.amountPaise, input, t);
  const fee = input.convenienceFeePaise ?? 0;
  const feeGst = input.convenienceFeeGstPaise ?? 0;
  const p = await Payment.create(
    {
      societyId: input.societyId,
      unitId: input.unitId,
      paymentOrderId: input.paymentOrderId ?? null,
      source: input.source,
      method: input.method,
      status: input.status,
      payerUserId: input.payerUserId,
      payerName: input.payerName.slice(0, 120),
      amountPaise: input.amountPaise,
      convenienceFeePaise: fee,
      convenienceFeeGstPaise: feeGst,
      grossAmountPaise: input.amountPaise + fee + feeGst,
      ...partsOf(plan),
      refundedPaise: 0,
      paymentDate: input.paymentDate,
      capturedAt: new Date(),
      gatewayAccountId: input.gatewayAccountId ?? null,
      gatewayPaymentId: input.gatewayPaymentId ?? null,
      gatewayMethodDetail: input.gatewayMethodDetail ?? null,
      referenceNo: input.referenceNo ?? null,
      referenceKey: input.referenceKey ?? null,
      chequeBankName: input.chequeBankName ?? null,
      chequeDate: input.chequeDate ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      approvedBy: input.approvedBy ?? null,
      approvedAt: input.approvedBy ? new Date() : null,
      notes: input.notes ?? null,
      needsReview: input.needsReview ?? false,
      reviewReason: (input.reviewReason as never) ?? null,
      isDuplicateSuspect: input.isDuplicateSuspect ?? false,
      duplicateOfPaymentId: input.duplicateOfPaymentId ?? null,
      createdBy: input.createdBy ?? ctx.user?.id ?? null,
      updatedBy: null,
    },
    { transaction: t },
  );
  await completeSettlement(
    ctx,
    p,
    plan,
    input.source === 'ONLINE' || input.source === 'AUTOPAY' ? AUDIT.paymentCaptured : AUDIT.paymentRecorded,
    t,
  );
  return { payment: p, created: true, plan };
}

/**
 * Offline approval (12.2): turns a locked `PENDING_APPROVAL` payment effective. `spec` carries the allocation intent kept in the
 * approval payload. Takes the unit lock.
 */
export async function effectivatePending(
  baseCtx: AnyCtx,
  paymentId: number,
  spec: PlanSpec & { status: 'CONFIRMED' | 'RECEIVED'; approvedBy?: number | null },
  t: Transaction,
): Promise<{ payment: Payment; plan: AllocationPlan }> {
  const pre = await Payment.findByPk(paymentId, { attributes: ['societyId', 'unitId'], transaction: t });
  if (!pre) throw invalidState('Payment not found');
  const societyId = n(pre.societyId);
  const ctx = withSociety(baseCtx, societyId);
  await lockUnit(societyId, n(pre.unitId), t);
  const p = await Payment.findOne({
    where: { id: paymentId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!p || p.status !== 'PENDING_APPROVAL') throw invalidState('This payment is not waiting for approval');
  const plan = await planFor(societyId, n(p.unitId), n(p.amountPaise), spec, t);
  await p.update(
    {
      status: spec.status,
      ...partsOf(plan),
      capturedAt: new Date(),
      approvedBy: spec.approvedBy ?? ctx.user?.id ?? null,
      approvedAt: new Date(),
      version: n(p.version) + 1,
    },
    { transaction: t },
  );
  await completeSettlement(ctx, p, plan, AUDIT.paymentApproved, t);
  return { payment: p, plan };
}

// ------------------------------------------------------------------ 6.8 online capture
export interface GatewayPaymentInfo {
  id: string;
  status: 'captured' | 'failed' | 'pending';
  amountPaise: number;
  method: string;
  orderId: string;
}

export type SettleOutcome =
  | { outcome: 'SETTLED'; paymentId: number; needsReview: boolean; duplicate: boolean }
  | { outcome: 'ALREADY_SETTLED'; paymentId: number }
  | { outcome: 'ATTEMPT_RECORDED'; paymentId: number | null }
  | { outcome: 'PENDING' }
  | { outcome: 'UNKNOWN_ORDER' };

const METHOD_MAP: Record<string, PaymentMethod> = {
  upi: 'UPI',
  card: 'CARD',
  netbanking: 'NETBANKING',
  wallet: 'WALLET',
};

/** Order hooks of module callers (8.26 `registerOrderHook`); `onPaid` runs inside the capture transaction. */
export interface OrderHook {
  onPaid(ctx: AnyCtx, order: PaymentOrder, payment: Payment, t: Transaction): Promise<void>;
  onExpired?(ctx: AnyCtx, order: PaymentOrder, t: Transaction): Promise<void>;
}
const orderHooks = new Map<string, OrderHook>();
export const registerOrderHook = (refType: string, hook: OrderHook): void => {
  orderHooks.set(refType, hook);
};
export const orderHookFor = (refType: string | null): OrderHook | undefined =>
  refType ? orderHooks.get(refType) : undefined;
export const clearOrderHooks = (): void => orderHooks.clear();

function orderSpec(order: PaymentOrder): PlanSpec {
  const items = (order.items ?? []) as OrderItem[];
  if (order.allocationMode === 'OLDEST_FIRST') {
    const dues = items.find(i => i.itemType === 'OLDEST_FIRST_DUES');
    return { mode: 'OLDEST_FIRST', duesPaise: dues ? dues.amountPaise : 0 };
  }
  return {
    mode: 'SELECTED',
    selected: items
      .filter(i => (i.itemType === 'INVOICE' || i.itemType === 'COLLECTION_REQUEST') && i.itemId)
      .map(i => ({
        targetType: i.itemType as 'INVOICE' | 'COLLECTION_REQUEST',
        id: i.itemId!,
        amountPaise: i.amountPaise,
      })),
  };
}

/** Records a failed or declined attempt: order `ATTEMPTED`, one `FAILED` payment row (money never moved), audit, notification. */
async function markAttempt(
  ctx: AnyCtx,
  order: PaymentOrder,
  gp: GatewayPaymentInfo,
  t: Transaction,
): Promise<number | null> {
  const existing = await Payment.findOne({ where: { gatewayPaymentId: gp.id }, transaction: t });
  if (existing) return n(existing.id);
  if (order.status === 'CREATED' || order.status === 'ATTEMPTED')
    await order.update(
      {
        status: 'ATTEMPTED',
        attemptCount: n(order.attemptCount) + 1,
        failureReason: 'Payment attempt failed',
        version: n(order.version) + 1,
      },
      { transaction: t },
    );
  const label = await unitLabelOf(n(order.societyId), n(order.unitId), t);
  const p = await Payment.create(
    {
      societyId: n(order.societyId),
      unitId: n(order.unitId),
      paymentOrderId: n(order.id),
      source: order.sourceType === 'AUTOPAY' ? 'AUTOPAY' : 'ONLINE',
      method: METHOD_MAP[gp.method] ?? order.methodHint ?? 'UPI',
      status: 'FAILED',
      payerUserId: order.payerUserId,
      payerName: (await userName(order.payerUserId)) ?? `Unit ${label}`,
      amountPaise: Math.max(gp.amountPaise, 1),
      grossAmountPaise: Math.max(gp.amountPaise, 1),
      paymentDate: await societyToday(n(order.societyId)), // the society's date, not UTC
      gatewayAccountId: n(order.gatewayAccountId),
      gatewayPaymentId: gp.id,
      failureReason: 'Payment attempt failed',
      createdBy: null,
      updatedBy: null,
    },
    { transaction: t },
  );
  await auditPayment(ctx, AUDIT.paymentFailed, p, null, t);
  const orderId = n(order.id);
  const unitId = n(order.unitId);
  t.afterCommit(async () => {
    if (order.payerUserId) {
      emitToUser(n(order.payerUserId), RT.paymentStatus, {
        orderId,
        status: 'ATTEMPTED',
        paymentId: null,
        receiptNo: null,
      });
      await paymentsPorts()
        .notifications.send(NOTIFY.paymentFailed, [n(order.payerUserId)], {
          societyId: n(order.societyId),
          orderId,
        })
        .catch(err => logger.error({ err }, 'payment_failed notification failed'));
    }
    emitToRoom(`unit:${unitId}`, RT.paymentStatus, { orderId, status: 'ATTEMPTED', receiptNo: null });
  });
  return n(p.id);
}

/**
 * Section 6.8, inside the caller's transaction (the gateway read `gp` happened before). Idempotent by `gatewayPaymentId`.
 * Rules: unknown order → `UNKNOWN_ORDER` (the caller flags the event); amount mismatch or cancelled order (BR-12-13) → recorded
 * with everything to advance and `needsReview`; second capture on a `PAID` order (BR-12-14) → everything to advance and
 * `isDuplicateSuspect`. Order lock first, then unit lock (BR-12-19).
 */
export async function settleCapture(
  gatewayAccountId: number,
  gp: GatewayPaymentInfo,
  t: Transaction,
  baseCtx: AnyCtx = systemCtx('settle'),
): Promise<SettleOutcome> {
  const existing = await Payment.findOne({ where: { gatewayPaymentId: gp.id }, transaction: t });
  if (existing) return { outcome: 'ALREADY_SETTLED', paymentId: n(existing.id) };
  if (gp.status === 'pending') return { outcome: 'PENDING' };
  const order = await PaymentOrder.findOne({
    where: { gatewayAccountId, gatewayOrderId: gp.orderId },
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
  if (!order) return { outcome: 'UNKNOWN_ORDER' };
  const societyId = n(order.societyId);
  const ctx = withSociety(baseCtx, societyId);
  if (gp.status === 'failed')
    return { outcome: 'ATTEMPT_RECORDED', paymentId: await markAttempt(ctx, order, gp, t) };

  await lockUnit(societyId, n(order.unitId), t);
  const mismatch = gp.amountPaise !== n(order.grossAmountPaise);
  const cancelled = order.status === 'CANCELLED';
  const reviewOnly = mismatch || cancelled;
  const duplicate = !reviewOnly && order.status === 'PAID';
  const advanceOnly = reviewOnly || duplicate;
  const duplicateOf = duplicate ? await firstPaymentOfOrder(n(order.id), t) : null;
  const label = await unitLabelOf(societyId, n(order.unitId), t);
  const mandate =
    order.mandateId !== null ? await AutopayMandate.findByPk(order.mandateId, { transaction: t }) : null;
  const method: PaymentMethod =
    order.sourceType === 'AUTOPAY'
      ? mandate?.mandateType === 'ENACH'
        ? 'ENACH'
        : 'UPI_AUTOPAY'
      : (METHOD_MAP[gp.method] ?? order.methodHint ?? 'UPI');
  const amount = advanceOnly ? gp.amountPaise : n(order.basePaise);
  const { payment, created } = await settleInput(
    ctx,
    {
      societyId,
      unitId: n(order.unitId),
      source: order.sourceType === 'AUTOPAY' ? 'AUTOPAY' : 'ONLINE',
      method,
      status: 'CAPTURED',
      payerUserId: order.payerUserId,
      payerName: (await userName(order.payerUserId)) ?? `Unit ${label}`,
      amountPaise: amount,
      convenienceFeePaise: advanceOnly ? 0 : n(order.convenienceFeePaise),
      convenienceFeeGstPaise: advanceOnly ? 0 : n(order.convenienceFeeGstPaise),
      paymentDate: await societyToday(n(order.societyId)), // the society's date, not UTC
      paymentOrderId: n(order.id),
      gatewayAccountId,
      gatewayPaymentId: gp.id,
      gatewayMethodDetail: gp.method.slice(0, 40),
      needsReview: reviewOnly,
      reviewReason: reviewOnly ? (cancelled ? 'ORDER_CANCELLED' : 'AMOUNT_MISMATCH') : null,
      isDuplicateSuspect: duplicate,
      duplicateOfPaymentId: duplicateOf,
      createdBy: null,
      advanceOnly,
      ...orderSpec(order),
    },
    t,
  );
  if (!created) return { outcome: 'ALREADY_SETTLED', paymentId: n(payment.id) }; // a concurrent capture won the lock
  if (!duplicate && !cancelled) {
    await order.update(
      { status: 'PAID', paidAt: new Date(), version: n(order.version) + 1 },
      { transaction: t },
    );
  }
  const hook = order.sourceType === 'MODULE' ? orderHookFor(order.refType) : undefined;
  if (hook && !advanceOnly) await hook.onPaid(ctx, order, payment, t);
  const orderId = n(order.id);
  const unitId = n(order.unitId);
  t.afterCommit(() => {
    const body = { orderId, status: 'PAID', paymentId: n(payment.id), receiptNo: payment.receiptNo };
    if (order.payerUserId) emitToUser(n(order.payerUserId), RT.paymentStatus, body);
    emitToRoom(`unit:${unitId}`, RT.paymentStatus, { orderId, status: 'PAID', receiptNo: payment.receiptNo });
  });
  return { outcome: 'SETTLED', paymentId: n(payment.id), needsReview: reviewOnly, duplicate };
}

/**
 * The idempotent wrapper (BR-12-11) the verify route, the webhook job and the reconcile job call: fetches the gateway payment
 * BEFORE the transaction, runs `settleCapture` in one transaction, and treats a duplicate-key error on
 * `uq_payments_gateway_payment` as "already settled".
 */
export async function settleCaptureTx(
  gatewayAccountId: number,
  gatewayPaymentId: string,
  baseCtx: AnyCtx = systemCtx('settle'),
): Promise<SettleOutcome> {
  const client = paymentsPorts().gateways.clientFor(
    (await paymentsPorts().gateways.getAccount(gatewayAccountId)) ??
      (() => {
        throw new UnprocessableError(ERR.gatewayNotConfigured, 'No gateway account');
      })(),
  );
  const raw = await (client ?? paymentGateway()).fetchPayment(gatewayPaymentId);
  const gp: GatewayPaymentInfo = { id: gatewayPaymentId, ...raw };
  try {
    return await moneyTx(t => settleCapture(gatewayAccountId, gp, t, baseCtx));
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const p = await Payment.findOne({ where: { gatewayPaymentId } });
      if (p) return { outcome: 'ALREADY_SETTLED', paymentId: n(p.id) };
    }
    throw err;
  }
}
