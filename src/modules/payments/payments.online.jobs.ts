import { Op } from 'sequelize';
import { addDays, addHours, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { PaymentOrder, PaymentWebhookEvent } from '../../models';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import './payments.online.templates';
import { ENT, JOBS, NOTIFY, PAYMENTS_QUEUE } from './payments.constants';
import { LIVE, expireOrder, reconcileOrder } from './payments.orders.service';
import { paymentsPorts } from './payments.ports';
import { processWebhookEvent } from './payments.webhooks.service';
import { n } from './payments.shared';

/**
 * Jobs of part 12.1 (section 9.1): process-webhook, reconcile-orders (every 2 minutes), recovery-nudge (every 15 minutes),
 * expire-links (daily 01:00 IST) and purge-webhook-events (daily 04:00 IST). Each body is exported so tests call it directly.
 */
const BATCH = 200;

/** Orders `CREATED`/`ATTEMPTED` with `nextCheckAt <= now`: settle, expire or reschedule (6.7 step 7). */
export async function reconcileDueOrders(): Promise<{ checked: number; failed: number }> {
  const due = await PaymentOrder.findAll({
    where: { status: { [Op.in]: [...LIVE] }, nextCheckAt: { [Op.lte]: now() } },
    order: [['nextCheckAt', 'ASC']],
    limit: BATCH,
    attributes: ['id'],
  });
  let failed = 0;
  for (const o of due)
    try {
      await reconcileOrder(n(o.id));
    } catch (err) {
      failed += 1;
      logger.error({ err, orderId: o.id }, 'reconcile of a payment order failed');
    }
  return { checked: due.length, failed };
}

/** F23: `ATTEMPTED` orders, or `CREATED` older than 2 hours, unpaid and not expired: `payments.checkout_abandoned` once per order. */
export async function sendRecoveryNudges(): Promise<number> {
  const orders = await PaymentOrder.findAll({
    where: {
      status: { [Op.in]: [...LIVE] },
      expiresAt: { [Op.gt]: now() },
      payerUserId: { [Op.ne]: null },
      [Op.or]: [{ status: 'ATTEMPTED' }, { createdAt: { [Op.lte]: addHours(now(), -2) } }],
    },
    limit: BATCH,
  });
  let sent = 0;
  const featureCache = new Map<number, boolean>();
  for (const o of orders) {
    const societyId = n(o.societyId);
    if (!featureCache.has(societyId)) featureCache.set(societyId, await isFeatureOn(societyId, ENT.recovery));
    if (!featureCache.get(societyId)) continue;
    const first = await kv().setIfAbsent(`payments:nudge:${o.id}`, '1', 30 * 86_400);
    if (!first) continue;
    await paymentsPorts()
      .notifications.send(NOTIFY.checkoutAbandoned, [n(o.payerUserId)], {
        societyId,
        orderId: n(o.id),
        grossAmountPaise: n(o.grossAmountPaise),
      })
      .catch(err => logger.error({ err }, 'checkout_abandoned notification failed'));
    sent += 1;
  }
  return sent;
}

/** `PAYMENT_LINK` orders past `expiresAt` become `EXPIRED` (after one more look at the gateway). */
export async function expireLinks(): Promise<number> {
  const links = await PaymentOrder.findAll({
    where: { sourceType: 'PAYMENT_LINK', status: { [Op.in]: [...LIVE] }, expiresAt: { [Op.lte]: now() } },
    limit: BATCH,
    attributes: ['id'],
  });
  let done = 0;
  for (const l of links) {
    try {
      const o = await reconcileOrder(n(l.id)); // settles a late capture, expires when nothing was paid
      if (o.status === 'EXPIRED') done += 1;
      else if (o.status !== 'PAID' && (await expireOrder(n(l.id)))) done += 1;
    } catch (err) {
      logger.error({ err, orderId: l.id }, 'expiring a payment link failed');
    }
  }
  return done;
}

/** Events older than 2 years that are `PROCESSED` or `IGNORED` (section 7.5). */
export async function purgeWebhookEvents(): Promise<number> {
  return PaymentWebhookEvent.destroy({
    where: { status: { [Op.in]: ['PROCESSED', 'IGNORED'] }, createdAt: { [Op.lt]: addDays(now(), -730) } },
  });
}

export function registerOnlineJobs(): void {
  registerProcessor(PAYMENTS_QUEUE, JOBS.processWebhook, async data =>
    processWebhookEvent(Number(data.eventId)),
  );
  registerProcessor(PAYMENTS_QUEUE, JOBS.reconcileOrders, async () => reconcileDueOrders());
  registerProcessor(PAYMENTS_QUEUE, JOBS.recoveryNudge, async () => sendRecoveryNudges());
  registerProcessor(PAYMENTS_QUEUE, JOBS.expireLinks, async () => expireLinks());
  registerProcessor(PAYMENTS_QUEUE, JOBS.purgeWebhookEvents, async () => purgeWebhookEvents());
  registerRepeatable(PAYMENTS_QUEUE, JOBS.reconcileOrders, { everyMs: 2 * 60_000 });
  registerRepeatable(PAYMENTS_QUEUE, JOBS.recoveryNudge, { everyMs: 15 * 60_000 });
  registerRepeatable(PAYMENTS_QUEUE, JOBS.expireLinks, { dailyAtIst: '01:00' });
  registerRepeatable(PAYMENTS_QUEUE, JOBS.purgeWebhookEvents, { dailyAtIst: '04:00' });
}
