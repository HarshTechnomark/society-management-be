import { UniqueConstraintError } from 'sequelize';
import { logger } from '../../lib/logger';
import { addMinutes, now } from '../../lib/clock';
import { Payment, PaymentOrder, Society, Unit } from '../../models';
import { AppError, UnprocessableError } from '../../utils/errors';
import { systemCtx } from '../../types/context';
import { usersWithPermission } from '../access-control/access-control.public';
import { ERR, NOTIFY, PERM, type FeeMethod } from './payments.constants';
import { DEFAULT_FEE_RATES_BP } from './payments.orders.fee';
import type { CheckoutBlock, OrderLine, PaymentOrderDto } from './payments.orders.types';
import { paymentsPorts, type GatewayAccountDto } from './payments.ports';
import { settleCapture, type GatewayPaymentInfo, type SettleOutcome } from './payments.settle';
import { moneyTx, n } from './payments.shared';
import type { AnyCtx, OrderItem } from './payments.types';

/**
 * The gateway side of orders (BR-12-1, BR-12-2): the society's account, the `checkout` block, the one place that calls
 * `createOrder`, and `settleFetched`, the wrapper every capture path (verify, webhook job, reconcile job, dev route) uses to run the
 * core `settleCapture` in one transaction. The gateway is never called while a transaction is open.
 */

/** Active gateway account of the society or `422 GATEWAY_NOT_CONFIGURED` (BR-12-1). */
export async function activeAccount(societyId: number): Promise<GatewayAccountDto> {
  const a = await paymentsPorts().gateways.accountFor(societyId);
  if (!a || !a.isActive)
    throw new UnprocessableError(ERR.gatewayNotConfigured, 'Online payment is not set up for this society');
  return a;
}

/** The account of an existing order, active or not (open orders settle after a deactivation). */
export async function accountOf(accountId: number): Promise<GatewayAccountDto> {
  const a = await paymentsPorts().gateways.getAccount(accountId);
  if (!a) throw new UnprocessableError(ERR.gatewayNotConfigured, 'The gateway account no longer exists');
  return a;
}

/** Fee rates in basis points by method: module 29 supplies `feeRatesBp` on the account; until then the placeholder rates. */
export const feeRatesOf = (a: GatewayAccountDto): Record<FeeMethod, number> => ({
  ...DEFAULT_FEE_RATES_BP,
  ...((a as GatewayAccountDto & { feeRatesBp?: Partial<Record<FeeMethod, number>> }).feeRatesBp ?? {}),
});

/** Webhook secrets: the current one and, for 24 hours after a rotation, the previous one (module 29 supplies `webhookSecrets`). */
export const webhookSecretsOf = (a: GatewayAccountDto): string[] =>
  (a as GatewayAccountDto & { webhookSecrets?: string[] }).webhookSecrets ?? [a.webhookSecret];

export const orderDto = (o: PaymentOrder): PaymentOrderDto => ({
  id: n(o.id),
  societyId: n(o.societyId),
  unitId: n(o.unitId),
  sourceType: o.sourceType,
  status: o.status,
  basePaise: n(o.basePaise),
  convenienceFeePaise: n(o.convenienceFeePaise),
  convenienceFeeGstPaise: n(o.convenienceFeeGstPaise),
  grossAmountPaise: n(o.grossAmountPaise),
  expiresAt: o.expiresAt,
  paidAt: o.paidAt,
  gatewayOrderId: o.gatewayOrderId,
  refType: o.refType,
  refId: o.refId,
  items: (o.items ?? []) as OrderItem[],
});

export const linesOf = (o: PaymentOrder): OrderLine[] =>
  ((o.items ?? []) as OrderItem[]).map(i => ({
    label:
      i.itemType === 'OLDEST_FIRST_DUES'
        ? 'Dues, oldest first'
        : i.itemType === 'ADVANCE'
          ? 'Advance'
          : i.label,
    amountPaise: i.amountPaise,
  }));

/** The checkout block of 8.3: key id, gateway order, UPI intent URL (phone) or QR payload (desktop), method restriction. */
export async function checkoutOf(
  o: PaymentOrder,
  account: GatewayAccountDto,
  device: 'PHONE' | 'DESKTOP' = 'PHONE',
): Promise<CheckoutBlock | null> {
  if (!o.gatewayOrderId) return null;
  const society = await Society.findByPk(o.societyId, { attributes: ['name'] });
  const unit = await Unit.findByPk(o.unitId, { attributes: ['label'] });
  const methods = o.methodHint ? [o.methodHint] : account.enabledMethods;
  const upi = methods.includes('UPI')
    ? `upi://pay?pa=society${n(o.societyId)}@fakebank&pn=${encodeURIComponent(society?.name ?? 'Society')}&am=${(n(o.grossAmountPaise) / 100).toFixed(2)}&tr=${o.gatewayOrderId}&cu=INR`
    : null;
  return {
    provider: account.provider,
    keyId: `key_${account.provider.toLowerCase()}_${account.id}`,
    gatewayOrderId: o.gatewayOrderId,
    order_id: o.gatewayOrderId,
    name: society?.name ?? '',
    description: `${unit?.label ?? ''} · PO-${n(o.id)}`,
    methods,
    upiIntentUrl: device === 'PHONE' ? upi : null,
    qrPayload: device === 'DESKTOP' ? upi : null,
    prefill: { contact: null },
  };
}

/** Reconcile schedule (6.7): 3, 10 and 30 minutes after creation, then hourly. */
export function nextCheckFor(createdAt: Date, at: Date = now()): Date {
  const age = (at.getTime() - createdAt.getTime()) / 60_000;
  if (age < 3) return addMinutes(createdAt, 3);
  if (age < 10) return addMinutes(createdAt, 10);
  if (age < 30) return addMinutes(createdAt, 30);
  return addMinutes(at, 60);
}

/**
 * Creates the gateway order for a stored order (step 3 of 6.7), outside any transaction. A pay-list order whose gateway call fails
 * becomes `FAILED` (`502 GATEWAY_ERROR`); a link order stays `CREATED` so the link can be opened again. Safe to call twice: the
 * order id is stored only while the column is still empty, and a second order created by a race is left unused.
 */
export async function ensureGatewayOrder(
  order: PaymentOrder,
  account: GatewayAccountDto,
  opts: { failOrder: boolean },
): Promise<PaymentOrder> {
  if (order.gatewayOrderId) return order;
  const client = paymentsPorts().gateways.clientFor(account);
  let gatewayOrderId: string;
  try {
    const r = await client.createOrder({
      societyGatewayAccountId: String(account.id),
      amountPaise: n(order.grossAmountPaise),
      receipt: `PO-${n(order.id)}`,
      notes: {
        societyId: String(order.societyId),
        unitId: String(order.unitId),
        paymentOrderId: String(order.id),
      },
    });
    gatewayOrderId = r.orderId;
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'gateway createOrder failed');
    if (opts.failOrder)
      await PaymentOrder.update(
        {
          status: 'FAILED',
          failureReason: 'The payment gateway could not create the order',
          nextCheckAt: null,
        },
        { where: { id: order.id, status: 'CREATED' } },
      );
    throw new AppError(502, ERR.gatewayError, 'The payment gateway is not reachable. Try again in a moment.');
  }
  const [changed] = await PaymentOrder.update(
    { gatewayOrderId, version: n(order.version) + 1 },
    { where: { id: order.id, gatewayOrderId: null } },
  );
  const fresh = (await PaymentOrder.findByPk(order.id))!;
  if (!changed) logger.warn({ orderId: order.id }, 'gateway order created twice; the second one is unused');
  return fresh;
}

/** Treasurer-side people (`finance.payments.edit`, BR-12-13 and BR-12-14). */
export const treasurerIds = (societyId: number): Promise<number[]> =>
  usersWithPermission(societyId, PERM.paymentsEdit);

async function sendAll(template: string, userIds: number[], data: Record<string, unknown>): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await paymentsPorts()
    .notifications.send(template, ids, data)
    .catch(err => logger.error({ err, template }, 'payments notification failed'));
}

/** After-commit notifications of a settled capture that needs attention (BR-12-13, BR-12-14). */
export async function notifyOutcome(
  societyId: number,
  order: PaymentOrder | null,
  out: SettleOutcome,
): Promise<void> {
  if (out.outcome === 'UNKNOWN_ORDER') {
    await sendAll(NOTIFY.needsReview, await treasurerIds(societyId), { societyId, reason: 'UNKNOWN_ORDER' });
    return;
  }
  // a settled capture that needs review or is a duplicate suspect is announced by `payments.admin.alerts.ts`
  // (driven by the committed capture audit row, for every capture path), so it is not sent a second time here
}

/**
 * Settles one gateway payment that the caller already fetched (BR-12-11): one money transaction around the core
 * `settleCapture`, a duplicate-key race treated as "already settled", notifications after commit. Returns the outcome and the
 * order id (null when the order is unknown).
 */
export async function settleFetched(
  gatewayAccountId: number,
  gp: GatewayPaymentInfo,
  ctx: AnyCtx = systemCtx('settle'),
): Promise<SettleOutcome> {
  let out: SettleOutcome;
  try {
    out = await moneyTx(t => settleCapture(gatewayAccountId, gp, t, ctx));
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const p = await Payment.findOne({ where: { gatewayPaymentId: gp.id } });
      if (p) return { outcome: 'ALREADY_SETTLED', paymentId: n(p.id) };
    }
    throw err;
  }
  if (out.outcome === 'SETTLED' || out.outcome === 'UNKNOWN_ORDER') {
    const order = await PaymentOrder.findOne({ where: { gatewayAccountId, gatewayOrderId: gp.orderId } });
    const societyId = order ? n(order.societyId) : ((await accountOf(gatewayAccountId)).societyId ?? 0);
    await notifyOutcome(societyId, order, out);
  }
  return out;
}

/** BR-12-8: asks the gateway for the payment (never trusts the client); a failure is `502 GATEWAY_ERROR`. */
export async function fetchGatewayPayment(
  account: GatewayAccountDto,
  gatewayPaymentId: string,
): Promise<GatewayPaymentInfo> {
  try {
    const raw = await paymentsPorts().gateways.clientFor(account).fetchPayment(gatewayPaymentId);
    return { id: gatewayPaymentId, ...raw };
  } catch (err) {
    logger.error({ err, gatewayPaymentId }, 'gateway fetchPayment failed');
    throw new AppError(
      502,
      ERR.gatewayError,
      'The payment gateway could not be reached. We will confirm shortly.',
    );
  }
}
