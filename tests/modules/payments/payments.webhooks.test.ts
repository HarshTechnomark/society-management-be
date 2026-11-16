import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Payment, PaymentOrder, PaymentWebhookEvent, UnitAdvance, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { addDays, now, setNow } from '../../../src/lib/clock';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { FakePaymentGateway, signWebhookBody } from '../../../src/adapters/payments/payment-gateway';
import {
  FAKE_WEBHOOK_SECRET,
  paymentsPortCalls,
  setPaymentsPorts,
} from '../../../src/modules/payments/payments.ports';
import { processWebhookEvent, redact } from '../../../src/modules/payments/payments.webhooks.service';
import { purgeWebhookEvents } from '../../../src/modules/payments/payments.online.jobs';
import { call } from '../../helpers/auth';
import { idem, mkInvoice, onlineWorld, resetPayments, type OnlineWorld } from '../../helpers/payments-online';

let gw: FakePaymentGateway;
let x: OnlineWorld;
afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  gw = await resetPayments();
  await resetRateLimits();
  x = await onlineWorld(gw);
});

async function openOrder(amount = 100_000) {
  await mkInvoice(x.w, 0, amount, '2026-11-20');
  const v = (await x.payer.c('get', `/me/payables?unitId=${x.unitId}`)).body.data.payListVersion;
  const r = await x.payer.c(
    'post',
    '/me/payables/payment-orders',
    { unitId: x.unitId, allocationMode: 'OLDEST_FIRST', duesAmountPaise: amount, payListVersion: v },
    { headers: idem() },
  );
  return { id: r.body.data.orderId as number, go: r.body.data.checkout.gatewayOrderId as string };
}
let seq = 0;
const body = (
  event: string,
  p: { id: string; order_id: string; amount: number },
  id = `evt_${++seq}_${Date.now()}`,
) =>
  JSON.stringify({
    id,
    event,
    payload: {
      payment: { entity: { ...p, method: 'upi', vpa: 'a@b', contact: '98', card: { last4: '1' } } },
    },
  });
const post = (acct: number, raw: string, secret = FAKE_WEBHOOK_SECRET, sig?: string) =>
  call('post', `/webhooks/payments/${acct}`, undefined, {
    origin: null,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': sig ?? signWebhookBody(raw, secret),
    },
  }).send(raw);
const acct = () => x.w.society.id!;

describe('POST /webhooks/payments/:gatewayAccountId (8.25)', () => {
  it('T12-09 a tampered body is 400 WEBHOOK_SIGNATURE_INVALID and nothing is stored', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go);
    const raw = body('payment.captured', { id: p.paymentId, order_id: o.go, amount: 100_000 });
    const r = await post(
      acct(),
      raw.replace('100000', '1'),
      undefined,
      signWebhookBody(raw, FAKE_WEBHOOK_SECRET),
    );
    expect([r.status, r.body.code]).toEqual([400, 'WEBHOOK_SIGNATURE_INVALID']);
    expect((await post(acct(), raw, 'wrong-secret')).status).toBe(400);
    expect((await post(acct(), raw, undefined, '')).status).toBe(400);
    expect(await PaymentWebhookEvent.count()).toBe(0);
  });
  it('an unknown account is 404 NOT_FOUND and a body above 256 KB is 413', async () => {
    const raw = body('payment.captured', { id: 'pay_x', order_id: 'o', amount: 1 });
    setPaymentsPorts({ gateways: { getAccount: async () => null } });
    expect((await post(9999, raw)).status).toBe(404);
    setPaymentsPorts();
    const big = JSON.stringify({ id: 'evt_big', event: 'x', pad: 'a'.repeat(260 * 1024) });
    const r = await post(acct(), big);
    expect(r.status).toBe(413);
  });
  it('stores the event redacted, enqueues the job, and the capture settles once', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go);
    const raw = body('payment.captured', { id: p.paymentId, order_id: o.go, amount: 100_000 });
    const r = await post(acct(), raw);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ received: true });
    const ev = (await PaymentWebhookEvent.findOne())!;
    expect(JSON.stringify(ev.payload)).not.toMatch(/vpa|contact|last4/);
    expect(ev).toMatchObject({
      societyId: acct(),
      provider: 'FAKE',
      eventType: 'payment.captured',
      gatewayOrderId: o.go,
    });
    await drainQueues();
    expect((await PaymentWebhookEvent.findOne())!.status).toBe('PROCESSED');
    expect((await PaymentOrder.findByPk(o.id))!.status).toBe('PAID');
    expect(await Payment.count({ where: { paymentOrderId: o.id } })).toBe(1);
  });
  it('T12-10 the same event five times at once: one event row, one payment, one receipt', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go);
    const raw = body('payment.captured', { id: p.paymentId, order_id: o.go, amount: 100_000 }, 'evt_same');
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => post(acct(), raw)));
    expect(rs.every(r => r.status === 200)).toBe(true);
    expect(rs.filter(r => r.body.data.duplicate).length).toBe(4);
    await drainQueues();
    expect(await PaymentWebhookEvent.count()).toBe(1);
    const pays = await Payment.findAll({ where: { paymentOrderId: o.id } });
    expect(pays).toHaveLength(1);
    expect(pays[0]!.receiptNo).toBeTruthy();
  });
  it('T12-11 verify and webhook race: exactly one payment', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go);
    const raw = body('payment.captured', { id: p.paymentId, order_id: o.go, amount: 100_000 });
    await Promise.all([
      post(acct(), raw).then(async () => drainQueues()),
      x.payer.c('post', `/me/payables/payment-orders/${o.id}/verify`, { gatewayPaymentId: p.paymentId }),
    ]);
    await drainQueues();
    expect(await Payment.count({ where: { paymentOrderId: o.id } })).toBe(1);
    expect((await PaymentOrder.findByPk(o.id))!.status).toBe('PAID');
  });
  it('T12-12 a different amount is recorded, all to advance, needsReview, event NEEDS_REVIEW, treasurer told', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go, { amountPaise: 50_000 });
    await post(acct(), body('payment.captured', { id: p.paymentId, order_id: o.go, amount: 50_000 }));
    await drainQueues();
    const pay = (await Payment.findOne({ where: { paymentOrderId: o.id } }))!;
    expect([pay.status, Number(pay.toAdvancePaise), Boolean(pay.needsReview)]).toEqual([
      'CAPTURED',
      50_000,
      true,
    ]);
    expect((await PaymentWebhookEvent.findOne())!.status).toBe('NEEDS_REVIEW');
    expect(
      paymentsPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.needs_review',
      ),
    ).toBe(true);
  });
  it('T12-13 a second capture on a PAID order is a duplicate suspect, all to advance, both parties notified', async () => {
    const o = await openOrder();
    const p1 = gw.payOrder(o.go);
    await post(acct(), body('payment.captured', { id: p1.paymentId, order_id: o.go, amount: 100_000 }));
    await drainQueues();
    const p2 = gw.payOrder(o.go);
    await post(acct(), body('payment.captured', { id: p2.paymentId, order_id: o.go, amount: 100_000 }));
    await drainQueues();
    const dup = (await Payment.findOne({ where: { gatewayPaymentId: p2.paymentId } }))!;
    expect([Boolean(dup.isDuplicateSuspect), Number(dup.toAdvancePaise)]).toEqual([true, 100_000]);
    expect(dup.duplicateOfPaymentId).toBeTruthy();
    expect(
      paymentsPortCalls.filter(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.duplicate_payment',
      ),
    ).toHaveLength(1);
    expect(await UnitAdvance.count({ where: { societyId: acct() } })).toBeGreaterThan(0);
  });
  it('an event for an unknown order is kept NEEDS_REVIEW without creating a payment', async () => {
    const other = await gw.createOrder({
      societyGatewayAccountId: '1',
      amountPaise: 5_000,
      receipt: 'r',
      notes: {},
    });
    const p = gw.payOrder(other.orderId);
    await post(acct(), body('payment.captured', { id: p.paymentId, order_id: other.orderId, amount: 5_000 }));
    await drainQueues();
    const ev = (await PaymentWebhookEvent.findOne())!;
    expect([ev.status, ev.lastError]).toEqual(['NEEDS_REVIEW', 'UNKNOWN_ORDER']);
    expect(await Payment.count({ where: { societyId: acct() } })).toBe(0);
  });
  it('payment.failed makes the order ATTEMPTED and tells the payer; unhandled types are IGNORED', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go, { status: 'failed' });
    await post(acct(), body('payment.failed', { id: p.paymentId, order_id: o.go, amount: 100_000 }));
    await post(acct(), body('something.else', { id: 'pay_zzzzzz', order_id: o.go, amount: 1 }));
    await drainQueues();
    const o2 = (await PaymentOrder.findByPk(o.id))!;
    expect([o2.status, Number(o2.attemptCount)]).toEqual(['ATTEMPTED', 1]);
    const evs = await PaymentWebhookEvent.findAll({ order: [['id', 'ASC']] });
    expect(evs.map(e => e.status)).toEqual(['PROCESSED', 'IGNORED']);
    expect(
      paymentsPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.payment_failed',
      ),
    ).toBe(true);
  });
  it('BR-12-9 during a secret rotation the previous secret is accepted too', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go);
    setPaymentsPorts({
      gateways: {
        getAccount: async id =>
          ({
            id,
            societyId: id,
            provider: 'FAKE',
            enabledMethods: ['UPI'],
            supportsMandates: false,
            webhookSecret: 'new',
            webhookSecrets: ['new', 'old'],
            isActive: true,
          }) as never,
      },
    });
    const raw = body('payment.captured', { id: p.paymentId, order_id: o.go, amount: 100_000 });
    expect((await post(acct(), raw, 'old')).status).toBe(200);
    expect((await post(acct(), raw, 'ancient')).status).toBe(400);
  });
  it('transient failures retry (FAILED_RETRYABLE) and five attempts need review', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go);
    const ev = await PaymentWebhookEvent.create({
      societyId: acct(),
      gatewayAccountId: acct(),
      provider: 'FAKE',
      providerEventId: 'evt_retry',
      eventType: 'payment.captured',
      gatewayOrderId: o.go,
      gatewayPaymentId: p.paymentId,
      gatewayRefundId: null,
      gatewayMandateId: null,
      amountPaise: 100_000,
      payload: {},
      status: 'RECEIVED',
      attempts: 0,
      lastError: null,
      processedAt: null,
      reviewedBy: null,
      createdBy: null,
      updatedBy: null,
    } as never);
    const id = Number(ev.id);
    for (let i = 1; i <= 4; i++) {
      gw.failNext.fetchPayment = true;
      await expect(processWebhookEvent(id)).rejects.toThrow();
      expect((await PaymentWebhookEvent.findByPk(id))!.status).toBe('FAILED_RETRYABLE');
    }
    gw.failNext.fetchPayment = true;
    expect(await processWebhookEvent(id)).toBe('NEEDS_REVIEW');
    expect(await processWebhookEvent(id)).toBe('NEEDS_REVIEW'); // skipped, no change
    expect(await Payment.count({ where: { paymentOrderId: o.id } })).toBe(0);
  });
  it('payment.dispute.created flags the payment for review', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go);
    await post(acct(), body('payment.captured', { id: p.paymentId, order_id: o.go, amount: 100_000 }));
    await drainQueues();
    await post(acct(), body('payment.dispute.created', { id: p.paymentId, order_id: o.go, amount: 100_000 }));
    await drainQueues();
    expect(Boolean((await Payment.findOne({ where: { gatewayPaymentId: p.paymentId } }))!.needsReview)).toBe(
      true,
    );
  });
  it('payment.dispute.lost reverses the payment (CHARGEBACK_LOST)', async () => {
    const o = await openOrder();
    const p = gw.payOrder(o.go);
    await post(acct(), body('payment.captured', { id: p.paymentId, order_id: o.go, amount: 100_000 }));
    await drainQueues();
    await post(acct(), body('payment.dispute.lost', { id: p.paymentId, order_id: o.go, amount: 100_000 }));
    await drainQueues();
    const pay = (await Payment.findOne({ where: { gatewayPaymentId: p.paymentId } }))!;
    expect([pay.status, pay.reversalReasonCode]).toEqual(['REVERSED', 'CHARGEBACK_LOST']);
  });
});

describe('helpers and purge', () => {
  it('redact removes card, vpa, contact, email and bank_account at any depth', () => {
    expect(redact({ a: { vpa: 1, card: 2, k: [{ email: 3, ok: 4 }] }, contact: 5 })).toEqual({
      a: { k: [{ ok: 4 }] },
    });
  });
  it('purge deletes processed and ignored events older than two years only', async () => {
    const mk = (status: string, createdAt: Date, eid: string) =>
      PaymentWebhookEvent.create({
        societyId: acct(),
        gatewayAccountId: acct(),
        provider: 'FAKE',
        providerEventId: eid,
        eventType: 't',
        gatewayOrderId: null,
        gatewayPaymentId: null,
        gatewayRefundId: null,
        gatewayMandateId: null,
        amountPaise: null,
        payload: {},
        status: status as never,
        attempts: 0,
        lastError: null,
        processedAt: null,
        reviewedBy: null,
        createdBy: null,
        updatedBy: null,
        createdAt,
      } as never);
    await mk('PROCESSED', addDays(now(), -800), 'a');
    await mk('IGNORED', addDays(now(), -800), 'b');
    await mk('NEEDS_REVIEW', addDays(now(), -800), 'c');
    await mk('PROCESSED', addDays(now(), -10), 'd');
    expect(await purgeWebhookEvents()).toBe(2);
    expect(await PaymentWebhookEvent.count()).toBe(2);
    setNow('2026-11-04T04:30:00Z');
  });
});
