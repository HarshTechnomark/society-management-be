import { paymentGateway } from '../../adapters';
import { FakePaymentGateway, signWebhookBody } from '../../adapters/payments/payment-gateway';
import { AutopayMandate, Collection, Payment, PaymentOrder, Refund, Unit, User } from '../../models';
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

/** `POST /dev/payments/mandates/:gatewayMandateId/activate`: the fake gateway confirms a mandate; a signed `mandate.activated` webhook runs through the real webhook path (which calls `handleMandateEvent`). */
export async function devActivateMandate(gatewayMandateId: string) {
  const m = await AutopayMandate.findOne({ where: { gatewayMandateId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', 'Mandate not found');
  const account = await paymentsPorts().gateways.getAccount(Number(m.gatewayAccountId));
  if (!account || !(paymentsPorts().gateways.clientFor(account) instanceof FakePaymentGateway))
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  const raw = Buffer.from(
    JSON.stringify({
      id: `evt_mandate_${gatewayMandateId}_activated`,
      event: 'mandate.activated',
      payload: { mandate: { entity: { id: gatewayMandateId } } },
    }),
  );
  const r = await ingestWebhook(account.id, raw, signWebhookBody(raw, account.webhookSecret), account);
  const eventStatus = r.eventId ? await processWebhookEvent(r.eventId) : 'DUPLICATE';
  const fresh = await AutopayMandate.findByPk(m.id);
  return { mandateId: Number(m.id), gatewayMandateId, status: fresh?.status, eventStatus };
}

/**
 * `POST /dev/payments/refunds/:gatewayRefundId/process { outcome?: 'processed' | 'failed' }`: the fake gateway finishes a
 * gateway-mode refund and a signed `refund.processed` / `refund.failed` webhook runs through the real webhook path (which calls
 * `handleRefundEvent`), so the refund ends PROCESSED (or FAILED with the money restored).
 */
export async function devProcessRefund(gatewayRefundId: string, body: { outcome?: unknown }) {
  const outcome = body.outcome ?? 'processed';
  if (outcome !== 'processed' && outcome !== 'failed')
    throw new AppError(400, 'VALIDATION_FAILED', 'outcome must be processed or failed');
  const r = await Refund.findOne({ where: { gatewayRefundId } });
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
  const p = await Payment.findByPk(Number(r.paymentId), {
    attributes: ['gatewayAccountId', 'gatewayPaymentId'],
  });
  const account = p?.gatewayAccountId
    ? await paymentsPorts().gateways.getAccount(Number(p.gatewayAccountId))
    : null;
  const gw = account ? paymentsPorts().gateways.clientFor(account) : null;
  if (!account || !(gw instanceof FakePaymentGateway)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  const g = gw.refunds.get(gatewayRefundId);
  if (g) g.status = outcome;
  const raw = Buffer.from(
    JSON.stringify({
      id: `evt_refund_${gatewayRefundId}_${outcome}`,
      event: outcome === 'processed' ? 'refund.processed' : 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: gatewayRefundId,
            payment_id: p?.gatewayPaymentId ?? undefined,
            amount: Number(r.amountPaise),
          },
        },
      },
    }),
  );
  const ing = await ingestWebhook(account.id, raw, signWebhookBody(raw, account.webhookSecret), account);
  const eventStatus = ing.eventId ? await processWebhookEvent(ing.eventId) : 'DUPLICATE';
  const fresh = await Refund.findByPk(r.id);
  return { refundId: Number(r.id), gatewayRefundId, status: fresh?.status, eventStatus };
}

/**
 * Extra fields of a module 12 row on `GET /dev/approvals` (flat, amount, mode, title, requester) so the page can say what is
 * being approved. Looked up from the entity the request points at; a missing entity gives no extra fields.
 */
export async function paymentsApprovalDetails(a: {
  type: string;
  entityId: number;
  requestedBy: number | null;
}): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (a.requestedBy) out.requestedByName = (await User.findByPk(a.requestedBy))?.name ?? null;
  const unitLabel = async (unitId: number) => (await Unit.findByPk(unitId))?.label ?? null;
  if (a.type === 'OFFLINE_PAYMENT') {
    const p = await Payment.findByPk(a.entityId);
    if (p) {
      out.unitLabel = await unitLabel(Number(p.unitId));
      out.amountPaise = Number(p.amountPaise);
      out.mode = p.method;
    }
  } else if (a.type === 'PAYMENT_REFUND') {
    const r = await Refund.findByPk(a.entityId);
    if (r) {
      out.unitLabel = await unitLabel(Number(r.unitId));
      out.amountPaise = Number(r.amountPaise);
      out.mode = r.mode;
    }
  } else if (a.type === 'COLLECTION_PUBLISH') {
    const c = await Collection.findByPk(a.entityId);
    if (c) {
      out.title = c.title;
      out.amountPaise = Number(c.targetPaise);
      out.mode = c.amountMode;
    }
  }
  out.payload = { ...out };
  return out;
}
