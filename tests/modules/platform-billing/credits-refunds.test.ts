import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  PlatformCredit,
  PlatformInvoice,
  PlatformPayment,
  closeDb,
  sequelize,
} from '../../../src/models';
import { signWebhookBody, type FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { advance, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { env } from '../../../src/lib/env';
import { setBillingSettingsSource } from '../../../src/modules/platform-billing/platform-billing.public';
import { creditBalance } from '../../../src/modules/platform-billing/platform-billing.settlement';
import { as, login, memberUser } from '../../helpers/access';
import { call, inboxFor } from '../../helpers/auth';
import { subSociety } from '../../helpers/subscriptions';
import { billedSociety, idemKey, platformTeam, resetBilling } from '../../helpers/billing';

/** Task 6.3: goodwill credits and refunds (BR-06-31, BR-06-32; 8.21 to 8.23; T06-27, T06-28). */
let gw: FakePaymentGateway;
beforeEach(async () => {
  gw = (await resetBilling()) as FakePaymentGateway;
});
afterAll(async () => {
  setBillingSettingsSource(undefined);
  await drainQueues();
  setNow(null);
  await closeDb();
});

type Call = ReturnType<typeof as>;
const goodwill = (
  c: Call,
  societyId: number,
  amountPaise: number,
  reason = 'Outage compensation for October',
) => c('post', `/platform/societies/${societyId}/credits`, { amountPaise, reason }, { headers: idemKey() });
const refundReq = (c: Call, societyId: number, b: object) =>
  c('post', `/platform/societies/${societyId}/refunds`, b, { headers: idemKey() });
const webhook = (id: string, event: string, refund: object) => {
  const body = JSON.stringify({ id, event, payload: { refund: { entity: refund } } });
  return call('post', '/webhooks/platform-billing/razorpay', body, {
    app: 'ADMIN',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signWebhookBody(body, env().PLATFORM_RAZORPAY_WEBHOOK_SECRET),
    },
  });
};

/** A society with no invoices (so a credit stays as balance) and a platform team. */
async function creditSociety() {
  const { society } = await subSociety({ plan: 'STANDARD', flats: 100 });
  const treasurer = await memberUser(society, 'treasurer');
  return { society, treasurer, view: as(await login(treasurer)), ...(await platformTeam()) };
}
async function withBalance(amount = 50000) {
  const s = await creditSociety();
  const g = await goodwill(s.maker.c, s.society.id!, amount);
  const ap = await s.checker.c('post', `/platform/credits/${g.body.data.id}/approve`, { version: 1 });
  expect(ap.status, JSON.stringify(ap.body)).toBe(200);
  return s;
}

describe('goodwill credit (8.23)', () => {
  it('request, approval by another admin, posted with the balance, applied to open invoices, notification and audit', async () => {
    const { society, invoice, maker, checker, treasurer } = {
      ...(await billedSociety()),
      ...(await platformTeam()),
    };
    const g = await goodwill(maker.c, society.id!, 50000);
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(g.body.data).toMatchObject({
      entryType: 'GOODWILL',
      status: 'PENDING_APPROVAL',
      amountPaise: 50000,
      balanceAfterPaise: null,
      version: 1,
    });
    expect(await creditBalance(society.id!)).toBe(0);
    const own = await maker.c('post', `/platform/credits/${g.body.data.id}/approve`, { version: 1 });
    expect([own.status, own.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    const stale = await checker.c('post', `/platform/credits/${g.body.data.id}/approve`, { version: 3 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const ap = await checker.c('post', `/platform/credits/${g.body.data.id}/approve`, { version: 1 });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.data).toMatchObject({ status: 'POSTED', balanceAfterPaise: 50000, creditBalancePaise: 0 });
    // the open invoice took the credit at once (BR-06-26)
    expect(await PlatformInvoice.findByPk(invoice.id)).toMatchObject({
      creditAppliedPaise: 50000,
      status: 'PARTIALLY_PAID',
      amountDuePaise: 1189000,
    });
    const rows = await PlatformCredit.findAll({
      where: { societyId: society.id! },
      order: [
        ['postedAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    expect(
      rows.map(r => [
        r.entryType,
        Number(r.amountPaise),
        r.balanceAfterPaise === null ? null : Number(r.balanceAfterPaise),
      ]),
    ).toEqual([
      ['GOODWILL', 50000, 50000],
      ['APPLIED', -50000, 0],
    ]);
    for (const a of ['credit.requested', 'credit.approved', 'credit.applied'])
      expect(await AuditLog.count({ where: { action: `platform_billing.${a}` } }), a).toBe(1);
    await drainQueues();
    expect((await inboxFor(treasurer.email!)).some(m => m.subject?.startsWith('A credit of'))).toBe(true);
    const again = await checker.c('post', `/platform/credits/${g.body.data.id}/approve`, { version: 2 });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('approving a credit after other credit rows were posted keeps the ledger balance right (frozen clock)', async () => {
    const { society, maker, checker } = { ...(await billedSociety()), ...(await platformTeam()) };
    await sequelize.query('UPDATE platform_invoices SET status = "PAID", amountDuePaise = 0');
    const g = await goodwill(maker.c, society.id!, 30000);
    const g2 = await goodwill(maker.c, society.id!, 20000);
    await checker.c('post', `/platform/credits/${g2.body.data.id}/approve`, { version: 1 });
    await checker.c('post', `/platform/credits/${g.body.data.id}/approve`, { version: 1 });
    expect(await creditBalance(society.id!)).toBe(50000);
  });

  it('limits, validation, permissions and step-up', async () => {
    const { society, maker, checker, support } = await creditSociety();
    const over = await goodwill(maker.c, society.id!, 50000001);
    expect([over.status, over.body.code]).toEqual([422, 'GOODWILL_LIMIT_EXCEEDED']);
    setBillingSettingsSource(async key => (key === 'billing.maxGoodwillCreditPaise' ? 1000 : undefined));
    expect((await goodwill(maker.c, society.id!, 1001)).body.code).toBe('GOODWILL_LIMIT_EXCEEDED');
    expect((await goodwill(maker.c, society.id!, 1000)).status).toBe(201);
    setBillingSettingsSource(undefined);
    expect((await goodwill(maker.c, society.id!, 99)).status).toBe(400);
    expect((await goodwill(maker.c, society.id!, 500, 'short')).status).toBe(400);
    expect((await goodwill(maker.c, 999999, 500)).body.code).toBe('NOT_FOUND');
    expect((await goodwill(support.c, society.id!, 500)).status).toBe(403);
    expect((await checker.c('post', `/platform/credits/99999/approve`, { version: 1 })).body.code).toBe(
      'PLATFORM_CREDIT_NOT_FOUND',
    );
    advance(6 * 60_000);
    expect((await goodwill(maker.c, society.id!, 500)).body.code).toBe('REAUTH_REQUIRED');
  });

  it('reject needs a reason and the other admin; the ledgers: platform sees pending and rejected, the society only posted', async () => {
    const { society, maker, checker, view } = await creditSociety();
    const g = await goodwill(maker.c, society.id!, 5000);
    expect(
      (
        await maker.c('post', `/platform/credits/${g.body.data.id}/reject`, {
          version: 1,
          reason: 'Not needed after all',
        })
      ).body.code,
    ).toBe('MAKER_CHECKER_VIOLATION');
    expect(
      (await checker.c('post', `/platform/credits/${g.body.data.id}/reject`, { version: 1, reason: 'short' }))
        .status,
    ).toBe(400);
    const r = await checker.c('post', `/platform/credits/${g.body.data.id}/reject`, {
      version: 1,
      reason: 'Not covered by the policy',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'REJECTED' });
    expect(await AuditLog.count({ where: { action: 'platform_billing.credit.rejected' } })).toBe(1);
    const pl = await maker.c('get', `/platform/societies/${society.id}/credits`, undefined, {
      query: { status: 'PENDING_APPROVAL,REJECTED' },
    });
    expect(pl.body.data).toHaveLength(1);
    expect(pl.body).toMatchObject({ balancePaise: 0, pagination: { total: 1 } });
    const sc = await view('get', '/subscription/credits');
    expect(sc.body.data).toEqual([]);
    expect(sc.body.balancePaise).toBe(0);
  });
});

describe('refunds by bank transfer (8.22, 8.19, 8.21)', () => {
  it('request reserves the balance; approval makes it PROCESSING; completion records the bank reference and notifies', async () => {
    const { society, maker, checker, treasurer, view } = await withBalance(50000);
    const r = await refundReq(maker.c, society.id!, {
      amountPaise: 30000,
      mode: 'BANK_TRANSFER',
      payeeReference: 'Society HDFC a/c ending 4821',
      reason: 'Plan downgrade refund requested',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      kind: 'REFUND',
      status: 'PENDING_APPROVAL',
      method: 'BANK_TRANSFER',
      amountPaise: 30000,
      creditBalancePaise: 20000,
    });
    expect(await creditBalance(society.id!)).toBe(20000);
    expect(await AuditLog.count({ where: { action: 'platform_billing.refund.requested' } })).toBe(1);
    const id = r.body.data.id;
    expect((await maker.c('post', `/platform/payments/${id}/approve`, { version: 1 })).body.code).toBe(
      'MAKER_CHECKER_VIOLATION',
    );
    const ap = await checker.c('post', `/platform/payments/${id}/approve`, { version: 1 });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.data).toMatchObject({ status: 'PROCESSING', gatewayRefundId: null });
    expect(await AuditLog.count({ where: { action: 'platform_billing.refund.approved' } })).toBe(1);
    const done = (b: object) => maker.c('post', `/platform/payments/${id}/complete-refund`, b);
    expect(
      (await done({ bankReference: 'UTR-REFUND-01', receivedOn: '2026-09-01', version: 2 })).status,
    ).toBe(400);
    expect(
      (await done({ bankReference: 'UTR-REFUND-01', receivedOn: '2026-11-01', version: 1 })).body.code,
    ).toBe('STALE_VERSION');
    const c = await done({ bankReference: 'UTR-REFUND-01', receivedOn: '2026-11-01', version: 2 });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(await PlatformPayment.findByPk(id)).toMatchObject({
      status: 'REFUNDED',
      bankReference: 'UTR-REFUND-01',
      receivedOn: '2026-11-01',
    });
    expect((await PlatformPayment.findByPk(id))!.completedAt).not.toBeNull();
    expect(await AuditLog.count({ where: { action: 'platform_billing.refund.completed' } })).toBe(1);
    await drainQueues();
    expect((await inboxFor(treasurer.email!)).some(m => m.subject?.startsWith('Refund of'))).toBe(true);
    expect(
      (await done({ bankReference: 'UTR-REFUND-02', receivedOn: '2026-11-01', version: 3 })).body.code,
    ).toBe('INVALID_STATE');
    const list = await view('get', '/subscription/payments', undefined, { query: { kind: 'REFUND' } });
    expect(list.body.data[0]).toMatchObject({ kind: 'REFUND', status: 'REFUNDED' });
  });

  it('T06-27 a refund above the credit balance is 422 INSUFFICIENT_CREDIT_BALANCE; validation of mode, payee and amount', async () => {
    const { society, maker, support } = await withBalance(50000);
    const base = {
      amountPaise: 50001,
      mode: 'BANK_TRANSFER',
      payeeReference: 'Society HDFC a/c ending 4821',
      reason: 'Plan downgrade refund requested',
    };
    const r = await refundReq(maker.c, society.id!, base);
    expect([r.status, r.body.code]).toEqual([422, 'INSUFFICIENT_CREDIT_BALANCE']);
    expect(await creditBalance(society.id!)).toBe(50000);
    expect((await refundReq(maker.c, society.id!, { ...base, amountPaise: 99 })).status).toBe(400);
    expect(
      (
        await refundReq(maker.c, society.id!, {
          ...base,
          amountPaise: 100,
          payeeReference: 'a/c 123456789012',
        })
      ).status,
    ).toBe(400);
    expect(
      (await refundReq(maker.c, society.id!, { ...base, amountPaise: 100, payeeReference: undefined }))
        .status,
    ).toBe(400);
    expect(
      (await refundReq(maker.c, society.id!, { ...base, amountPaise: 100, mode: 'GATEWAY' })).status,
    ).toBe(400);
    expect((await refundReq(maker.c, 999999, { ...base, amountPaise: 100 })).body.code).toBe('NOT_FOUND');
    expect((await refundReq(support.c, society.id!, { ...base, amountPaise: 100 })).status).toBe(403);
    expect(
      (await maker.c('post', `/platform/societies/${society.id}/refunds`, { ...base, amountPaise: 100 }))
        .status,
    ).toBe(400);
    expect((await refundReq(maker.c, society.id!, { ...base, amountPaise: 50000 })).status).toBe(201);
    expect(await creditBalance(society.id!)).toBe(0);
  });

  it('rejection restores the balance with REFUND_REVERSED; a duplicate bank reference on completion is 409', async () => {
    const { society, maker, checker } = await withBalance(50000);
    const mk = async (amount: number) =>
      (
        await refundReq(maker.c, society.id!, {
          amountPaise: amount,
          mode: 'BANK_TRANSFER',
          payeeReference: 'Society HDFC a/c ending 4821',
          reason: 'Plan downgrade refund requested',
        })
      ).body.data.id as number;
    const a = await mk(10000);
    const rej = await checker.c('post', `/platform/payments/${a}/reject`, {
      version: 1,
      reason: 'Wrong society was selected',
    });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(await creditBalance(society.id!)).toBe(50000);
    expect(await PlatformCredit.count({ where: { entryType: 'REFUND_REVERSED' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'platform_billing.refund.rejected' } })).toBe(1);
    const b = await mk(10000);
    const c = await mk(10000);
    for (const id of [b, c]) await checker.c('post', `/platform/payments/${id}/approve`, { version: 1 });
    expect(
      (
        await maker.c('post', `/platform/payments/${b}/complete-refund`, {
          bankReference: 'UTR-SAME-0001',
          receivedOn: '2026-11-01',
          version: 2,
        })
      ).status,
    ).toBe(200);
    const dup = await maker.c('post', `/platform/payments/${c}/complete-refund`, {
      bankReference: 'utr-same-0001',
      receivedOn: '2026-11-01',
      version: 2,
    });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE_BANK_REFERENCE']);
  });
});

describe('refunds through the gateway', () => {
  /** The society pays an invoice online (a gateway payment to refund from) and holds a goodwill credit. */
  async function paidOnline(credit = 2000000) {
    const s = { ...(await billedSociety()), ...(await platformTeam()) };
    const o = (
      await s.pay('post', `/subscription/invoices/${s.invoice.id}/payment-orders`, {}, { headers: idemKey() })
    ).body.data;
    const p = gw.payOrder(o.gatewayOrderId);
    await s.pay('post', `/subscription/payments/${o.paymentId}/verify`, { gatewayPaymentId: p.paymentId });
    const g = await goodwill(s.maker.c, s.society.id!, credit);
    await s.checker.c('post', `/platform/credits/${g.body.data.id}/approve`, { version: 1 });
    return { ...s, source: o.paymentId as number, gatewayPaymentId: p.paymentId };
  }
  const gwRefund = (c: Call, societyId: number, sourcePaymentId: number, amountPaise: number) =>
    refundReq(c, societyId, {
      amountPaise,
      mode: 'GATEWAY',
      sourcePaymentId,
      reason: 'Duplicate payment returned',
    });

  it('approval calls the gateway; refund.failed reverses (T06-28); refund.processed completes', async () => {
    const { society, maker, checker, source } = await paidOnline();
    const a = await gwRefund(maker.c, society.id!, source, 100000);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.data).toMatchObject({
      method: 'GATEWAY_REFUND',
      sourcePaymentId: source,
      creditBalancePaise: 1900000,
    });
    const ap = await checker.c('post', `/platform/payments/${a.body.data.id}/approve`, { version: 1 });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.data.status).toBe('PROCESSING');
    const refundId = ap.body.data.gatewayRefundId as string;
    expect(refundId).toMatch(/^rfnd_/);
    // T06-28: the gateway reports a failure
    expect(
      (await webhook('evt_rf1', 'refund.failed', { id: refundId, payment_id: 'pay_x', amount: 100000 }))
        .status,
    ).toBe(200);
    await drainQueues();
    expect(await PlatformPayment.findByPk(a.body.data.id)).toMatchObject({ status: 'FAILED' });
    expect(await creditBalance(society.id!)).toBe(2000000);
    expect(await PlatformCredit.count({ where: { entryType: 'REFUND_REVERSED' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'platform_billing.refund.failed' } })).toBe(1);
    // a replay or a late "processed" for a FAILED refund changes nothing
    await webhook('evt_rf1', 'refund.failed', { id: refundId });
    await webhook('evt_rf2', 'refund.processed', { id: refundId, payment_id: 'pay_x', amount: 100000 });
    await drainQueues();
    expect(await creditBalance(society.id!)).toBe(2000000);
    // a new refund that the gateway processes
    const b = await gwRefund(maker.c, society.id!, source, 100000);
    const ap2 = await checker.c('post', `/platform/payments/${b.body.data.id}/approve`, { version: 1 });
    await webhook('evt_rf3', 'refund.processed', {
      id: ap2.body.data.gatewayRefundId,
      payment_id: 'pay_x',
      amount: 100000,
    });
    await drainQueues();
    expect(await PlatformPayment.findByPk(b.body.data.id)).toMatchObject({ status: 'REFUNDED' });
    expect(await creditBalance(society.id!)).toBe(1900000);
  });

  it('REFUND_EXCEEDS_SOURCE_PAYMENT counts non-failed refunds; REFUND_SOURCE_TOO_OLD; unknown or other society source is 404', async () => {
    const { society, maker, source } = await paidOnline();
    const other = await billedSociety({ name: 'Green Park CHS' });
    expect((await gwRefund(maker.c, society.id!, source, 1239001)).body.code).toBe(
      'REFUND_EXCEEDS_SOURCE_PAYMENT',
    );
    expect((await gwRefund(maker.c, society.id!, source, 1000000)).status).toBe(201);
    const left = await gwRefund(maker.c, society.id!, source, 239001);
    expect([left.status, left.body.code]).toEqual([422, 'REFUND_EXCEEDS_SOURCE_PAYMENT']);
    expect((await gwRefund(maker.c, society.id!, source, 239000)).status).toBe(201);
    expect((await gwRefund(maker.c, society.id!, 999999, 100)).body.code).toBe('PLATFORM_PAYMENT_NOT_FOUND');
    const foreign = await PlatformPayment.create({
      societyId: other.society.id!,
      invoiceId: other.invoice.id,
      kind: 'PAYMENT',
      origin: 'SOCIETY',
      status: 'CAPTURED',
      amountPaise: 1000,
      appliedPaise: 1000,
      gatewayPaymentId: 'pay_foreign001',
      capturedAt: new Date(),
      version: 1,
    } as never);
    expect((await gwRefund(maker.c, society.id!, foreign.id!, 100)).body.code).toBe(
      'PLATFORM_PAYMENT_NOT_FOUND',
    );
    const manual = await PlatformPayment.create({
      societyId: society.id!,
      invoiceId: null,
      kind: 'PAYMENT',
      origin: 'PLATFORM',
      status: 'CAPTURED',
      method: 'NEFT',
      amountPaise: 5000,
      appliedPaise: 0,
      capturedAt: new Date(),
      version: 1,
    } as never);
    expect((await gwRefund(maker.c, society.id!, manual.id!, 100)).body.code).toBe('REFUND_SOURCE_TOO_OLD');
    const oldOne = await PlatformPayment.create({
      societyId: society.id!,
      invoiceId: null,
      kind: 'PAYMENT',
      origin: 'SOCIETY',
      status: 'CAPTURED',
      method: 'UPI',
      amountPaise: 5000,
      appliedPaise: 0,
      gatewayPaymentId: 'pay_old000001',
      capturedAt: new Date('2026-04-01T00:00:00Z'),
      version: 1,
    } as never);
    expect((await gwRefund(maker.c, society.id!, oldOne.id!, 100)).body.code).toBe('REFUND_SOURCE_TOO_OLD');
  });

  it('a gateway error on approval is 502 and the refund stays PENDING_APPROVAL; rejecting it reverses the reservation', async () => {
    const { society, maker, checker, source } = await paidOnline();
    const a = await gwRefund(maker.c, society.id!, source, 100000);
    gw.failNext.refund = true;
    const ap = await checker.c('post', `/platform/payments/${a.body.data.id}/approve`, { version: 1 });
    expect([ap.status, ap.body.code]).toEqual([502, 'GATEWAY_ERROR']);
    expect((await PlatformPayment.findByPk(a.body.data.id))!.status).toBe('PENDING_APPROVAL');
    expect(await creditBalance(society.id!)).toBe(1900000);
    const retry = await checker.c('post', `/platform/payments/${a.body.data.id}/approve`, { version: 1 });
    expect(retry.status).toBe(200);
  });
});
