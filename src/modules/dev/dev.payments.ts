import { paymentGateway } from '../../adapters';
import { FakePaymentGateway, signWebhookBody } from '../../adapters/payments/payment-gateway';
import { PaymentOrder } from '../../models';
import { AppError } from '../../utils/errors';
import { paymentsPorts } from '../payments/payments.ports';
import { ingestWebhook, processWebhookEvent } from '../payments/payments.webhooks.service';

/**
 * Development only (the dev router is never mounted in production): what the browser checkout would do on the fake gateway.
 * Works for module 06 platform orders (a plain fake payment, the app then verifies) and for module 12 orders: the fake gateway
 * creates the payment, then a signed Razorpay-shaped webhook is run through the real webhook code (`ingestWebhook` and the
 * `process-webhook` body, which call `settleCapture`), so the order is already PAID (or ATTEMPTED) when the call returns.
 */
export type DevPayStatus = 'captured' | 'failed' | 'pending';
export const mapDevStatus = (s: unknown): DevPayStatus | undefined =>
  s === 'success' || s === 'captured'
    ? 'captured'
    : s === 'fail' || s === 'failed'
      ? 'failed'
      : s === 'pending'
        ? 'pending'
        : undefined;

export async function devPayOrder(
  gatewayOrderId: string,
  body: { amountPaise?: number; status?: unknown; outcome?: unknown; method?: string },
) {
  const platform = paymentGateway();
  const po = await PaymentOrder.findOne({ where: { gatewayOrderId } });
  const account = po ? await paymentsPorts().gateways.getAccount(Number(po.gatewayAccountId)) : null;
  const gw = account ? paymentsPorts().gateways.clientFor(account) : platform;
  if (!(gw instanceof FakePaymentGateway)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  if (!gw.orders.has(gatewayOrderId)) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  const status = mapDevStatus(body.status ?? body.outcome);
  if ((body.status ?? body.outcome) !== undefined && !status)
    throw new AppError(400, 'VALIDATION_FAILED', 'status must be success, fail or pending');
  const p = gw.payOrder(gatewayOrderId, { amountPaise: body.amountPaise, status, method: body.method });
  const result: Record<string, unknown> = {
    gatewayPaymentId: p.paymentId,
    orderId: gatewayOrderId,
    status: p.status,
    amountPaise: p.amountPaise,
  };
  if (po && account && p.status !== 'pending') {
    const raw = Buffer.from(
      JSON.stringify({
        id: `evt_${p.paymentId}`,
        event: p.status === 'captured' ? 'payment.captured' : 'payment.failed',
        payload: {
          payment: {
            entity: { id: p.paymentId, order_id: gatewayOrderId, amount: p.amountPaise, method: p.method },
          },
        },
      }),
    );
    const sig = signWebhookBody(raw, account.webhookSecret);
    const r = await ingestWebhook(account.id, raw, sig, account);
    const eventStatus = r.eventId ? await processWebhookEvent(r.eventId) : 'DUPLICATE';
    const fresh = await PaymentOrder.findByPk(po.id);
    Object.assign(result, { paymentOrderId: Number(po.id), orderStatus: fresh?.status, eventStatus });
  }
  return result;
}

/** Alias: `POST /dev/payments/orders/:orderId/simulate { outcome: 'success' | 'fail' }` with the payment order id (`PO-<id>`). */
export async function devSimulateOrder(paymentOrderId: number, body: { outcome?: unknown }) {
  const po = await PaymentOrder.findByPk(paymentOrderId);
  if (!po || !po.gatewayOrderId) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  return devPayOrder(po.gatewayOrderId, { outcome: body.outcome ?? 'success' });
}
