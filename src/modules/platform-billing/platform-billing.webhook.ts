/**
 * 8.28: the gateway webhook route verifies the signature and enqueues `platform-billing:process-webhook`; this is the
 * processor. Every handler re-checks state under the locks, so a replayed or duplicated event changes nothing.
 */
import type { GatewayWebhookEvent } from '../../adapters/payments/payment-gateway';
import { paymentGateway } from '../../adapters';
import { PlatformPayment } from '../../models';
import { logger } from '../../lib/logger';
import { settleGatewayRefund } from './platform-billing.credits';
import { settleMandateEvent } from './platform-billing.autopay';
import { confirmGatewayPayment, failGatewayPayment } from './platform-billing.payments';
import { SYSTEM_CTX } from './platform-billing.shared';

export const PROCESS_WEBHOOK_JOB = 'platform-billing:process-webhook';

/** Handled event types; others are acknowledged and ignored. */
export const HANDLED_EVENTS = [
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.processed',
  'refund.failed',
  'mandate.activated',
  'mandate.cancelled',
] as const;

/** Returns a short outcome text (logged; tests assert it). */
export async function processWebhookEvent(evt: GatewayWebhookEvent): Promise<string> {
  const ctx = SYSTEM_CTX('webhook');
  switch (evt.type) {
    case 'payment.captured':
    case 'order.paid':
    case 'payment.failed': {
      if (!evt.orderId) return 'ignored: no order';
      const p = await PlatformPayment.findOne({ where: { gatewayOrderId: evt.orderId, kind: 'PAYMENT' } });
      if (!p) {
        logger.warn({ orderId: evt.orderId, type: evt.type }, 'platform webhook for an unknown order');
        return 'ignored: unknown order';
      }
      if (evt.type === 'payment.failed') {
        const changed = await failGatewayPayment(ctx, p.id!, 'Payment failed at the gateway', evt.paymentId);
        return changed ? 'failed' : 'unchanged';
      }
      let gw = {
        paymentId: evt.paymentId ?? '',
        orderId: evt.orderId,
        amountPaise: evt.amountPaise ?? -1,
        method: evt.method,
      };
      if (evt.type === 'order.paid' || !gw.paymentId) {
        const list = await paymentGateway().fetchOrderPayments(evt.orderId);
        const c = list.find(x => x.status === 'captured');
        if (!c) return 'ignored: nothing captured';
        gw = { paymentId: c.paymentId, orderId: evt.orderId, amountPaise: c.amountPaise, method: c.method };
      }
      return confirmGatewayPayment(ctx, p.id!, gw);
    }
    case 'refund.processed':
    case 'refund.failed':
      if (!evt.refundId) return 'ignored: no refund';
      return settleGatewayRefund(ctx, evt.refundId, evt.type === 'refund.processed');
    case 'mandate.activated':
    case 'mandate.cancelled':
      if (!evt.mandateId) return 'ignored: no mandate';
      return settleMandateEvent(ctx, evt.mandateId, evt.type === 'mandate.activated');
    default:
      return 'ignored';
  }
}
