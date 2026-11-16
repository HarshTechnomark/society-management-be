import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Collection,
  CollectionRequest,
  Invoice,
  Payment,
  PaymentAllocation,
  PaymentOrder,
  closeDb,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { setNow } from '../../../src/lib/clock';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { grossUp } from '../../../src/modules/payments/payments.orders.fee';
import { payListVersionOf } from '../../../src/modules/payments/payments.orders.payables';
import { paymentsPortCalls, setPaymentsPorts } from '../../../src/modules/payments/payments.ports';
import { residentUser } from '../../helpers/residents';
import { paymentsWorld } from '../../helpers/payments';
import { setSetting } from '../../helpers/billing-runs';
import {
  idem,
  mkInvoice,
  mkRequest,
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
  await resetRateLimits();
  x = await onlineWorld(gw);
});

const payables = async (c = x.payer.c, unitId = x.unitId) =>
  (await c('get', `/me/payables?unitId=${unitId}`)).body;
const orderBody = (v: string, o: Record<string, unknown> = {}) => ({
  unitId: x.unitId,
  allocationMode: 'OLDEST_FIRST',
  duesAmountPaise: 800_900,
  payListVersion: v,
  ...o,
});
async function twoInvoices() {
  const a = await mkInvoice(x.w, 0, 120_000, '2026-11-04');
  const b = await mkInvoice(x.w, 0, 680_900, '2026-11-20');
  return { a, b };
}
async function place(body: Record<string, unknown>, headers = idem()) {
  return x.payer.c('post', '/me/payables/payment-orders', body, { headers });
}

describe('unit: fee and pay list version', () => {
  it('T12-01 grosses the fee up (card 180 bp, base 680,900)', () => {
    expect(grossUp(680_900, 180)).toEqual({
      basePaise: 680_900,
      grossPaise: 695_677,
      feePaise: 12_523,
      feeGstPaise: 2_254,
    });
    expect(grossUp(100_000, 0)).toEqual({
      basePaise: 100_000,
      grossPaise: 100_000,
      feePaise: 0,
      feeGstPaise: 0,
    });
  });
  it('gross never leaves the society short of the base after the gateway takes its cut', () => {
    for (const base of [100, 999, 12_345, 680_900, 99_999_999])
      for (const bp of [120, 180, 190]) {
        const g = grossUp(base, bp);
        expect(g.grossPaise - g.feePaise - g.feeGstPaise).toBe(base);
        expect(g.grossPaise * (1 - (bp * 1.18) / 10_000)).toBeGreaterThanOrEqual(base - 1);
      }
  });
  it('T12-03 the version is the same for the same items in any order', () => {
    const a = [
      { type: 'INVOICE' as const, id: 1, amountPaise: 5 },
      { type: 'COLLECTION_REQUEST' as const, id: 2, amountPaise: 0 },
    ];
    expect(payListVersionOf(a)).toBe(payListVersionOf([...a].reverse()));
    expect(payListVersionOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(payListVersionOf(a)).not.toBe(payListVersionOf([{ ...a[0]!, amountPaise: 6 }, a[1]!]));
  });
});

describe('GET /me/payables (8.2)', () => {
  it('lists open invoices, requests, totals, fee settings and gateway state', async () => {
    const { a, b } = await twoInvoices();
    const { request } = await mkRequest(x.w, x.unitId);
    const r = await x.payer.c('get', `/me/payables?unitId=${x.unitId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d.unit).toEqual({ id: x.unitId, label: 'A-101' });
    expect(d.items.map((i: any) => [i.type, i.id])).toEqual([
      ['INVOICE', Number(a.id)],
      ['INVOICE', Number(b.id)],
      ['COLLECTION_REQUEST', Number(request.id)],
    ]);
    expect(d.items[0]).toMatchObject({
      outstandingPaise: 120_000,
      isOverdue: false,
      minPaise: 100,
      maxPaise: 120_000,
    });
    expect(d.items[2]).toMatchObject({ minPaise: 100, maxPaise: 10_000_000, paidPaise: 0 });
    expect(d).toMatchObject({
      totalDuesPaise: 800_900,
      advanceBalancePaise: 0,
      allowPartial: true,
      allowAdvance: true,
      gatewayReady: true,
      liveOrder: null,
    });
    expect(d.payListVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(d.fee.mode).toBe('SOCIETY_ABSORBS');
  });
  it("shows rates when the society passes the fee on, and is 404 for a unit that is not the caller's", async () => {
    await setSetting(x.w.society.id!, 'payments.convenienceFeeMode', 'PASS_TO_PAYER');
    const d = (await payables()).data;
    expect(d.fee).toEqual({
      mode: 'PASS_TO_PAYER',
      methods: { UPI: 0, CARD: 180, NETBANKING: 120, WALLET: 190 },
    });
    const r = await x.payer.c('get', `/me/payables?unitId=${x.w.units[1]!.id}`);
    expect([r.status, r.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    expect((await x.payer.c('get', '/me/payables')).status).toBe(400);
  });
  it('gatewayReady is false without an active account (offline instructions shown)', async () => {
    setPaymentsPorts({ gateways: { accountFor: async () => null } });
    const d = (await payables()).data;
    expect(d.gatewayReady).toBe(false);
    expect(d.offlineInstructions).toBeTruthy();
  });
});

describe('POST /me/payables/payment-orders (8.3)', () => {
  it('T12-05 cart of two invoices and a collection request: order, checkout, verify, one payment, three allocations, receipt', async () => {
    const { a, b } = await twoInvoices();
    const { request } = await mkRequest(x.w, x.unitId);
    const v = (await payables()).data.payListVersion;
    const r = await place({
      unitId: x.unitId,
      allocationMode: 'SELECTED',
      items: [
        { type: 'INVOICE', id: Number(a.id), amountPaise: 120_000 },
        { type: 'INVOICE', id: Number(b.id), amountPaise: 680_900 },
        { type: 'COLLECTION_REQUEST', id: Number(request.id), amountPaise: 110_000 },
      ],
      payListVersion: v,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = r.body.data;
    expect(d).toMatchObject({
      status: 'CREATED',
      basePaise: 910_900,
      convenienceFeePaise: 0,
      grossAmountPaise: 910_900,
    });
    expect(d.lines).toHaveLength(3);
    expect(d.checkout).toMatchObject({ provider: 'FAKE', methods: ['UPI', 'CARD', 'NETBANKING', 'WALLET'] });
    expect(d.checkout.gatewayOrderId).toBe(d.checkout.order_id);
    expect(d.checkout.upiIntentUrl).toContain('upi://pay');
    expect(gw.orders.get(d.checkout.gatewayOrderId)!.amountPaise).toBe(910_900);
    const p = gw.payOrder(d.checkout.gatewayOrderId);
    const ver = await x.payer.c('post', `/me/payables/payment-orders/${d.orderId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect(ver.status, JSON.stringify(ver.body)).toBe(200);
    expect(ver.body.data).toMatchObject({
      orderId: d.orderId,
      status: 'PAID',
      payment: { amountPaise: 910_900 },
    });
    expect(ver.body.data.payment.receiptNo).toMatch(/^RCT\/2026-27\//);
    expect(ver.body.data.message).toContain('added to');
    const pays = await Payment.findAll({ where: { paymentOrderId: d.orderId } });
    expect(pays).toHaveLength(1);
    expect(await PaymentAllocation.count({ where: { paymentId: pays[0]!.id } })).toBe(3);
    expect((await CollectionRequest.findByPk(request.id))!.status).toBe('PAID');
    expect(Number((await Invoice.findByPk(a.id))!.outstandingPaise)).toBe(0);
    const j = paymentsPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any)[0];
    expect(j.lines.find((l: any) => l.accountCode === 'GATEWAY_CLEARING').debitPaise).toBe(910_900);
    const again = await x.payer.c('get', `/me/payment-orders/${d.orderId}`);
    expect(again.body.data.status).toBe('PAID');
    expect(again.body.data.lines).toHaveLength(3);
    expect(await Collection.count()).toBe(1);
  });

  it('OLDEST_FIRST with money above dues puts the rest to advance on capture (T12-02 through the API)', async () => {
    await twoInvoices();
    const v = (await payables()).data.payListVersion;
    const r = await place(orderBody(v, { duesAmountPaise: 900_000 }));
    expect(r.status).toBe(201);
    const p = gw.payOrder(r.body.data.checkout.gatewayOrderId);
    await x.payer.c('post', `/me/payables/payment-orders/${r.body.data.orderId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    const pay = (await Payment.findOne({ where: { paymentOrderId: r.body.data.orderId } }))!;
    expect([Number(pay.toInvoicesPaise), Number(pay.toAdvancePaise)]).toEqual([800_900, 99_100]);
  });

  it('T12-06 the same Idempotency-Key twice makes one order and replays', async () => {
    await twoInvoices();
    const v = (await payables()).data.payListVersion;
    const h = idem();
    const a = await place(orderBody(v), h);
    const b = await place(orderBody(v), h);
    expect(a.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.orderId).toBe(a.body.data.orderId);
    expect(await PaymentOrder.count({ where: { unitId: x.unitId } })).toBe(1);
    expect(gw.orders.size).toBe(1);
    expect((await x.payer.c('post', '/me/payables/payment-orders', orderBody(v))).status).toBe(400); // key required
  });

  it('T12-07 a live order blocks a new one with the order id; cancelling frees it', async () => {
    await twoInvoices();
    const v = (await payables()).data.payListVersion;
    const a = await place(orderBody(v));
    const b = await place(orderBody(v));
    expect([b.status, b.body.code]).toEqual([409, 'PAYMENT_IN_PROGRESS']);
    expect(b.body.errors[0].orderId).toBe(a.body.data.orderId);
    const live = (await payables()).data.liveOrder;
    expect(live).toMatchObject({ orderId: a.body.data.orderId, status: 'CREATED' });
    expect(live.checkout.gatewayOrderId).toBe(a.body.data.checkout.gatewayOrderId);
    const c = await x.payer.c('post', `/me/payment-orders/${a.body.data.orderId}/cancel`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.status).toBe('CANCELLED');
    expect((await place(orderBody(v))).status).toBe(201);
  });

  it('T12-08 a changed pay list is refused before any gateway call', async () => {
    const { a } = await twoInvoices();
    const v = (await payables()).data.payListVersion;
    await Invoice.update({ paidPaise: 20_000, outstandingPaise: 100_000 }, { where: { id: a.id } });
    const r = await place(orderBody(v));
    expect([r.status, r.body.code]).toEqual([409, 'PAYABLE_CHANGED']);
    expect(gw.orders.size).toBe(0);
  });

  it('refuses amounts and items by the rules of 8.3', async () => {
    const { a } = await twoInvoices();
    const v = (await payables()).data.payListVersion;
    const sel = (items: unknown[], o: Record<string, unknown> = {}) =>
      place({ unitId: x.unitId, allocationMode: 'SELECTED', items, payListVersion: v, ...o });
    const inv = (amountPaise: number, id = Number(a.id)) => ({ type: 'INVOICE', id, amountPaise });
    expect((await sel([inv(120_001)])).body.code).toBe('AMOUNT_EXCEEDS_DUE');
    expect((await sel([inv(50)])).body.code).toBe('AMOUNT_BELOW_MINIMUM');
    expect((await sel([inv(0)])).body.code).toBe('NOTHING_TO_PAY');
    expect((await sel([inv(100, 999999)])).body.code).toBe('PAYABLE_NOT_FOUND');
    expect((await sel([inv(1000), inv(1000)])).status).toBe(400);
    expect((await place(orderBody(v, { duesAmountPaise: 100_000_001 }))).body.code).toBe('AMOUNT_TOO_LARGE');
    expect((await place(orderBody(v, { duesAmountPaise: 99 }))).body.code).toBe('AMOUNT_BELOW_MINIMUM');
    expect((await place(orderBody(v, { items: [inv(10_000)] }))).status).toBe(400); // INVOICE items only in SELECTED
    expect((await place({ ...orderBody(v), duesAmountPaise: undefined })).status).toBe(400);
    expect(gw.orders.size).toBe(0);
  });

  it('BR-12-17 partial and advance switches', async () => {
    const { a } = await twoInvoices();
    const v = (await payables()).data.payListVersion;
    await setSetting(x.w.society.id!, 'payments.allowPartialPayments', false);
    const partial = await place({
      unitId: x.unitId,
      allocationMode: 'SELECTED',
      items: [{ type: 'INVOICE', id: Number(a.id), amountPaise: 50_000 }],
      payListVersion: v,
    });
    expect(partial.body.code).toBe('PARTIAL_NOT_ALLOWED');
    expect((await place(orderBody(v, { duesAmountPaise: 150_000 }))).body.code).toBe('PARTIAL_NOT_ALLOWED');
    expect((await place(orderBody(v, { duesAmountPaise: 120_000 }))).status).toBe(201);
    await x.payer.c('post', `/me/payment-orders/${(await PaymentOrder.findOne())!.id}/cancel`);
    await setSetting(x.w.society.id!, 'payments.allowAdvancePayments', false);
    expect((await place(orderBody(v, { duesAmountPaise: 900_000 }))).body.code).toBe('ADVANCE_NOT_ALLOWED');
    const adv = await place({
      unitId: x.unitId,
      allocationMode: 'SELECTED',
      items: [{ type: 'INVOICE', id: Number(a.id), amountPaise: 120_000 }],
      advancePaise: 5_000,
      payListVersion: v,
    });
    expect(adv.body.code).toBe('ADVANCE_NOT_ALLOWED');
  });

  it('collection request amounts follow BR-12-18 (T12-04)', async () => {
    const { request } = await mkRequest(x.w, x.unitId, {
      amountMode: 'MIN_PER_UNIT',
      amountPaise: 50_100,
      minPaise: 50_100,
      title: 'Repairs',
    });
    const v = (await payables()).data.payListVersion;
    const pay = (amountPaise: number) =>
      place({
        unitId: x.unitId,
        allocationMode: 'SELECTED',
        items: [{ type: 'COLLECTION_REQUEST', id: Number(request.id), amountPaise }],
        payListVersion: v,
      });
    expect((await pay(50_000)).body.code).toBe('AMOUNT_BELOW_MINIMUM');
    expect((await pay(10_000_001)).body.code).toBe('AMOUNT_EXCEEDS_DUE');
    expect((await pay(50_100)).status).toBe(201);
  });

  it('BR-12-37/38 pass-through fee: method required, fee grossed up, gateway gets the gross', async () => {
    await mkInvoice(x.w, 0, 680_900, '2026-11-20');
    await setSetting(x.w.society.id!, 'payments.convenienceFeeMode', 'PASS_TO_PAYER');
    const v = (await payables()).data.payListVersion;
    const body = orderBody(v, { duesAmountPaise: 680_900 });
    expect((await place(body)).status).toBe(400);
    const r = await place({ ...body, methodHint: 'CARD' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      basePaise: 680_900,
      convenienceFeePaise: 12_523,
      convenienceFeeGstPaise: 2_254,
      grossAmountPaise: 695_677,
    });
    expect(r.body.data.checkout.methods).toEqual(['CARD']);
    expect(gw.orders.get(r.body.data.checkout.gatewayOrderId)!.amountPaise).toBe(695_677);
    const p = gw.payOrder(r.body.data.checkout.gatewayOrderId, { method: 'card' });
    await x.payer.c('post', `/me/payables/payment-orders/${r.body.data.orderId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    const pay = (await Payment.findOne({ where: { paymentOrderId: r.body.data.orderId } }))!;
    expect([
      Number(pay.amountPaise),
      Number(pay.convenienceFeePaise),
      Number(pay.grossAmountPaise),
      pay.method,
    ]).toEqual([680_900, 12_523, 695_677, 'CARD']);
  });

  it('UPI is free even when the fee is passed on; a method not enabled on the account is refused', async () => {
    await mkInvoice(x.w, 0, 100_000, '2026-11-20');
    await setSetting(x.w.society.id!, 'payments.convenienceFeeMode', 'PASS_TO_PAYER');
    const v = (await payables()).data.payListVersion;
    const upi = await place(orderBody(v, { duesAmountPaise: 100_000, methodHint: 'UPI' }));
    expect(upi.body.data.grossAmountPaise).toBe(100_000);
    await x.payer.c('post', `/me/payment-orders/${upi.body.data.orderId}/cancel`);
    setPaymentsPorts({
      gateways: {
        accountFor: async id => ({
          id,
          societyId: id,
          provider: 'FAKE',
          enabledMethods: ['UPI'],
          supportsMandates: false,
          webhookSecret: 's',
          isActive: true,
        }),
      },
    });
    const card = await place(orderBody(v, { duesAmountPaise: 100_000, methodHint: 'CARD' }));
    expect([card.status, card.body.code]).toEqual([422, 'METHOD_NOT_ENABLED']);
  });

  it('no active gateway account is 422 GATEWAY_NOT_CONFIGURED; a gateway failure is 502 and the order FAILED', async () => {
    await mkInvoice(x.w, 0, 100_000, '2026-11-20');
    const v = (await payables()).data.payListVersion;
    gw.failNext.createOrder = true;
    const bad = await place(orderBody(v, { duesAmountPaise: 100_000 }));
    expect([bad.status, bad.body.code]).toEqual([502, 'GATEWAY_ERROR']);
    expect((await PaymentOrder.findOne({ where: { unitId: x.unitId } }))!.status).toBe('FAILED');
    expect((await place(orderBody(v, { duesAmountPaise: 100_000 }))).status).toBe(201); // retry with a new key
    setPaymentsPorts({ gateways: { accountFor: async () => null } });
    const none = await x.other.c(
      'post',
      '/me/payables/payment-orders',
      { ...orderBody(v), unitId: x.w.units[1]!.id },
      { headers: idem() },
    );
    expect([none.status, none.body.code]).toEqual([422, 'GATEWAY_NOT_CONFIGURED']);
  });

  it('another unit is 404, and an order id of another unit is not visible', async () => {
    await mkInvoice(x.w, 0, 100_000, '2026-11-20');
    const v = (await payables()).data.payListVersion;
    const o = await place(orderBody(v, { duesAmountPaise: 100_000 }));
    expect(
      (await x.other.c('post', '/me/payables/payment-orders', orderBody(v), { headers: idem() })).body.code,
    ).toBe('UNIT_NOT_FOUND');
    for (const path of [`/me/payment-orders/${o.body.data.orderId}`])
      expect((await x.other.c('get', path)).body.code).toBe('PAYMENT_ORDER_NOT_FOUND');
    expect(
      (
        await x.other.c('post', `/me/payables/payment-orders/${o.body.data.orderId}/verify`, {
          gatewayPaymentId: 'pay_abcdef12',
        })
      ).status,
    ).toBe(404);
    expect((await x.other.c('post', `/me/payment-orders/${o.body.data.orderId}/cancel`)).status).toBe(404);
  });
});

describe('verify and cancel (8.4)', () => {
  async function liveOrder() {
    await mkInvoice(x.w, 0, 100_000, '2026-11-20');
    const v = (await payables()).data.payListVersion;
    const r = await place(orderBody(v, { duesAmountPaise: 100_000 }));
    return { id: r.body.data.orderId as number, go: r.body.data.checkout.gatewayOrderId as string };
  }
  it('BR-12-8 a payment of another gateway order is PAYMENT_MISMATCH; an unknown payment is 502', async () => {
    const o = await liveOrder();
    const other = await gw.createOrder({
      societyGatewayAccountId: '1',
      amountPaise: 100_000,
      receipt: 'x',
      notes: {},
    });
    const p = gw.payOrder(other.orderId);
    const r = await x.payer.c('post', `/me/payables/payment-orders/${o.id}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect([r.status, r.body.code]).toEqual([422, 'PAYMENT_MISMATCH']);
    const g = await x.payer.c('post', `/me/payables/payment-orders/${o.id}/verify`, {
      gatewayPaymentId: 'pay_doesnotexist',
    });
    expect([g.status, g.body.code]).toEqual([502, 'GATEWAY_ERROR']);
    expect(
      (await x.payer.c('post', `/me/payables/payment-orders/${o.id}/verify`, { gatewayPaymentId: 'x' }))
        .status,
    ).toBe(400);
  });
  it('a failed attempt makes the order ATTEMPTED (still payable) and a later capture settles it', async () => {
    const o = await liveOrder();
    const bad = gw.payOrder(o.go, { status: 'failed' });
    const r = await x.payer.c('post', `/me/payables/payment-orders/${o.id}/verify`, {
      gatewayPaymentId: bad.paymentId,
    });
    expect(r.body.data).toMatchObject({ status: 'ATTEMPTED', payment: null });
    expect(Number((await PaymentOrder.findByPk(o.id))!.attemptCount)).toBe(1);
    const good = gw.payOrder(o.go);
    const r2 = await x.payer.c('post', `/me/payables/payment-orders/${o.id}/verify`, {
      gatewayPaymentId: good.paymentId,
    });
    expect(r2.body.data.status).toBe('PAID');
  });
  it('verify on a FAILED order is INVALID_STATE', async () => {
    const o = await liveOrder();
    await PaymentOrder.update({ status: 'FAILED' }, { where: { id: o.id } });
    const p = gw.payOrder(o.go);
    expect(
      (
        await x.payer.c('post', `/me/payables/payment-orders/${o.id}/verify`, {
          gatewayPaymentId: p.paymentId,
        })
      ).body.code,
    ).toBe('INVALID_STATE');
  });
  it('cancel finds a capture at the gateway: settles instead and answers 409 INVALID_STATE', async () => {
    const o = await liveOrder();
    gw.payOrder(o.go);
    const r = await x.payer.c('post', `/me/payment-orders/${o.id}/cancel`);
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    expect(r.body.errors[0].status).toBe('PAID');
    expect((await PaymentOrder.findByPk(o.id))!.status).toBe('PAID');
    expect((await x.payer.c('post', `/me/payment-orders/${o.id}/cancel`)).body.code).toBe('INVALID_STATE');
  });
  it("a co-owner cannot cancel another member's checkout of the same flat", async () => {
    const o = await liveOrder();
    const sib = await residentUser(x.w.society, x.unitId, { name: 'Co Owner', relation: 'CO_OWNER' });
    expect((await sib.c('get', `/me/payment-orders/${o.id}`)).status).toBe(200);
    expect((await sib.c('post', `/me/payment-orders/${o.id}/cancel`)).status).toBe(404);
  });
  it('T12-39 order, verify and cancel run while the society is SUSPENDED', async () => {
    const { a } = await twoInvoices();
    const v = (await payables()).data.payListVersion;
    await setSocietyStatus(x.w.society.id!, 'SUSPENDED');
    const r = await place(orderBody(v, { duesAmountPaise: 120_000 }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const p = gw.payOrder(r.body.data.checkout.gatewayOrderId);
    expect(
      (
        await x.payer.c('post', `/me/payables/payment-orders/${r.body.data.orderId}/verify`, {
          gatewayPaymentId: p.paymentId,
        })
      ).status,
    ).toBe(200);
    const v2 = (await payables()).data.payListVersion;
    const r2 = await place(orderBody(v2, { duesAmountPaise: 100_000 }));
    expect(r2.status).toBe(201);
    expect((await x.payer.c('post', `/me/payment-orders/${r2.body.data.orderId}/cancel`)).status).toBe(200);
    expect(a.id).toBeTruthy();
    await setSocietyStatus(x.w.society.id!, 'CLOSED');
    expect((await place(orderBody(v2, { duesAmountPaise: 100_000 }))).status).toBe(423);
  });
});

describe('admin order routes (8.16)', () => {
  async function mkOrders() {
    await mkInvoice(x.w, 0, 100_000, '2026-11-20');
    const v = (await payables()).data.payListVersion;
    const r = await place(orderBody(v, { duesAmountPaise: 100_000 }));
    return { id: r.body.data.orderId as number, go: r.body.data.checkout.gatewayOrderId as string };
  }
  it('lists with filters, shows detail with payments, and the finance roles may read', async () => {
    const o = await mkOrders();
    const t = x.w.treasurer.c;
    const list = await t('get', '/payment-orders?status=CREATED&sourceType=PAY_LIST');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data[0]).toMatchObject({
      id: o.id,
      unitLabel: 'A-101',
      sourceType: 'PAY_LIST',
      status: 'CREATED',
      grossAmountPaise: 100_000,
      attemptCount: 0,
    });
    expect(list.body.pagination.total).toBe(1);
    expect((await t('get', '/payment-orders?sourceType=PAYMENT_LINK')).body.data).toHaveLength(0);
    expect((await t('get', '/payment-orders?status=NOPE')).status).toBe(400);
    const d = await t('get', `/payment-orders/${o.id}`);
    expect(d.body.data).toMatchObject({
      id: o.id,
      payerName: 'Rohan Sharma',
      gatewayOrderId: o.go,
      payments: [],
    });
    expect((await x.payer.c('get', '/payment-orders')).status).toBe(403);
  });
  it('cancel needs a reason and frees the order; check settles a captured one (once a minute)', async () => {
    const o = await mkOrders();
    const c = x.w.c;
    expect((await c('post', `/payment-orders/${o.id}/cancel`, { reason: 'x' })).status).toBe(400);
    gw.payOrder(o.go);
    const chk = await c('post', `/payment-orders/${o.id}/check`);
    expect(chk.status, JSON.stringify(chk.body)).toBe(200);
    expect(chk.body.data.status).toBe('PAID');
    expect(chk.body.data.payments).toHaveLength(1);
    expect((await c('post', `/payment-orders/${o.id}/check`)).status).toBe(429);
    const bad = await c('post', `/payment-orders/${o.id}/cancel`, { reason: 'Wrong flat chosen' });
    expect([bad.status, bad.body.code]).toEqual([409, 'INVALID_STATE']);
  });
  it("cancel works on an open order, and another society's order is 404", async () => {
    const o = await mkOrders();
    const r = await x.w.c('post', `/payment-orders/${o.id}/cancel`, { reason: 'Payer asked to stop' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Payer asked to stop' });
    const w2 = await paymentsWorld({ flats: 1 });
    for (const path of [`/payment-orders/${o.id}`])
      expect((await w2.c('get', path)).body.code).toBe('PAYMENT_ORDER_NOT_FOUND');
    expect((await w2.c('post', `/payment-orders/${o.id}/check`)).status).toBe(404);
    expect((await w2.c('post', `/payment-orders/${o.id}/cancel`, { reason: 'not mine at all' })).status).toBe(
      404,
    );
  });
  it('check on an order without a gateway order is INVALID_STATE', async () => {
    const o = await mkOrders();
    await PaymentOrder.update({ gatewayOrderId: null }, { where: { id: o.id } });
    expect((await x.w.c('post', `/payment-orders/${o.id}/check`)).body.code).toBe('INVALID_STATE');
    setNow('2026-11-04T04:30:00Z');
  });
});
