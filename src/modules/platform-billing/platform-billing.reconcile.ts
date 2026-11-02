/**
 * Gateway reconciliation jobs (section 9.1): `reconcile-orders` (every 15 minutes) settles, fails or expires `CREATED`
 * online orders older than `billing.pendingOrderMinutes`; `refund-status` (hourly) polls gateway refunds that are still
 * `PROCESSING` after 2 hours. Both re-check state under the locks, so they can run next to the webhook.
 */
import { Op } from 'sequelize';
import { PlatformPayment, sequelize } from '../../models';
import { paymentGateway } from '../../adapters';
import { addHours, addMinutes, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { settleGatewayRefund } from './platform-billing.credits';
import { confirmGatewayPayment, failGatewayPayment } from './platform-billing.payments';
import { billingSettings } from './platform-billing.settings';
import { SYSTEM_CTX, emitPaymentUpdated, lockPayment } from './platform-billing.shared';

export interface ReconcileResult {
  checked: number;
  settled: number;
  failed: number;
  expired: number;
  errors: number;
}

const EXPIRE_AFTER_HOURS = 24;

async function expirePayment(id: number): Promise<boolean> {
  const ctx = SYSTEM_CTX('reconcile');
  return sequelize.transaction(async t => {
    const { invoice, payment } = await lockPayment(id, t, { kind: 'PAYMENT' });
    if (payment.status !== 'CREATED') return false;
    payment.set({ status: 'EXPIRED', updatedBy: null, version: payment.version + 1 });
    await payment.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'platform_billing.payment.expired',
        entityType: 'platform_payment',
        entityId: payment.id!,
        entityLabel: invoice?.invoiceNo ?? null,
        societyId: payment.societyId,
        after: { gatewayOrderId: payment.gatewayOrderId },
      },
      t,
    );
    emitPaymentUpdated(t, payment);
    return true;
  });
}

export async function runReconcileOrders(): Promise<ReconcileResult> {
  const r: ReconcileResult = { checked: 0, settled: 0, failed: 0, expired: 0, errors: 0 };
  const ctx = SYSTEM_CTX('reconcile');
  const settings = await billingSettings();
  const cutoff = addMinutes(now(), -settings['billing.pendingOrderMinutes']);
  const rows = await PlatformPayment.findAll({
    where: {
      kind: 'PAYMENT',
      status: 'CREATED',
      origin: { [Op.in]: ['SOCIETY', 'SYSTEM'] },
      createdAt: { [Op.lt]: cutoff },
    },
    order: [['id', 'ASC']],
  });
  for (const p of rows) {
    r.checked += 1;
    try {
      const old = p.createdAt!.getTime() < addHours(now(), -EXPIRE_AFTER_HOURS).getTime();
      if (!p.gatewayOrderId) {
        if (await failGatewayPayment(ctx, p.id!, 'The gateway order was never created')) r.failed += 1;
        continue;
      }
      const list = await paymentGateway().fetchOrderPayments(p.gatewayOrderId);
      const captured = list.find(x => x.status === 'captured');
      if (captured) {
        const out = await confirmGatewayPayment(ctx, p.id!, {
          paymentId: captured.paymentId,
          orderId: p.gatewayOrderId,
          amountPaise: captured.amountPaise,
          method: captured.method,
        });
        if (out === 'CAPTURED') r.settled += 1;
        continue;
      }
      if (list.length > 0 && list.every(x => x.status === 'failed')) {
        if (await failGatewayPayment(ctx, p.id!, 'Payment failed at the gateway', list[0]!.paymentId))
          r.failed += 1;
        continue;
      }
      if (old && (await expirePayment(p.id!))) r.expired += 1;
    } catch (err) {
      r.errors += 1;
      logger.warn({ err, paymentId: p.id }, 'platform order reconciliation failed for a payment');
    }
  }
  logger.info(r, 'platform-billing:reconcile-orders done');
  return r;
}

export async function runRefundStatus(): Promise<{
  checked: number;
  refunded: number;
  failed: number;
  errors: number;
}> {
  const r = { checked: 0, refunded: 0, failed: 0, errors: 0 };
  const rows = await PlatformPayment.findAll({
    where: {
      kind: 'REFUND',
      status: 'PROCESSING',
      gatewayRefundId: { [Op.ne]: null },
      updatedAt: { [Op.lt]: addHours(now(), -2) },
    },
    order: [['id', 'ASC']],
  });
  for (const p of rows) {
    r.checked += 1;
    try {
      const g = await paymentGateway().fetchRefund(p.gatewayRefundId!);
      if (g.status === 'pending') continue;
      const out = await settleGatewayRefund(
        SYSTEM_CTX('refund-status'),
        p.gatewayRefundId!,
        g.status === 'processed',
      );
      if (out === 'refunded') r.refunded += 1;
      if (out === 'failed') r.failed += 1;
    } catch (err) {
      r.errors += 1;
      logger.warn({ err, paymentId: p.id }, 'platform refund status poll failed');
    }
  }
  logger.info(r, 'platform-billing:refund-status done');
  return r;
}
