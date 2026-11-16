import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Invoice, Payment, PaymentOrder, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { addDays, advance, setNow } from '../../../src/lib/clock';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { payments } from '../../../src/modules/payments/payments.public';
import { clearOrderHooks } from '../../../src/modules/payments/payments.settle';
import { paymentsPortCalls, setPaymentsPorts } from '../../../src/modules/payments/payments.ports';
import {
  expireLinks,
  reconcileDueOrders,
  sendRecoveryNudges,
} from '../../../src/modules/payments/payments.online.jobs';
import { cancelOrdersForUnitLink } from '../../../src/modules/payments/payments.orders.service';
import { call } from '../../helpers/auth';
import { setSetting } from '../../helpers/billing-runs';
import { sysCtx } from '../../helpers/payments';
import {
  idem,
  mkInvoice,
  onlineWorld,
  setSocietyStatus,
  resetPayments,
  type OnlineWorld,
} from '../../helpers/payments-online';

let gw: FakePaymentGateway;
let x: OnlineWorld;
afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  gw = await resetPayments();
  clearOrderHooks();
  await resetRateLimits();
  x = await onlineWorld(gw);
});

const mkLink = async (body: Record<string, unknown> = { unitId: x.unitId, amountMode: 'OUTSTANDING' }) =>
  x.w.c('post', '/payment-links', body, { headers: idem() });
const parts = (url: string) => ({ code: url.split('/pay/')[1]!.split('#')[0]!, token: url.split('#')[1]! });
const pub = (method: 'get' | 'post', path: string, token?: string, body?: unknown) =>
  call(method, path, body, { headers: token ? { 'x-pay-token': token } : {} });

describe('POST /payment-links (8.18)', () => {
  it('creates a PAYMENT_LINK order for the outstanding amount, shows the url once, notifies the bill-to, audits', async () => {
    await mkInvoice(x.w, 0, 120_000, '2026-11-04');
    await mkInvoice(x.w, 0, 680_900, '2026-11-20');
    const r = await mkLink({ unitId: x.unitId, amountMode: 'OUTSTANDING', channels: ['SMS', 'EMAIL'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ amountPaise: 800_900 });
    expect(r.body.data.url).toMatch(/\/pay\/[A-Za-z0-9]{10}#[A-Za-z0-9_-]{20,}$/);
    const o = (await PaymentOrder.findByPk(r.body.data.orderId))!;
    expect([o.sourceType, o.allocationMode, o.gatewayOrderId, o.payerUserId, o.feeMode]).toEqual([
      'PAYMENT_LINK',
      'OLDEST_FIRST',
      null,
      null,
      'SOCIETY_ABSORBS',
    ]);
    expect(o.linkTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(o.linkTokenHash).not.toContain(parts(r.body.data.url).token);
    expect(gw.orders.size).toBe(0);

    const listed = await x.w.c('get', '/payment-orders?sourceType=PAYMENT_LINK');
    expect(listed.body.data[0]).toMatchObject({ id: o.id, linkShortCode: o.linkShortCode });
  });
  it('FIXED needs an amount; OUTSTANDING with nothing due is NOTHING_TO_PAY; unknown unit 404; same key replays', async () => {
    expect((await mkLink({ unitId: x.unitId, amountMode: 'FIXED' })).status).toBe(400);
    expect((await mkLink({ unitId: x.unitId, amountMode: 'OUTSTANDING', amountPaise: 500 })).status).toBe(
      400,
    );
    expect((await mkLink()).body.code).toBe('NOTHING_TO_PAY');
    expect((await mkLink({ unitId: 99999999, amountMode: 'FIXED', amountPaise: 500 })).body.code).toBe(
      'UNIT_NOT_FOUND',
    );
    const h = idem();
    const b = { unitId: x.unitId, amountMode: 'FIXED', amountPaise: 5_000 };
    const a1 = await x.w.c('post', '/payment-links', b, { headers: h });
    const a2 = await x.w.c('post', '/payment-links', b, { headers: h });
    expect(a2.headers['idempotent-replay']).toBe('true');
    expect(a2.body.data.orderId).toBe(a1.body.data.orderId);
    setPaymentsPorts({ gateways: { accountFor: async () => null } });
    expect((await mkLink(b)).body.code).toBe('GATEWAY_NOT_CONFIGURED');
  });
  it('residents cannot create links', async () => {
    expect(
      (
        await x.payer.c(
          'post',
          '/payment-links',
          { unitId: x.unitId, amountMode: 'FIXED', amountPaise: 500 },
          { headers: idem() },
        )
      ).status,
    ).toBe(403);
  });
});

describe('public pay routes (8.24)', () => {
  async function link(amount = 5_000) {
    const r = await mkLink({ unitId: x.unitId, amountMode: 'FIXED', amountPaise: amount });
    return { ...parts(r.body.data.url), orderId: r.body.data.orderId as number };
  }
  it('T12-41 wrong token and wrong code are 404; the page shows a masked name and counts opens', async () => {
    const l = await link();
    expect((await pub('get', `/public/pay/${l.code}`, 'wrongtokenwrongtoken')).body.code).toBe(
      'PAYMENT_LINK_NOT_FOUND',
    );
    expect((await pub('get', `/public/pay/${l.code}`)).status).toBe(404);
    expect((await pub('get', `/public/pay/AAAAAAAAAA`, l.token)).status).toBe(404);
    const r = await pub('get', `/public/pay/${l.code}`, l.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['x-robots-tag']).toBe('noindex');
    expect(r.body.data).toMatchObject({ unitLabel: 'A-101', amountPaise: 5_000, status: 'PAYABLE' });
    expect(r.body.data.payerNameMasked).toMatch(/\*/);
    expect(JSON.stringify(r.body)).not.toContain('Sharma');
    expect(Number((await PaymentOrder.findByPk(l.orderId))!.linkOpenedCount)).toBe(1);
  });
  it('checkout creates the gateway order once and reuses it; verify settles; then the page says PAID and checkout is 409', async () => {
    const l = await link(5_000);
    const c1 = await pub('post', `/public/pay/${l.code}/checkout`, l.token, {});
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    const c2 = await pub('post', `/public/pay/${l.code}/checkout`, undefined, { token: l.token });
    expect(c2.body.data.checkout.gatewayOrderId).toBe(c1.body.data.checkout.gatewayOrderId);
    expect(gw.orders.size).toBe(1);
    const p = gw.payOrder(c1.body.data.checkout.gatewayOrderId);
    const v = await pub('post', `/public/pay/${l.code}/verify`, l.token, { gatewayPaymentId: p.paymentId });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data).toMatchObject({ status: 'PAID', payment: { amountPaise: 5_000 } });
    expect((await pub('get', `/public/pay/${l.code}`, l.token)).body.data.status).toBe('PAID');
    expect((await pub('post', `/public/pay/${l.code}/checkout`, l.token, {})).body.code).toBe(
      'INVALID_STATE',
    );
    const pay = (await Payment.findOne({ where: { paymentOrderId: l.orderId } }))!;
    expect([pay.payerUserId, pay.status]).toEqual([null, 'CAPTURED']);
  });
  it('an expired link is 410 PAYMENT_LINK_EXPIRED; a gateway failure is 502 and the link stays usable', async () => {
    const l = await link();
    gw.failNext.createOrder = true;
    const bad = await pub('post', `/public/pay/${l.code}/checkout`, l.token, {});
    expect([bad.status, bad.body.code]).toEqual([502, 'GATEWAY_ERROR']);
    expect((await PaymentOrder.findByPk(l.orderId))!.status).toBe('CREATED');
    expect((await pub('post', `/public/pay/${l.code}/checkout`, l.token, {})).status).toBe(200);
    setNow(addDays(new Date('2026-11-04T04:30:00Z'), 8));
    const gone = await pub('get', `/public/pay/${l.code}`, l.token);
    expect([gone.status, gone.body.code]).toEqual([410, 'PAYMENT_LINK_EXPIRED']);
    expect((await pub('post', `/public/pay/${l.code}/checkout`, l.token, {})).status).toBe(410);
  });
  it('a closed society is 423, a suspended one still works; rate limit 10 per minute per code', async () => {
    const l = await link();
    await setSocietyStatus(x.w.society.id!, 'SUSPENDED');
    expect((await pub('get', `/public/pay/${l.code}`, l.token)).status).toBe(200);
    await setSocietyStatus(x.w.society.id!, 'CLOSED');
    expect((await pub('post', `/public/pay/${l.code}/checkout`, l.token, {})).status).toBe(423);
    await setSocietyStatus(x.w.society.id!, 'ACTIVE');
    await resetRateLimits();
    const rs = [];
    for (let i = 0; i < 12; i++) rs.push((await pub('get', `/public/pay/${l.code}`, l.token)).status);
    expect(rs.filter(s => s === 429).length).toBeGreaterThan(0);
  });
  it('a cancelled link shows CANCELLED and cannot be paid', async () => {
    const l = await link();
    await x.w.c('post', `/payment-orders/${l.orderId}/cancel`, { reason: 'Issued by mistake' });
    expect((await pub('get', `/public/pay/${l.code}`, l.token)).body.data.status).toBe('CANCELLED');
    expect((await pub('post', `/public/pay/${l.code}/checkout`, l.token, {})).body.code).toBe(
      'INVALID_STATE',
    );
  });
  it('expire-links job expires past-due links', async () => {
    const l = await link();
    setNow(addDays(new Date('2026-11-04T04:30:00Z'), 8));
    expect(await expireLinks()).toBe(1);
    expect((await PaymentOrder.findByPk(l.orderId))!.status).toBe('EXPIRED');
  });
});

describe('payments.createOrder, hooks and the reconcile job (8.26, 6.7)', () => {
  const create = async (invoiceIds: number[], o: Record<string, unknown> = {}) =>
    payments.createOrder(sysCtx(x.w), {
      unitId: x.unitId,
      invoiceIds,
      sourceModule: '18',
      refType: 'booking',
      refId: 123,
      dedupeKey: 'booking:123',
      ...o,
    } as never);

  it('creates a MODULE order for open invoices; the same dedupeKey returns the same order; other invoices are DUPLICATE_ORDER', async () => {
    const a = await mkInvoice(x.w, 0, 50_000, '2026-11-20');
    const b = await mkInvoice(x.w, 0, 70_000, '2026-11-20');
    const r = await create([Number(a.id)]);
    expect(r).toMatchObject({ status: 'CREATED', grossAmountPaise: 50_000 });
    expect(r.checkout!.gatewayOrderId).toBeTruthy();
    const again = await create([Number(a.id)]);
    expect(again.orderId).toBe(r.orderId);
    expect(again.checkout!.gatewayOrderId).toBe(r.checkout!.gatewayOrderId);
    await expect(create([Number(b.id)])).rejects.toMatchObject({ code: 'DUPLICATE_ORDER', status: 409 });
    await expect(create([Number(a.id)], { dedupeKey: 'Bad Key' })).rejects.toMatchObject({ status: 400 });
    await expect(create([999999], { dedupeKey: 'booking:2' })).rejects.toMatchObject({
      code: 'PAYABLE_NOT_FOUND',
    });
    await expect(create([], { dedupeKey: 'booking:3' })).rejects.toMatchObject({ status: 400 });
    const dto = await payments.getOrder(x.w.society.id!, r.orderId);
    expect(dto).toMatchObject({ id: r.orderId, sourceType: 'MODULE', refType: 'booking', refId: 123 });
    expect(await payments.getOrder(x.w.society.id! + 999, r.orderId)).toBeNull();
  });
  it('onPaid runs inside the capture; T12-14 the reconcile job settles a pending order when the gateway later captured', async () => {
    const calls: string[] = [];
    payments.registerOrderHook('booking', { onPaid: async (_c, o) => void calls.push(`paid:${o.id}`) });
    const a = await mkInvoice(x.w, 0, 50_000, '2026-11-20');
    const r = await create([Number(a.id)]);
    gw.payOrder(r.checkout!.gatewayOrderId);
    setNow(new Date('2026-11-04T04:36:00Z')); // after the first check at +3 minutes
    expect(await reconcileDueOrders()).toEqual({ checked: 1, failed: 0 });
    expect((await PaymentOrder.findByPk(r.orderId))!.status).toBe('PAID');
    expect(calls).toEqual([`paid:${r.orderId}`]);
    await drainQueues();
  });
  it('T12-15 reconcile expires an order past expiresAt with no payment and calls onExpired; earlier it only reschedules', async () => {
    const expired: number[] = [];
    payments.registerOrderHook('booking', {
      onPaid: async () => undefined,
      onExpired: async (_c, o) => void expired.push(Number(o.id)),
    });
    const a = await mkInvoice(x.w, 0, 50_000, '2026-11-20');
    const r = await create([Number(a.id)], { expiresInMinutes: 10 });
    setNow(new Date('2026-11-04T04:35:00Z'));
    await reconcileDueOrders();
    const mid = (await PaymentOrder.findByPk(r.orderId))!;
    expect(mid.status).toBe('CREATED');
    expect(mid.nextCheckAt!.getTime()).toBeGreaterThan(new Date('2026-11-04T04:35:00Z').getTime());
    setNow(new Date('2026-11-04T05:30:00Z'));
    await PaymentOrder.update(
      { nextCheckAt: new Date('2026-11-04T05:00:00Z') },
      { where: { id: r.orderId } },
    );
    await reconcileDueOrders();
    expect((await PaymentOrder.findByPk(r.orderId))!.status).toBe('EXPIRED');
    expect(expired).toEqual([r.orderId]);
  });
  it('a late capture on an EXPIRED order is still settled by verify (money never ignored)', async () => {
    const a = await mkInvoice(x.w, 0, 50_000, '2026-11-20');
    const r = await create([Number(a.id)], { expiresInMinutes: 5 });
    setNow(new Date('2026-11-04T06:30:00Z'));
    await PaymentOrder.update(
      { nextCheckAt: new Date('2026-11-04T05:00:00Z') },
      { where: { id: r.orderId } },
    );
    await reconcileDueOrders();
    expect((await PaymentOrder.findByPk(r.orderId))!.status).toBe('EXPIRED');
    const v = await call(
      'post',
      `/dev/payments/${r.checkout!.gatewayOrderId}/pay`,
      { status: 'success' },
      { origin: null },
    );
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data.orderStatus).toBe('PAID');
    expect(Number((await Invoice.findByPk(a.id))!.outstandingPaise)).toBe(0);
  });
  it('a reconcile gateway failure reschedules instead of losing the order', async () => {
    const a = await mkInvoice(x.w, 0, 50_000, '2026-11-20');
    const r = await create([Number(a.id)]);
    setNow(new Date('2026-11-04T04:40:00Z'));
    const orig = gw.fetchOrderPayments.bind(gw);
    gw.fetchOrderPayments = async () => {
      throw new Error('down');
    };
    expect(await reconcileDueOrders()).toEqual({ checked: 1, failed: 1 });
    gw.fetchOrderPayments = orig;
    const o = (await PaymentOrder.findByPk(r.orderId))!;
    expect(o.status).toBe('CREATED');
    expect(o.nextCheckAt!.getTime()).toBeGreaterThan(new Date('2026-11-04T04:40:00Z').getTime());
  });
  it('F23 recovery nudge: ATTEMPTED unpaid order, once, only when the plan has the feature', async () => {
    await mkInvoice(x.w, 0, 100_000, '2026-11-20');
    const v = (await x.payer.c('get', `/me/payables?unitId=${x.unitId}`)).body.data.payListVersion;
    const r = await x.payer.c(
      'post',
      '/me/payables/payment-orders',
      { unitId: x.unitId, allocationMode: 'OLDEST_FIRST', duesAmountPaise: 100_000, payListVersion: v },
      { headers: idem() },
    );
    expect(await sendRecoveryNudges()).toBe(0); // CREATED and young
    const bad = gw.payOrder(r.body.data.checkout.gatewayOrderId, { status: 'failed' });
    await x.payer.c('post', `/me/payables/payment-orders/${r.body.data.orderId}/verify`, {
      gatewayPaymentId: bad.paymentId,
    });
    expect(await sendRecoveryNudges()).toBe(1);
    expect(await sendRecoveryNudges()).toBe(0);
    expect(
      paymentsPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.checkout_abandoned',
      ),
    ).toBe(true);
    advance(1);
  });
  it("onUnitLinkEnded cancels the payer's open orders of that unit; a later capture goes to advance for review", async () => {
    await mkInvoice(x.w, 0, 100_000, '2026-11-20');
    const v = (await x.payer.c('get', `/me/payables?unitId=${x.unitId}`)).body.data.payListVersion;
    const r = await x.payer.c(
      'post',
      '/me/payables/payment-orders',
      { unitId: x.unitId, allocationMode: 'OLDEST_FIRST', duesAmountPaise: 100_000, payListVersion: v },
      { headers: idem() },
    );
    const n = await sequelize.transaction(t =>
      payments
        .onUnitLinkEnded(sysCtx(x.w), x.unitId, x.payer.user.id, t)
        .then(() => cancelOrdersForUnitLink(sysCtx(x.w), x.unitId, x.payer.user.id, t)),
    );
    expect(n).toBe(0); // already cancelled by the first call
    expect((await PaymentOrder.findByPk(r.body.data.orderId))!.status).toBe('CANCELLED');
    const p = gw.payOrder(r.body.data.checkout.gatewayOrderId);
    await x.payer.c('post', `/me/payables/payment-orders/${r.body.data.orderId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    const pay = (await Payment.findOne({ where: { paymentOrderId: r.body.data.orderId } }))!;
    expect([Boolean(pay.needsReview), Number(pay.toAdvancePaise)]).toEqual([true, 100_000]);
  });
});

describe('development routes', () => {
  async function order() {
    await mkInvoice(x.w, 0, 100_000, '2026-11-20');
    const v = (await x.payer.c('get', `/me/payables?unitId=${x.unitId}`)).body.data.payListVersion;
    const r = await x.payer.c(
      'post',
      '/me/payables/payment-orders',
      { unitId: x.unitId, allocationMode: 'OLDEST_FIRST', duesAmountPaise: 100_000, payListVersion: v },
      { headers: idem() },
    );
    return { id: r.body.data.orderId as number, go: r.body.data.checkout.gatewayOrderId as string };
  }
  it('POST /dev/payments/:gatewayOrderId/pay {status:success} captures through the webhook path; verify then reports PAID', async () => {
    const o = await order();
    const r = await call('post', `/dev/payments/${o.go}/pay`, { status: 'success' }, { origin: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      orderId: o.go,
      status: 'captured',
      amountPaise: 100_000,
      paymentOrderId: o.id,
      orderStatus: 'PAID',
      eventStatus: 'PROCESSED',
    });
    const v = await x.payer.c('post', `/me/payables/payment-orders/${o.id}/verify`, {
      gatewayPaymentId: r.body.data.gatewayPaymentId,
    });
    expect(v.body.data.status).toBe('PAID');
    expect(await Payment.count({ where: { paymentOrderId: o.id } })).toBe(1);
  });
  it('{status:fail} makes the order ATTEMPTED; the simulate alias takes the payment order id and an outcome', async () => {
    const o = await order();
    const f = await call('post', `/dev/payments/${o.go}/pay`, { status: 'fail' }, { origin: null });
    expect(f.body.data).toMatchObject({ status: 'failed', orderStatus: 'ATTEMPTED' });
    const s = await call(
      'post',
      `/dev/payments/orders/${o.id}/simulate`,
      { outcome: 'success' },
      { origin: null },
    );
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.data).toMatchObject({ paymentOrderId: o.id, orderStatus: 'PAID' });
    expect(
      (await call('post', `/dev/payments/${o.go}/pay`, { status: 'maybe' }, { origin: null })).status,
    ).toBe(400);
    expect((await call('post', '/dev/payments/order_unknown/pay', {}, { origin: null })).status).toBe(404);
  });
  it('still pays a plain (platform) fake order and leaves it to the app to verify', async () => {
    const po = await gw.createOrder({
      societyGatewayAccountId: 'platform',
      amountPaise: 1_000,
      receipt: 'r',
      notes: {},
    });
    const r = await call('post', `/dev/payments/${po.orderId}/pay`, {}, { origin: null });
    expect(r.body.data).toMatchObject({ orderId: po.orderId, status: 'captured', amountPaise: 1_000 });
    expect(r.body.data.paymentOrderId).toBeUndefined();
    await setSetting(x.w.society.id!, 'payments.orderExpiryMinutes', 30);
  });
});
