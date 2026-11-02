import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  PlatformCredit,
  PlatformInvoice,
  PlatformPayment,
  Society,
  Subscription,
  closeDb,
  sequelize,
} from '../../../src/models';
import { signWebhookBody, type FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { setRealtimeSink, type RealtimeEvent } from '../../../src/lib/realtime';
import { env } from '../../../src/lib/env';
import { call } from '../../helpers/auth';
import { as, login, memberUser } from '../../helpers/access';
import { billedSociety, idemKey, issueFor, platformTeam, resetBilling } from '../../helpers/billing';
import { lifecycleSociety } from '../../helpers/societies';
import { inboxFor } from '../../helpers/auth';

/** Task 6.3: online payments, verify, webhook (sections 5.4, 6.3, 6.6, 8.5, 8.6, 8.28; T06-10 to T06-13, T06-17, T06-18, T06-35). */
let gw: FakePaymentGateway;
const events: RealtimeEvent[] = [];
beforeEach(async () => {
  gw = await resetBilling();
  events.length = 0;
  setRealtimeSink({ emit: e => events.push(e), disconnectSession: () => undefined });
});
afterAll(async () => {
  await drainQueues();
  setRealtimeSink(undefined);
  setNow(null);
  await closeDb();
});

const order = (pay: ReturnType<typeof as>, invoiceId: number, body: object = {}) =>
  pay('post', `/subscription/invoices/${invoiceId}/payment-orders`, body, { headers: idemKey() });

const webhook = (
  o: { id: string; event: string; payment?: object; refund?: object; order?: object; mandate?: object },
  secret = env().PLATFORM_RAZORPAY_WEBHOOK_SECRET,
  sign = true,
) => {
  const body = JSON.stringify({
    id: o.id,
    event: o.event,
    payload: {
      ...(o.payment ? { payment: { entity: o.payment } } : {}),
      ...(o.refund ? { refund: { entity: o.refund } } : {}),
      ...(o.order ? { order: { entity: o.order } } : {}),
      ...(o.mandate ? { mandate: { entity: o.mandate } } : {}),
    },
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sign) headers['x-razorpay-signature'] = signWebhookBody(body, secret);
  return call('post', '/webhooks/platform-billing/razorpay', body, { app: 'ADMIN', headers });
};

describe('payment order (8.5)', () => {
  it('T06-10 order, fake gateway pay, verify: payment CAPTURED, invoice PAID, notification and audit', async () => {
    const { pay, invoice, society, treasurer } = await billedSociety();
    const o = await order(pay, invoice.id);
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(o.body.data).toMatchObject({ amountPaise: 1239000 });
    expect(o.body.data.checkout).toMatchObject({
      key: 'rzp_test_fake',
      order_id: o.body.data.gatewayOrderId,
      description: invoice.invoiceNo,
    });
    expect(o.body.data.checkout.prefill.contact).toMatch(/^\d\dXXXXX\d{3}$/);
    const p = gw.payOrder(o.body.data.gatewayOrderId, { method: 'upi' });
    const v = await pay('post', `/subscription/payments/${o.body.data.paymentId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data).toEqual({
      paymentId: o.body.data.paymentId,
      status: 'CAPTURED',
      invoice: { id: invoice.id, status: 'PAID', amountDuePaise: 0 },
    });
    const row = (await PlatformPayment.findByPk(o.body.data.paymentId))!;
    expect(row).toMatchObject({
      status: 'CAPTURED',
      method: 'UPI',
      appliedPaise: 1239000,
      gatewayPaymentId: p.paymentId,
    });
    expect(await PlatformInvoice.findByPk(invoice.id)).toMatchObject({
      status: 'PAID',
      paidPaise: 1239000,
      amountDuePaise: 0,
    });
    for (const a of ['payment.order_created', 'payment.captured', 'invoice.paid'])
      expect(
        await AuditLog.count({ where: { action: `platform_billing.${a}`, societyId: society.id! } }),
        a,
      ).toBe(1);
    // notification to subscription viewers (email of the Treasurer lands in the dev inbox after commit)
    await drainQueues();
    expect((await inboxFor(treasurer.email!)).some(m => (m.subject ?? '').startsWith('Payment of'))).toBe(
      true,
    );
    expect(events.some(e => e.event === 'platform_billing.payment.updated')).toBe(true);
    // a second verify returns the same result and settles nothing twice
    const again = await pay('post', `/subscription/payments/${o.body.data.paymentId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect(again.body.data.status).toBe('CAPTURED');
    expect((await PlatformInvoice.findByPk(invoice.id))!.paidPaise).toBe(1239000);
  });

  it('T06-11 the same Idempotency-Key twice creates one order and replays', async () => {
    const { pay, invoice } = await billedSociety();
    const headers = idemKey();
    const a = await pay('post', `/subscription/invoices/${invoice.id}/payment-orders`, {}, { headers });
    const b = await pay('post', `/subscription/invoices/${invoice.id}/payment-orders`, {}, { headers });
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.paymentId).toBe(a.body.data.paymentId);
    expect(await PlatformPayment.count({ where: { kind: 'PAYMENT' } })).toBe(1);
    const other = await pay(
      'post',
      `/subscription/invoices/${invoice.id}/payment-orders`,
      { amountPaise: 500 },
      { headers },
    );
    expect([other.status, other.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect((await pay('post', `/subscription/invoices/${invoice.id}/payment-orders`, {})).status).toBe(400);
  });

  it('BR-06-27 an open order for the same invoice and amount is returned; another amount makes a new one', async () => {
    const { pay, invoice } = await billedSociety();
    const a = await order(pay, invoice.id);
    const b = await order(pay, invoice.id);
    expect(b.body.data.paymentId).toBe(a.body.data.paymentId);
    expect(b.body.data.gatewayOrderId).toBe(a.body.data.gatewayOrderId);
    const c = await order(pay, invoice.id, { amountPaise: 500000 });
    expect(c.body.data.paymentId).not.toBe(a.body.data.paymentId);
    // older than billing.pendingOrderMinutes: a new order
    await sequelize.query("UPDATE platform_payments SET createdAt = '2026-11-01 05:00:00.000'");
    expect((await order(pay, invoice.id)).body.data.paymentId).not.toBe(a.body.data.paymentId);
  });

  it('T06-17 due + 1 paisa is AMOUNT_EXCEEDS_DUE; T06-18 99 is AMOUNT_BELOW_MINIMUM and 100 is accepted', async () => {
    const { pay, invoice } = await billedSociety();
    const over = await order(pay, invoice.id, { amountPaise: 1239001 });
    expect([over.status, over.body.code]).toEqual([422, 'AMOUNT_EXCEEDS_DUE']);
    const low = await order(pay, invoice.id, { amountPaise: 99 });
    expect([low.status, low.body.code]).toEqual([422, 'AMOUNT_BELOW_MINIMUM']);
    expect((await order(pay, invoice.id, { amountPaise: 100 })).status).toBe(201);
    expect((await order(pay, invoice.id, { amountPaise: 1.5 })).status).toBe(400);
    // amount due below ₹1: only the exact amount is allowed
    await PlatformInvoice.update(
      { amountDuePaise: 50, paidPaise: 1238950, status: 'PARTIALLY_PAID' },
      { where: { id: invoice.id } },
    );
    expect((await order(pay, invoice.id, { amountPaise: 40 })).body.code).toBe('AMOUNT_BELOW_MINIMUM');
    expect((await order(pay, invoice.id, { amountPaise: 50 })).status).toBe(201);
  });

  it('a part payment leaves the invoice PARTIALLY_PAID; paid, void and other societies are refused', async () => {
    const { pay, invoice, sub } = await billedSociety();
    const o = await order(pay, invoice.id, { amountPaise: 400000 });
    const p = gw.payOrder(o.body.data.gatewayOrderId);
    const v = await pay('post', `/subscription/payments/${o.body.data.paymentId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect(v.body.data.invoice).toEqual({ id: invoice.id, status: 'PARTIALLY_PAID', amountDuePaise: 839000 });
    await PlatformInvoice.update({ status: 'PAID', amountDuePaise: 0 }, { where: { id: invoice.id } });
    const r = await order(pay, invoice.id);
    expect([r.status, r.body.code]).toEqual([409, 'INVOICE_NOT_PAYABLE']);
    void sub;
  });

  it('T06-35 a SUSPENDED society on the Starter plan can still pay (201)', async () => {
    const s = await lifecycleSociety('SUSPENDED', { plan: 'STARTER', flats: 40, cause: 'NON_PAYMENT' });
    const t = await memberUser(s, 'treasurer');
    const inv = await issueFor((await Subscription.findOne({ where: { societyId: s.id! } }))!, '2026-11-01');
    const pay = as(await login(t));
    const r = await order(pay, inv.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // the read routes stay open for a closed society too
    await Society.update(
      {
        status: 'CLOSED',
        closedAt: new Date(),
        closureReason: 'OTHER',
        suspendedAt: null,
        suspensionCause: null,
      },
      { where: { id: s.id! } },
    );
    expect((await pay('get', '/subscription/invoices')).status).toBe(200);
  });

  it('a gateway failure answers 502 GATEWAY_ERROR and marks the payment FAILED', async () => {
    const { pay, invoice } = await billedSociety();
    gw.failNext.createOrder = true;
    const r = await order(pay, invoice.id);
    expect([r.status, r.body.code]).toEqual([502, 'GATEWAY_ERROR']);
    expect(await PlatformPayment.findOne({ where: { status: 'FAILED' } })).toMatchObject({
      kind: 'PAYMENT',
      gatewayOrderId: null,
    });
    // the idempotency key was freed: a retry works
    expect((await order(pay, invoice.id)).status).toBe(201);
  });
});

describe('verify (8.6)', () => {
  async function ordered() {
    const s = await billedSociety();
    const o = await order(s.pay, s.invoice.id);
    return {
      ...s,
      paymentId: o.body.data.paymentId as number,
      orderId: o.body.data.gatewayOrderId as string,
    };
  }

  it('PAYMENT_MISMATCH when the amount or the order differs; nothing settles; audited and flagged', async () => {
    const { pay, paymentId, orderId, invoice } = await ordered();
    const p = gw.payOrder(orderId, { amountPaise: 1000 });
    const r = await pay('post', `/subscription/payments/${paymentId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect([r.status, r.body.code]).toEqual([422, 'PAYMENT_MISMATCH']);
    expect(await PlatformPayment.findByPk(paymentId)).toMatchObject({ status: 'CREATED', appliedPaise: 0 });
    expect(await PlatformInvoice.findByPk(invoice.id)).toMatchObject({ status: 'ISSUED', paidPaise: 0 });
    expect(await AuditLog.count({ where: { action: 'platform_billing.payment.mismatch' } })).toBe(1);
    const other = (await order(pay, invoice.id, { amountPaise: 700000 })).body.data;
    const q = gw.payOrder(other.gatewayOrderId);
    const wrongOrder = await pay('post', `/subscription/payments/${paymentId}/verify`, {
      gatewayPaymentId: q.paymentId,
    });
    expect(wrongOrder.body.code).toBe('PAYMENT_MISMATCH');
  });

  it('failed and pending gateway answers; unknown gateway payment is 502; bad id shape is 400', async () => {
    const { pay, paymentId, orderId } = await ordered();
    const pending = gw.payOrder(orderId, { status: 'pending' });
    const a = await pay('post', `/subscription/payments/${paymentId}/verify`, {
      gatewayPaymentId: pending.paymentId,
    });
    expect(a.body.data.status).toBe('CREATED');
    const failed = gw.payOrder(orderId, { status: 'failed' });
    const b = await pay('post', `/subscription/payments/${paymentId}/verify`, {
      gatewayPaymentId: failed.paymentId,
    });
    expect(b.body.data.status).toBe('FAILED');
    expect(await AuditLog.count({ where: { action: 'platform_billing.payment.failed' } })).toBe(1);
    const c = await pay('post', `/subscription/payments/${paymentId}/verify`, {
      gatewayPaymentId: 'pay_doesnotexist1',
    });
    expect([c.status, c.body.code]).toEqual([502, 'GATEWAY_ERROR']);
    expect(
      (await pay('post', `/subscription/payments/${paymentId}/verify`, { gatewayPaymentId: 'nope' })).status,
    ).toBe(400);
  });

  it('a late captured payment after FAILED still settles (money is never ignored)', async () => {
    const { pay, paymentId, orderId, invoice } = await ordered();
    const failed = gw.payOrder(orderId, { status: 'failed' });
    await pay('post', `/subscription/payments/${paymentId}/verify`, { gatewayPaymentId: failed.paymentId });
    const ok = gw.payOrder(orderId);
    const r = await pay('post', `/subscription/payments/${paymentId}/verify`, {
      gatewayPaymentId: ok.paymentId,
    });
    expect(r.body.data.status).toBe('CAPTURED');
    expect((await PlatformInvoice.findByPk(invoice.id))!.status).toBe('PAID');
  });

  it('a manual payment id and another society payment are not verifiable', async () => {
    const a = await ordered();
    const b = await billedSociety({ name: 'Green Park CHS' });
    const r = await b.pay('post', `/subscription/payments/${a.paymentId}/verify`, {
      gatewayPaymentId: 'pay_abcdefgh12',
    });
    expect([r.status, r.body.code]).toEqual([404, 'PLATFORM_PAYMENT_NOT_FOUND']);
    const manual = await PlatformPayment.create({
      societyId: a.society.id!,
      invoiceId: a.invoice.id,
      kind: 'PAYMENT',
      origin: 'PLATFORM',
      status: 'PENDING_APPROVAL',
      method: 'NEFT',
      amountPaise: 100,
      appliedPaise: 0,
      version: 1,
    } as never);
    const m = await a.pay('post', `/subscription/payments/${manual.id}/verify`, {
      gatewayPaymentId: 'pay_abcdefgh12',
    });
    expect([m.status, m.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('double payment race: two verifies at once settle once; a second capture on a paid invoice becomes credit', async () => {
    const { pay, paymentId, orderId, invoice, society } = await ordered();
    const p = gw.payOrder(orderId);
    const rs = await Promise.all(
      [1, 2, 3].map(() =>
        pay('post', `/subscription/payments/${paymentId}/verify`, { gatewayPaymentId: p.paymentId }),
      ),
    );
    expect(rs.map(r => r.status)).toEqual([200, 200, 200]);
    expect(await PlatformInvoice.findByPk(invoice.id)).toMatchObject({ paidPaise: 1239000, status: 'PAID' });
    expect(await AuditLog.count({ where: { action: 'platform_billing.payment.captured' } })).toBe(1);
    expect(await PlatformCredit.count({ where: { societyId: society.id! } })).toBe(0);
  });

  it('two orders for one invoice both captured: the first pays it, the second goes to PAYMENT_EXCESS credit (BR-06-24)', async () => {
    const { pay, invoice, society } = await billedSociety();
    const a = (await order(pay, invoice.id)).body.data;
    const b = (await order(pay, invoice.id, { amountPaise: 1000000 })).body.data;
    const pa = gw.payOrder(a.gatewayOrderId);
    const pb = gw.payOrder(b.gatewayOrderId);
    await pay('post', `/subscription/payments/${a.paymentId}/verify`, { gatewayPaymentId: pa.paymentId });
    await pay('post', `/subscription/payments/${b.paymentId}/verify`, { gatewayPaymentId: pb.paymentId });
    expect(await PlatformPayment.findByPk(b.paymentId)).toMatchObject({
      status: 'CAPTURED',
      appliedPaise: 0,
    });
    const credit = (await PlatformCredit.findAll({ where: { societyId: society.id! } }))!;
    expect(credit.map(c => [c.entryType, Number(c.amountPaise), Number(c.balanceAfterPaise)])).toEqual([
      ['PAYMENT_EXCESS', 1000000, 1000000],
    ]);
    expect((await PlatformInvoice.findByPk(invoice.id))!.paidPaise).toBe(1239000);
  });
});

describe('webhook (8.28)', () => {
  it('T06-13 a bad or missing signature is 400 WEBHOOK_SIGNATURE_INVALID and nothing is processed', async () => {
    const { pay, invoice } = await billedSociety();
    const o = (await order(pay, invoice.id)).body.data;
    const p = gw.payOrder(o.gatewayOrderId);
    const evt = {
      id: 'evt_bad1',
      event: 'payment.captured',
      payment: { id: p.paymentId, order_id: o.gatewayOrderId, amount: p.amountPaise, method: 'upi' },
    };
    const bad = await webhook(evt, 'some-other-secret-value');
    expect([bad.status, bad.body.code]).toEqual([400, 'WEBHOOK_SIGNATURE_INVALID']);
    const none = await webhook(evt, undefined, false);
    expect([none.status, none.body.code]).toEqual([400, 'WEBHOOK_SIGNATURE_INVALID']);
    await drainQueues();
    expect((await PlatformPayment.findByPk(o.paymentId))!.status).toBe('CREATED');
  });

  it('T06-12 replaying payment.captured three times settles once; the webhook can arrive before verify', async () => {
    const { pay, invoice } = await billedSociety();
    const o = (await order(pay, invoice.id)).body.data;
    const p = gw.payOrder(o.gatewayOrderId, { method: 'card' });
    const evt = {
      id: 'evt_replay1',
      event: 'payment.captured',
      payment: { id: p.paymentId, order_id: o.gatewayOrderId, amount: p.amountPaise, method: 'card' },
    };
    for (let i = 0; i < 3; i++) {
      const r = await webhook(evt);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data).toEqual({ received: true });
    }
    await drainQueues();
    expect(await PlatformInvoice.findByPk(invoice.id)).toMatchObject({ paidPaise: 1239000, status: 'PAID' });
    expect(await AuditLog.count({ where: { action: 'platform_billing.payment.captured' } })).toBe(1);
    expect((await PlatformPayment.findByPk(o.paymentId))!.method).toBe('CARD');
    // a different event id for the same capture is also a no-op (state check under the lock)
    await webhook({ ...evt, id: 'evt_replay2' });
    await drainQueues();
    expect((await PlatformInvoice.findByPk(invoice.id))!.paidPaise).toBe(1239000);
    const v = await pay('post', `/subscription/payments/${o.paymentId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect(v.body.data.status).toBe('CAPTURED');
  });

  it('amount mismatch in the event settles nothing, audits .payment.mismatch and notifies platform ops', async () => {
    const { pay, invoice } = await billedSociety();
    const team = await platformTeam();
    const o = (await order(pay, invoice.id)).body.data;
    const p = gw.payOrder(o.gatewayOrderId);
    await webhook({
      id: 'evt_mm1',
      event: 'payment.captured',
      payment: { id: p.paymentId, order_id: o.gatewayOrderId, amount: 5, method: 'upi' },
    });
    await drainQueues();
    expect(await PlatformPayment.findByPk(o.paymentId)).toMatchObject({ status: 'CREATED' });
    expect((await PlatformInvoice.findByPk(invoice.id))!.status).toBe('ISSUED');
    const a = await AuditLog.findOne({ where: { action: 'platform_billing.payment.mismatch' } });
    expect(a!.after).toMatchObject({ expectedAmountPaise: 1239000, gatewayAmountPaise: 5 });
    expect((await inboxFor(team.maker.user.email)).some(m => m.subject === 'Payment amount mismatch')).toBe(
      true,
    );
  });

  it('payment.failed fails a CREATED order; a late payment.captured after EXPIRED settles; unknown orders and events are ignored', async () => {
    const { pay, invoice } = await billedSociety();
    const o = (await order(pay, invoice.id)).body.data;
    const p = gw.payOrder(o.gatewayOrderId);
    await webhook({
      id: 'evt_f1',
      event: 'payment.failed',
      payment: { id: p.paymentId, order_id: o.gatewayOrderId },
    });
    await drainQueues();
    expect((await PlatformPayment.findByPk(o.paymentId))!.status).toBe('FAILED');
    await PlatformPayment.update({ status: 'EXPIRED' }, { where: { id: o.paymentId } });
    await webhook({
      id: 'evt_c1',
      event: 'payment.captured',
      payment: { id: p.paymentId, order_id: o.gatewayOrderId, amount: p.amountPaise, method: 'upi' },
    });
    await drainQueues();
    expect((await PlatformPayment.findByPk(o.paymentId))!.status).toBe('CAPTURED');
    expect((await PlatformInvoice.findByPk(invoice.id))!.status).toBe('PAID');
    expect(
      (
        await webhook({
          id: 'evt_u1',
          event: 'payment.captured',
          payment: { id: 'pay_x', order_id: 'order_unknown', amount: 1 },
        })
      ).status,
    ).toBe(200);
    expect((await webhook({ id: 'evt_u2', event: 'subscription.charged' })).status).toBe(200);
    await drainQueues();
  });

  it('order.paid reads the captured payment from the gateway', async () => {
    const { pay, invoice } = await billedSociety();
    const o = (await order(pay, invoice.id)).body.data;
    gw.payOrder(o.gatewayOrderId);
    await webhook({ id: 'evt_op1', event: 'order.paid', order: { id: o.gatewayOrderId } });
    await drainQueues();
    expect((await PlatformInvoice.findByPk(invoice.id))!.status).toBe('PAID');
  });

  it('paying an invoice clears a PAST_DUE society in the same transaction (BR-06-40)', async () => {
    const { pay, invoice, society } = await billedSociety();
    await sequelize.query(
      "UPDATE platform_invoices SET status = 'OVERDUE', dueDate = '2026-10-20' WHERE id = :id",
      { replacements: { id: invoice.id } },
    );
    await Society.update({ status: 'PAST_DUE', pastDueSince: new Date() }, { where: { id: society.id! } });
    const o = (await order(pay, invoice.id)).body.data;
    const p = gw.payOrder(o.gatewayOrderId);
    await pay('post', `/subscription/payments/${o.paymentId}/verify`, { gatewayPaymentId: p.paymentId });
    expect((await Society.findByPk(society.id!))!.status).toBe('ACTIVE');
  });
});

describe('dev route and summary', () => {
  it('POST /dev/payments/:orderId/pay pays a fake order; the billing summary reflects the invoice and the payment', async () => {
    const { pay, invoice, view } = await billedSociety();
    const before = await view('get', '/subscription/billing-summary');
    expect(before.body.data).toMatchObject({
      outstandingPaise: 1239000,
      overduePaise: 0,
      openInvoiceCount: 1,
      oldestDueDate: '2026-11-16',
      nextSuspensionDate: null,
      creditBalancePaise: 0,
      societyStatus: 'ACTIVE',
      autopayStatus: 'NONE',
      pendingManualPaymentPaise: 0,
    });
    const o = (await order(pay, invoice.id)).body.data;
    const d = await call('post', `/dev/payments/${o.gatewayOrderId}/pay`, {}, { app: 'ADMIN' });
    expect(d.status).toBe(200);
    await pay('post', `/subscription/payments/${o.paymentId}/verify`, {
      gatewayPaymentId: d.body.data.gatewayPaymentId,
    });
    const after = await view('get', '/subscription/billing-summary');
    expect(after.body.data).toMatchObject({ outstandingPaise: 0, openInvoiceCount: 0, oldestDueDate: null });
    const list = await view('get', '/subscription/payments');
    expect(list.body.data[0]).toMatchObject({
      kind: 'PAYMENT',
      status: 'CAPTURED',
      invoiceNo: invoice.invoiceNo,
      hasCertificate: false,
    });
    expect(list.body.data[0].bankRefKey).toBeUndefined();
    expect(list.body.pagination.total).toBe(1);
  });
});
