import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Invoice, Payment, Refund, Society, UnitAdvance, closeDb } from '../../../src/models';
import { advance, now } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { advanceBalance } from '../../../src/modules/payments/payments.advances';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import {
  paymentsPortCalls,
  placeholderPaymentApprovalTypes,
  placeholderPaymentApprovals,
} from '../../../src/modules/payments/payments.ports';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { approve, reject } from '../../../src/modules/payments/payments.refunds.approvals-hook';
import {
  handleRefundEvent,
  pollGatewayRefunds,
} from '../../../src/modules/payments/payments.refunds.service';
import { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { app } from '../../helpers/auth';
import { memberOf } from '../../helpers/society-setup';
import { ctxFor } from '../../helpers/billing-invoices';
import { idemH, type RunSociety } from '../../helpers/billing-runs';
import { mkInvoice, offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { systemCtx } from '../../../src/types/context';

let gw: FakePaymentGateway;
afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  gw = await resetPayments();
});

const settle = (w: RunSociety, input: ReturnType<typeof offline>) =>
  moneyTx(t => settleInput(sysCtx(w), input, t));
const journals = () => paymentsPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any);
const decider = (w: RunSociety) => ctxFor(w, w.treasurer.user.id!);
const bal = (w: RunSociety, i = 0) => advanceBalance(w.society.id!, w.units[i]!.id);
const ask = (w: RunSociety, body: Record<string, unknown>, c = w.c) =>
  c('post', '/refunds', body, { headers: idemH() });
const bank = { mode: 'BANK_TRANSFER', payeeName: 'Rohan Sharma', payeeAccountMasked: 'HDFC xxxx4521' };

/** A 500,000 NEFT with a 120,000 invoice: 380,000 sits in the advance. */
async function advanceWorld() {
  const w = await paymentsWorld({ flats: 2 });
  await mkInvoice(w, 0, 120_000, '2026-11-10');
  const { payment } = await settle(w, offline(w, 0, 500_000));
  expect(await bal(w)).toBe(380_000);
  return { w, payment };
}
const body = (paymentId: number, o: Record<string, unknown> = {}) => ({
  paymentId,
  amountPaise: 300_000,
  reason: 'Paid twice by mistake',
  ...bank,
  ...o,
});

describe('POST /refunds (8.19, BR-12-35, BR-12-36)', () => {
  it('requests a refund: holds the amount, asks module 14 for PAYMENT_REFUND, audits (US refund)', async () => {
    const { w, payment } = await advanceWorld();
    const r = await ask(w, body(Number(payment.id)));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'PENDING_APPROVAL',
      amountPaise: 300_000,
      mode: 'BANK_TRANSFER',
      freedFromAllocationsPaise: 0,
      approval: { status: 'PENDING' },
    });
    expect(await bal(w)).toBe(80_000);
    const hold = await UnitAdvance.findOne({ where: { refundId: r.body.data.id } });
    expect(hold).toMatchObject({ entryType: 'REFUND_HOLD', dedupeKey: `HOLD:refund:${r.body.data.id}` });
    expect(Number(hold!.amountPaise)).toBe(-300_000);
    const call = paymentsPortCalls.find(c => c.fn === 'approvals.request')!.input as any;
    expect(call).toMatchObject({
      type: 'PAYMENT_REFUND',
      entityType: 'refund',
      entityId: r.body.data.id,
      amountPaise: 300_000,
    });
    expect(call.payload).toMatchObject({ mode: 'BANK_TRANSFER', categoryKey: 'BANK_TRANSFER' });
    expect(await AuditLog.count({ where: { action: 'payments.refund.requested' } })).toBe(1);
  });

  it('the same Idempotency-Key twice gives one refund', async () => {
    const { w, payment } = await advanceWorld();
    const h = idemH();
    const a = await w.c('post', '/refunds', body(Number(payment.id)), { headers: h });
    const b = await w.c('post', '/refunds', body(Number(payment.id)), { headers: h });
    expect(a.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(await Refund.count({ where: { societyId: w.society.id! } })).toBe(1);
  });

  it('refuses more than refundable (T12-26) and counts earlier refunds', async () => {
    const { w, payment } = await advanceWorld();
    const r = await ask(w, body(Number(payment.id), { amountPaise: 500_001 }));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('REFUND_EXCEEDS_REFUNDABLE');
    expect(r.body.errors[0].refundablePaise).toBe(500_000);
  });

  it('refuses a second open refund of the same payment', async () => {
    const { w, payment } = await advanceWorld();
    expect((await ask(w, body(Number(payment.id), { amountPaise: 100_000 }))).status).toBe(201);
    const r = await ask(w, body(Number(payment.id), { amountPaise: 100_000 }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('REFUND_IN_PROGRESS');
  });

  it('needs reallocation when the advance is short, and with reallocate reopens the newest dues', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const inv = await mkInvoice(w, 0, 120_000, '2026-11-10');
    const { payment } = await settle(w, offline(w, 0, 150_000));
    expect(await bal(w)).toBe(30_000);
    const no = await ask(w, body(Number(payment.id), { amountPaise: 100_000 }));
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('REFUND_NEEDS_REALLOCATION');
    const yes = await ask(w, body(Number(payment.id), { amountPaise: 100_000, reallocate: true }));
    expect(yes.status, JSON.stringify(yes.body)).toBe(201);
    expect(yes.body.data.freedFromAllocationsPaise).toBe(120_000);
    expect(await bal(w)).toBe(50_000);
    expect(Number((await Invoice.findByPk(inv.id))!.outstandingPaise)).toBe(120_000);
    expect(
      journals().some((j: any) =>
        j.lines.some((l: any) => l.accountCode === 'MEMBER_ADVANCES' && l.creditPaise === 120_000),
      ),
    ).toBe(true);
  });

  it('GATEWAY only for an online or AutoPay payment (BR-12-36); offline modes need a payee', async () => {
    const { w, payment } = await advanceWorld();
    const g = await ask(
      w,
      body(Number(payment.id), { mode: 'GATEWAY', payeeName: undefined, payeeAccountMasked: undefined }),
    );
    expect(g.status).toBe(422);
    expect(g.body.code).toBe('REFUND_MODE_NOT_ALLOWED');
    const v = await ask(w, {
      paymentId: Number(payment.id),
      amountPaise: 1000,
      mode: 'BANK_TRANSFER',
      reason: 'Because reasons',
    });
    expect(v.status).toBe(400);
    expect(v.body.errors.map((e: any) => e.field).sort()).toEqual(['payeeAccountMasked', 'payeeName']);
    const bad = await ask(w, body(Number(payment.id), { payeeAccountMasked: 'HDFC 4521' }));
    expect(bad.status).toBe(400);
    const short = await ask(w, body(Number(payment.id), { reason: 'short' }));
    expect(short.status).toBe(400);
  });

  it('a gateway refund is refused after 180 days', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const { payment } = await settle(
      w,
      offline(w, 0, 100_000, {
        source: 'ONLINE',
        method: 'UPI',
        status: 'CAPTURED',
        gatewayPaymentId: 'pay_old',
        mode: 'OLDEST_FIRST',
      }),
    );
    gw.payments.set('pay_old', {
      paymentId: 'pay_old',
      orderId: 'o',
      status: 'captured',
      amountPaise: 100_000,
      method: 'upi',
    });
    await Payment.update({ capturedAt: new Date(now().getTime() - 181 * 86_400_000) } as never, {
      where: { id: payment.id },
    });
    const r = await ask(w, {
      paymentId: Number(payment.id),
      amountPaise: 1000,
      mode: 'GATEWAY',
      reason: 'Because reasons',
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('REFUND_MODE_NOT_ALLOWED');
  });

  it('404 for an unknown payment, 409 for a payment that is not effective', async () => {
    const { w, payment } = await advanceWorld();
    expect((await ask(w, body(999_999))).body.code).toBe('PAYMENT_NOT_FOUND');
    await Payment.update(
      { status: 'REVERSED', toInvoicesPaise: 0, toCollectionsPaise: 0, toAdvancePaise: 0 } as never,
      { where: { id: payment.id } },
    );
    const r = await ask(w, body(Number(payment.id)));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PAYMENT_NOT_EFFECTIVE');
  });

  it('needs finance.payments.create: the secretary (view and approve) is refused, T12-36', async () => {
    const { w, payment } = await advanceWorld();
    const r = await ask(w, body(Number(payment.id)), w.secretary.c);
    expect(r.status).toBe(403);
  });
});

describe('approval and payout (6.3)', () => {
  it('offline: approval makes it PROCESSING, complete pays it out: number, refundedPaise, journal Dr MEMBER_ADVANCES Cr BANK', async () => {
    const { w, payment } = await advanceWorld();
    const r = await ask(w, body(Number(payment.id)));
    const id = r.body.data.id as number;
    const early = await w.treasurer.c('post', `/refunds/${id}/complete`, {
      paidOutOn: '2026-11-04',
      bankReference: 'UTR123456',
      version: 1,
    });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_STATE');
    const reqId = r.body.data.approvalRequestId as number;
    await expect(approve(reqId, ctxFor(w, w.user.id!))).rejects.toMatchObject({
      code: 'MAKER_CHECKER_VIOLATION',
    });
    await approve(reqId, decider(w));
    const mid = (await Refund.findByPk(id))!;
    expect(mid.status).toBe('PROCESSING');
    expect(Number(mid.approvedBy)).toBe(w.treasurer.user.id);
    const needRef = await w.treasurer.c('post', `/refunds/${id}/complete`, {
      paidOutOn: '2026-11-04',
      version: Number(mid.version),
    });
    expect(needRef.status).toBe(400);
    const stale = await w.treasurer.c('post', `/refunds/${id}/complete`, {
      paidOutOn: '2026-11-04',
      bankReference: 'UTR123456',
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const future = await w.treasurer.c('post', `/refunds/${id}/complete`, {
      paidOutOn: '2026-12-31',
      bankReference: 'UTR123456',
      version: Number(mid.version),
    });
    expect(future.status).toBe(400);
    const done = await w.treasurer.c('post', `/refunds/${id}/complete`, {
      paidOutOn: '2026-11-04',
      bankReference: 'UTR123456',
      version: Number(mid.version),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({
      status: 'PROCESSED',
      bankReference: 'UTR123456',
      paidOutOn: '2026-11-04',
    });
    expect(done.body.data.refundNo).toMatch(/^RFD\/2026-27\/000001$/);
    expect(Number((await Payment.findByPk(payment.id))!.refundedPaise)).toBe(300_000);
    const j = journals().find((x: any) => x.voucherType === 'PAYMENT');
    expect(j).toMatchObject({ refType: 'refund', refId: id });
    expect(j.lines.find((l: any) => l.accountCode === 'MEMBER_ADVANCES').debitPaise).toBe(300_000);
    expect(j.lines.find((l: any) => l.accountCode === 'BANK').creditPaise).toBe(300_000);
    expect(await bal(w)).toBe(80_000);
    expect(await AuditLog.count({ where: { action: 'payments.refund.processed' } })).toBe(1);
    expect(
      paymentsPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.refund_processed',
      ),
    ).toBe(true);
    const again = await w.treasurer.c('post', `/refunds/${id}/complete`, {
      paidOutOn: '2026-11-04',
      bankReference: 'UTR123456',
      version: 99,
    });
    expect(again.status).toBe(409);
    // a refund of what is left: refundable shrinks
    const over = await ask(w, body(Number(payment.id), { amountPaise: 200_001 }));
    expect(over.body.code).toBe('REFUND_EXCEEDS_REFUNDABLE');
    expect(over.body.errors[0].refundablePaise).toBe(200_000);
  });

  it('cash refunds credit CASH_IN_HAND and need no bank reference', async () => {
    const { w, payment } = await advanceWorld();
    const r = await ask(w, {
      paymentId: Number(payment.id),
      amountPaise: 50_000,
      mode: 'CASH',
      payeeName: 'Rohan Sharma',
      reason: 'Event cancelled',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await approve(r.body.data.approvalRequestId, decider(w));
    const done = await w.treasurer.c('post', `/refunds/${r.body.data.id}/complete`, {
      paidOutOn: '2026-11-04',
      version: 2,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const j = journals().find((x: any) => x.voucherType === 'PAYMENT');
    expect(j.lines.find((l: any) => l.accountCode === 'CASH_IN_HAND').creditPaise).toBe(50_000);
  });

  it('rejection releases the hold (REFUND_RELEASE) and frees the open slot', async () => {
    const { w, payment } = await advanceWorld();
    const r = await ask(w, body(Number(payment.id)));
    expect(await bal(w)).toBe(80_000);
    await reject(r.body.data.approvalRequestId, 'Not allowed', decider(w));
    const row = (await Refund.findByPk(r.body.data.id))!;
    expect(row).toMatchObject({ status: 'REJECTED', rejectedReason: 'Not allowed' });
    expect(await bal(w)).toBe(380_000);
    expect((await UnitAdvance.findOne({ where: { dedupeKey: `RELEASE:refund:${row.id}` } }))!.entryType).toBe(
      'REFUND_RELEASE',
    );
    expect((await ask(w, body(Number(payment.id)))).status).toBe(201);
  });

  it('the module 14 withdrawal and expiry callbacks cancel the refund and release the hold', async () => {
    const { w, payment } = await advanceWorld();
    const r = await ask(w, body(Number(payment.id)));
    const hooks = placeholderPaymentApprovalTypes.get('PAYMENT_REFUND')!;
    await moneyTx(t => hooks.onCancelled!(ctxFor(w, w.user.id!), r.body.data.id, t));
    expect((await Refund.findByPk(r.body.data.id))!.status).toBe('CANCELLED');
    expect(await bal(w)).toBe(380_000);
  });

  it('reallocation freed by a refund stays reopened when the refund is rejected, and the advance pays it again', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const inv = await mkInvoice(w, 0, 120_000, '2026-11-10');
    const { payment } = await settle(w, offline(w, 0, 120_000));
    const r = await ask(w, body(Number(payment.id), { amountPaise: 120_000, reallocate: true }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number((await Invoice.findByPk(inv.id))!.outstandingPaise)).toBe(120_000);
    await reject(r.body.data.approvalRequestId, 'No', decider(w));
    await drainQueues();
    expect(Number((await Invoice.findByPk(inv.id))!.outstandingPaise)).toBe(0);
    expect(await bal(w)).toBe(0);
  });
});

describe('gateway refunds (6.3, T12-25)', () => {
  async function online(w: RunSociety) {
    const { payment } = await settle(
      w,
      offline(w, 0, 100_000, {
        source: 'ONLINE',
        method: 'UPI',
        status: 'CAPTURED',
        gatewayPaymentId: 'pay_g1',
        gatewayAccountId: w.society.id!,
        capturedAt: undefined,
        mode: 'OLDEST_FIRST',
      } as never),
    );
    gw.payments.set('pay_g1', {
      paymentId: 'pay_g1',
      orderId: 'o1',
      status: 'captured',
      amountPaise: 100_000,
      method: 'upi',
    });
    return payment;
  }
  const gbody = (id: number, o: Record<string, unknown> = {}) => ({
    paymentId: id,
    amountPaise: 60_000,
    mode: 'GATEWAY',
    reason: 'Duplicate payment',
    ...o,
  });

  it('approval calls the gateway refund: PROCESSING with the gateway id; refund.processed finishes it', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const p = await online(w);
    const r = await ask(w, gbody(Number(p.id)));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await approve(r.body.data.approvalRequestId, decider(w));
    const row = (await Refund.findByPk(r.body.data.id))!;
    expect(row.status).toBe('PROCESSING');
    expect(row.gatewayRefundId).toMatch(/^rfnd_/);
    expect(gw.refunds.get(row.gatewayRefundId!)!.amountPaise).toBe(60_000);
    const complete = await w.treasurer.c('post', `/refunds/${row.id}/complete`, {
      paidOutOn: '2026-11-04',
      version: Number(row.version),
    });
    expect(complete.status).toBe(409);
    const out = await handleRefundEvent(systemCtx('wh'), {
      societyId: w.society.id!,
      type: 'refund.processed',
      gatewayRefundId: row.gatewayRefundId!,
      eventId: 'evt_1',
    });
    expect(out).toBe('PROCESSED');
    expect((await Refund.findByPk(row.id))!.status).toBe('PROCESSED');
    expect(Number((await Payment.findByPk(p.id))!.refundedPaise)).toBe(60_000);
    expect(
      journals()
        .find((x: any) => x.voucherType === 'PAYMENT')
        .lines.some((l: any) => l.accountCode === 'GATEWAY_CLEARING' && l.creditPaise === 60_000),
    ).toBe(true);
    // replay is ignored
    expect(
      await handleRefundEvent(systemCtx('wh'), {
        societyId: w.society.id!,
        type: 'refund.processed',
        gatewayRefundId: row.gatewayRefundId!,
      }),
    ).toBe('IGNORED');
    expect(Number((await Payment.findByPk(p.id))!.refundedPaise)).toBe(60_000);
  });

  it('refund.failed webhook: FAILED, hold released, requester told (T12-25)', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const p = await online(w);
    const before = await bal(w);
    const r = await ask(w, gbody(Number(p.id)));
    expect(await bal(w)).toBe(before - 60_000);
    await approve(r.body.data.approvalRequestId, decider(w));
    const row = (await Refund.findByPk(r.body.data.id))!;
    const out = await handleRefundEvent(systemCtx('wh'), {
      societyId: w.society.id!,
      type: 'refund.failed',
      gatewayRefundId: row.gatewayRefundId!,
      eventId: 'evt_2',
    });
    expect(out).toBe('FAILED');
    expect((await Refund.findByPk(row.id))!.status).toBe('FAILED');
    expect(await bal(w)).toBe(before);
    await drainQueues();
    const n = paymentsPortCalls.find(
      c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.refund_failed',
    );
    expect((n!.input as any).userIds).toContain(w.user.id);
    expect(
      await handleRefundEvent(systemCtx('wh'), {
        societyId: w.society.id!,
        type: 'refund.failed',
        gatewayRefundId: 'nope',
      }),
    ).toBe('NOT_FOUND');
    expect(
      await handleRefundEvent(systemCtx('wh'), {
        societyId: w.society.id!,
        type: 'payment.captured',
        gatewayRefundId: 'x',
      }),
    ).toBe('IGNORED');
  });

  it('a gateway that refuses at approval makes the refund FAILED at once and releases the hold', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const p = await online(w);
    const before = await bal(w);
    const r = await ask(w, gbody(Number(p.id)));
    gw.failNext.refund = true;
    await approve(r.body.data.approvalRequestId, decider(w));
    const row = (await Refund.findByPk(r.body.data.id))!;
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBeTruthy();
    expect(await bal(w)).toBe(before);
    expect(await AuditLog.count({ where: { action: 'payments.refund.failed' } })).toBe(1);
  });

  it('payments:refund-status polls PROCESSING refunds older than 2 hours', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const p = await online(w);
    const r = await ask(w, gbody(Number(p.id)));
    await approve(r.body.data.approvalRequestId, decider(w));
    const row = (await Refund.findByPk(r.body.data.id))!;
    expect(await pollGatewayRefunds()).toBe(0);
    advance(3 * 3_600_000);
    expect(await pollGatewayRefunds()).toBe(0); // gateway still pending
    expect((await Refund.findByPk(row.id))!.lastCheckedAt).not.toBeNull();
    gw.refunds.get(row.gatewayRefundId!)!.status = 'processed';
    advance(2 * 3_600_000);
    expect(await pollGatewayRefunds()).toBe(1);
    expect((await Refund.findByPk(row.id))!.status).toBe('PROCESSED');
  });
});

describe('GET /refunds and /refunds/:id', () => {
  it('lists with filters and paging, and shows detail with the payment and approval', async () => {
    const { w, payment } = await advanceWorld();
    const a = await ask(w, body(Number(payment.id), { amountPaise: 100_000 }));
    await reject(a.body.data.approvalRequestId, 'No', decider(w));
    const b = await ask(w, body(Number(payment.id), { amountPaise: 200_000 }));
    const all = await w.secretary.c('get', '/refunds');
    expect(all.status).toBe(200);
    expect(all.body.pagination.total).toBe(2);
    expect(all.body.data[0].id).toBe(b.body.data.id);
    expect(all.body.data[0].unitLabel).toBe(w.units[0]!.label);
    const f = await w.c('get', '/refunds?status=REJECTED&mode=BANK_TRANSFER&sortBy=amountPaise&limit=1');
    expect(f.body.data.map((x: any) => x.id)).toEqual([a.body.data.id]);
    expect((await w.c('get', `/refunds?unitId=${w.units[1]!.id}`)).body.data).toEqual([]);
    expect((await w.c('get', '/refunds?status=BOGUS')).status).toBe(400);
    const d = await w.c('get', `/refunds/${b.body.data.id}`);
    expect(d.body.data).toMatchObject({
      status: 'PENDING_APPROVAL',
      approval: { status: 'PENDING' },
      payment: { id: Number(payment.id), amountPaise: 500_000, refundedPaise: 0 },
    });
  });

  it('another society sees 404 REFUND_NOT_FOUND (T12-34) and the refund routes exist exactly as in 8.19', async () => {
    const { w, payment } = await advanceWorld();
    const r = await ask(w, body(Number(payment.id)));
    const other = await paymentsWorld({ flats: 1 });
    const g = await other.c('get', `/refunds/${r.body.data.id}`);
    expect(g.status).toBe(404);
    expect(g.body.code).toBe('REFUND_NOT_FOUND');
    const c = await other.c('post', `/refunds/${r.body.data.id}/complete`, {
      paidOutOn: '2026-11-04',
      bankReference: 'UTR123456',
      version: 1,
    });
    expect(c.status).toBe(404);
    const p = await ask(other, body(Number(payment.id)));
    expect(p.status).toBe(404);
    expect(p.body.code).toBe('PAYMENT_NOT_FOUND');
    const mine = listRoutes(app)
      .filter(x => x.path.startsWith('/refunds'))
      .map(x => `${x.method} ${x.path}`)
      .sort();
    expect(mine).toEqual(['GET /refunds', 'GET /refunds/:id', 'POST /refunds', 'POST /refunds/:id/complete']);
  });

  it('a society suspended blocks a refund request (default policy)', async () => {
    const { w, payment } = await advanceWorld();
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.society.id! } },
    );
    await flushAcl();
    const r = await ask(w, body(Number(payment.id)));
    expect(r.status).toBe(423);
    void memberOf;
    void placeholderPaymentApprovals;
  });
});
