import { Op, type WhereOptions } from 'sequelize';
import { addMinutes, now } from '../../lib/clock';
import { formatRupees } from '../../lib/money';
import { logger } from '../../lib/logger';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { Payment, PaymentOrder, Society, Unit, User } from '../../models';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError, RateLimitedError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { systemCtx, type Ctx } from '../../types/context';
import { AUDIT, EFFECTIVE_STATUSES, ERR, RT } from './payments.constants';
import {
  accountOf,
  fetchGatewayPayment,
  linesOf,
  nextCheckFor,
  settleFetched,
} from './payments.orders.gateway';
import { paymentsPorts } from './payments.ports';
import { orderHookFor, type GatewayPaymentInfo } from './payments.settle';
import { invalidState, moneyTx, n, withSociety } from './payments.shared';
import type { AnyCtx, Transaction } from './payments.types';
import { kv } from '../../lib/kv';

export const LIVE = ['CREATED', 'ATTEMPTED'] as const;
const isLive = (o: PaymentOrder) => (LIVE as readonly string[]).includes(o.status);

/** Resident view of an order: caller's units only (404 for another unit, society or an unknown id). */
export async function residentOrder(ctx: Ctx, orderId: number): Promise<PaymentOrder> {
  const o = await PaymentOrder.findOne({ where: { id: orderId, societyId: ctx.society!.id } });
  if (!o || !(ctx.unitIds ?? []).includes(n(o.unitId)))
    throw new NotFoundError(ERR.orderNotFound, 'Payment order not found');
  return o;
}

export async function societyOrder(societyId: number, orderId: number): Promise<PaymentOrder> {
  const o = await PaymentOrder.findOne({ where: { id: orderId, societyId } });
  if (!o) throw new NotFoundError(ERR.orderNotFound, 'Payment order not found');
  return o;
}

/** The status body of 8.4 (verify and GET share it); `lines` and amounts are extras for the checkout screens. */
export async function statusBody(orderId: number) {
  const o = (await PaymentOrder.findByPk(orderId))!;
  const p = await Payment.findOne({
    where: { paymentOrderId: o.id, status: { [Op.in]: [...EFFECTIVE_STATUSES] } },
    order: [['id', 'ASC']],
  });
  const society = await Society.findByPk(o.societyId, { attributes: ['name'] });
  const paid = o.status === 'PAID' && p;
  return {
    orderId: n(o.id),
    status: o.status,
    payment: p
      ? {
          id: n(p.id),
          receiptNo: p.receiptNo,
          amountPaise: n(p.amountPaise),
          paymentDate: p.paymentDate,
        }
      : null,
    message: paid
      ? `${formatRupees(n(p.amountPaise))} added to ${society?.name ?? 'the society'} account`
      : o.status === 'CREATED' || o.status === 'ATTEMPTED'
        ? 'Waiting for the payment to complete'
        : o.status === 'FAILED'
          ? 'The payment could not be started'
          : o.status === 'EXPIRED'
            ? 'This payment expired'
            : o.status === 'CANCELLED'
              ? 'This payment was cancelled'
              : null,
    lines: linesOf(o),
    grossAmountPaise: n(o.grossAmountPaise),
    expiresAt: o.expiresAt,
  };
}

/** 8.4 verify: asks the gateway (BR-12-8), requires the gateway order to be this order's, then `settleCapture`. */
export async function verifyOrder(ctx: AnyCtx, order: PaymentOrder, gatewayPaymentId: string) {
  if (order.status === 'FAILED') throw invalidState('This payment order failed and cannot be verified');
  const account = await accountOf(n(order.gatewayAccountId));
  const gp = await fetchGatewayPayment(account, gatewayPaymentId);
  if (!order.gatewayOrderId || gp.orderId !== order.gatewayOrderId)
    throw new AppError(422, ERR.paymentMismatch, 'This payment belongs to another order');
  await settleFetched(n(order.gatewayAccountId), gp, ctx);
  return statusBody(n(order.id));
}

/** Settles whatever the gateway shows for an order (captures first); returns true when a payment settled it. */
export async function pullFromGateway(order: PaymentOrder, ctx: AnyCtx): Promise<void> {
  if (!order.gatewayOrderId) return;
  const account = await accountOf(n(order.gatewayAccountId));
  const client = paymentsPorts().gateways.clientFor(account);
  let list: Awaited<ReturnType<typeof client.fetchOrderPayments>>;
  try {
    list = await client.fetchOrderPayments(order.gatewayOrderId);
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'gateway fetchOrderPayments failed');
    throw new AppError(502, ERR.gatewayError, 'The payment gateway could not be reached');
  }
  const ordered = [...list].sort((a, b) => Number(b.status === 'captured') - Number(a.status === 'captured'));
  for (const p of ordered) {
    const gp: GatewayPaymentInfo = {
      id: p.paymentId,
      status: p.status,
      amountPaise: p.amountPaise,
      method: p.method,
      orderId: order.gatewayOrderId,
    };
    await settleFetched(n(order.gatewayAccountId), gp, ctx);
  }
}

/** 8.4 cancel: a capture found at the gateway settles instead and refuses with the paid status. */
export async function cancelOrder(ctx: AnyCtx, order: PaymentOrder, reason: string) {
  if (!isLive(order)) throw invalidState('Only an unpaid order can be cancelled');
  await pullFromGateway(order, ctx);
  const done = await moneyTx(async t => {
    const o = await PaymentOrder.findOne({ where: { id: order.id }, lock: t.LOCK.UPDATE, transaction: t });
    if (!o || !isLive(o)) return o;
    const before = { status: o.status };
    await o.update(
      {
        status: 'CANCELLED',
        cancelledAt: now(),
        cancelReason: reason.slice(0, 300),
        nextCheckAt: null,
        updatedBy: ctx.user?.id ?? null,
        version: n(o.version) + 1,
      },
      { transaction: t },
    );
    await audit(
      withSociety(ctx, n(o.societyId)),
      {
        action: AUDIT.orderCancelled,
        entityType: 'payment_order',
        entityId: n(o.id),
        entityLabel: `PO-${o.id}`,
        societyId: n(o.societyId),
        before,
        after: { status: 'CANCELLED' },
        reason,
      },
      t,
    );
    return o;
  });
  if (!done || done.status !== 'CANCELLED')
    throw new AppError(409, ERR.invalidState, 'This order was paid or closed meanwhile', [
      { field: 'status', message: 'Order is no longer open', status: done?.status ?? 'UNKNOWN' },
    ]);
  return statusBody(n(order.id));
}

/** `EXPIRED` under the order lock when it is still open and past `expiresAt`; runs the module hook inside the transaction. */
export async function expireOrder(orderId: number, ctx: AnyCtx = systemCtx('expire')): Promise<boolean> {
  return moneyTx(async t => {
    const o = await PaymentOrder.findOne({ where: { id: orderId }, lock: t.LOCK.UPDATE, transaction: t });
    if (!o || !isLive(o) || o.expiresAt.getTime() > now().getTime()) return false;
    await o.update(
      { status: 'EXPIRED', nextCheckAt: null, lastCheckedAt: now(), version: n(o.version) + 1 },
      { transaction: t },
    );
    const sctx = withSociety(ctx, n(o.societyId));
    await audit(
      sctx,
      {
        action: AUDIT.orderExpired,
        entityType: 'payment_order',
        entityId: n(o.id),
        entityLabel: `PO-${o.id}`,
        societyId: n(o.societyId),
        before: { status: 'CREATED' },
        after: { status: 'EXPIRED' },
        reason: null,
      },
      t,
    );
    const hook = o.sourceType === 'MODULE' ? orderHookFor(o.refType) : undefined;
    if (hook?.onExpired) await hook.onExpired(sctx, o, t);
    const orderId2 = n(o.id);
    const unitId = n(o.unitId);
    t.afterCommit(() => {
      if (o.payerUserId)
        emitToUser(n(o.payerUserId), RT.paymentStatus, {
          orderId: orderId2,
          status: 'EXPIRED',
          paymentId: null,
          receiptNo: null,
        });
      emitToRoom(`unit:${unitId}`, RT.paymentStatus, {
        orderId: orderId2,
        status: 'EXPIRED',
        receiptNo: null,
      });
    });
    return true;
  });
}

/**
 * The reconcile step for one order (6.7 step 7, 9.1): settle what the gateway shows, expire it when past `expiresAt` with
 * nothing captured, otherwise schedule the next check. Used by the job and by `POST /payment-orders/:id/check`.
 */
export async function reconcileOrder(
  orderId: number,
  ctx: AnyCtx = systemCtx('reconcile'),
): Promise<PaymentOrder> {
  const o = await PaymentOrder.findByPk(orderId);
  if (!o) throw new NotFoundError(ERR.orderNotFound, 'Payment order not found');
  if (!isLive(o)) return o;
  try {
    await pullFromGateway(o, ctx);
  } catch (err) {
    await PaymentOrder.update(
      { nextCheckAt: addMinutes(now(), 3), lastCheckedAt: now() },
      { where: { id: orderId } },
    );
    throw err;
  }
  const fresh = (await PaymentOrder.findByPk(orderId))!;
  if (!isLive(fresh)) return fresh;
  if (fresh.expiresAt.getTime() <= now().getTime()) {
    await expireOrder(orderId, ctx);
  } else {
    await PaymentOrder.update(
      { lastCheckedAt: now(), nextCheckAt: nextCheckFor(fresh.createdAt) },
      { where: { id: orderId } },
    );
  }
  return (await PaymentOrder.findByPk(orderId))!;
}

/** `POST /payment-orders/:id/check`: at most once a minute per order. */
export async function forceCheck(ctx: Ctx, orderId: number) {
  const o = await societyOrder(ctx.society!.id, orderId);
  if (!o.gatewayOrderId) throw invalidState('This order has no gateway order to check');
  const hit = await kv().slidingWindowHit(`payments-order-check:${orderId}`, 60_000, 1);
  if (!hit.allowed) throw new RateLimitedError(hit.retryAfterSeconds);
  const r = await reconcileOrder(orderId, ctx);
  return adminOrderDetail(ctx.society!.id, n(r.id));
}

// ---------------------------------------------------------------- admin reads (8.16)
export interface OrderListQuery {
  status?: string;
  sourceType?: string;
  unitId?: number;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  sortBy: 'createdAt' | 'grossAmountPaise';
  sortOrder: 'asc' | 'desc';
}

export async function listOrders(societyId: number, q: OrderListQuery) {
  const where: WhereOptions[] = [{ societyId }];
  if (q.status) where.push({ status: q.status });
  if (q.sourceType) where.push({ sourceType: q.sourceType });
  if (q.unitId) where.push({ unitId: q.unitId });
  if (q.from) where.push({ createdAt: { [Op.gte]: new Date(`${q.from}T00:00:00+05:30`) } });
  if (q.to)
    where.push({
      createdAt: { [Op.lt]: new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000) },
    });
  const { rows, count } = await PaymentOrder.findAndCountAll({
    where: { [Op.and]: where },
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const units = await Unit.findAll({
    where: { societyId, id: { [Op.in]: [...new Set(rows.map(r => n(r.unitId)))] } },
    attributes: ['id', 'label'],
  });
  const label = new Map(units.map(u => [n(u.id), u.label]));
  return {
    data: rows.map(r => ({
      id: n(r.id),
      unitId: n(r.unitId),
      unitLabel: label.get(n(r.unitId)) ?? '',
      sourceType: r.sourceType,
      status: r.status,
      grossAmountPaise: n(r.grossAmountPaise),
      expiresAt: r.expiresAt,
      paidAt: r.paidAt,
      attemptCount: n(r.attemptCount),
      linkShortCode: r.linkShortCode,
      createdAt: r.createdAt,
    })),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

export async function adminOrderDetail(societyId: number, orderId: number) {
  const o = await societyOrder(societyId, orderId);
  const unit = await Unit.findByPk(o.unitId, { attributes: ['label'] });
  const payer = o.payerUserId ? await User.findByPk(o.payerUserId, { attributes: ['name'] }) : null;
  const payments = await Payment.findAll({ where: { paymentOrderId: o.id }, order: [['id', 'ASC']] });
  return {
    id: n(o.id),
    unitId: n(o.unitId),
    unitLabel: unit?.label ?? '',
    payerUserId: o.payerUserId,
    payerName: payer?.name ?? null,
    sourceType: o.sourceType,
    sourceModule: o.sourceModule,
    refType: o.refType,
    refId: o.refId,
    status: o.status,
    allocationMode: o.allocationMode,
    items: o.items,
    lines: linesOf(o),
    basePaise: n(o.basePaise),
    convenienceFeePaise: n(o.convenienceFeePaise),
    convenienceFeeGstPaise: n(o.convenienceFeeGstPaise),
    grossAmountPaise: n(o.grossAmountPaise),
    feeMode: o.feeMode,
    feeRateBp: n(o.feeRateBp),
    methodHint: o.methodHint,
    gatewayOrderId: o.gatewayOrderId,
    expiresAt: o.expiresAt,
    paidAt: o.paidAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    failureReason: o.failureReason,
    attemptCount: n(o.attemptCount),
    lastCheckedAt: o.lastCheckedAt,
    nextCheckAt: o.nextCheckAt,
    linkShortCode: o.linkShortCode,
    linkOpenedCount: n(o.linkOpenedCount),
    createdAt: o.createdAt,
    version: n(o.version),
    payments: payments.map(p => ({
      id: n(p.id),
      status: p.status,
      method: p.method,
      amountPaise: n(p.amountPaise),
      grossAmountPaise: n(p.grossAmountPaise),
      receiptNo: p.receiptNo,
      needsReview: Boolean(p.needsReview),
      isDuplicateSuspect: Boolean(p.isDuplicateSuspect),
      capturedAt: p.capturedAt,
    })),
  };
}

/** Module 09 `onUnitLinkEnded` (orders part): the payer's open orders of the unit are cancelled; a later capture is kept for review (BR-12-13). */
export async function cancelOrdersForUnitLink(ctx: AnyCtx, unitId: number, userId: number, t: Transaction) {
  const live = await PaymentOrder.findAll({
    where: { unitId, payerUserId: userId, status: { [Op.in]: [...LIVE] } },
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
  for (const o of live) {
    await o.update(
      {
        status: 'CANCELLED',
        cancelledAt: now(),
        cancelReason: 'The payer no longer belongs to this flat',
        nextCheckAt: null,
        version: n(o.version) + 1,
      },
      { transaction: t },
    );
    await audit(
      withSociety(ctx, n(o.societyId)),
      {
        action: AUDIT.orderCancelled,
        entityType: 'payment_order',
        entityId: n(o.id),
        entityLabel: `PO-${o.id}`,
        societyId: n(o.societyId),
        before: { status: 'CREATED' },
        after: { status: 'CANCELLED' },
        reason: 'UNIT_LINK_ENDED',
      },
      t,
    );
  }
  return live.length;
}
