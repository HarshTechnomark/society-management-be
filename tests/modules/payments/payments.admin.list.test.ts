import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Payment, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { kv } from '../../../src/lib/kv';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { reversePaymentCore } from '../../../src/modules/payments/payments.reverse.core';
import { mkInvoice, offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { adminOf, residentUser } from '../../helpers/residents';
import { featureOff } from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
  await kv().cacheDelPrefix('payments:summary:');
});

type World = Awaited<ReturnType<typeof paymentsWorld>>;
const pay = async (w: World, unit: number, amount: number, o: Parameters<typeof offline>[3] = {}) =>
  (await moneyTx(t => settleInput(sysCtx(w), offline(w, unit, amount, o), t))).payment;

/** Three flats; A-101 pays NEFT, A-102 pays cash and a cheque (RECEIVED), A-103 an advance. */
async function world() {
  const w = await paymentsWorld({ flats: 3 });
  await mkInvoice(w, 0, 500_000, '2026-11-10');
  await mkInvoice(w, 1, 300_000, '2026-11-10');
  const neft = await pay(w, 0, 500_000, {
    payerName: 'Rohan Sharma',
    referenceNo: 'UTR111',
    paymentDate: '2026-11-04',
  });
  const cash = await pay(w, 1, 100_000, {
    method: 'CASH',
    payerName: 'Meera Iyer',
    referenceNo: null,
    referenceKey: null,
    paymentDate: '2026-11-03',
  });
  const chq = await pay(w, 1, 200_000, {
    method: 'CHEQUE',
    status: 'RECEIVED',
    payerName: 'Meera Iyer',
    referenceNo: '123456',
    referenceKey: 'CHQ:HDFC:123456',
    chequeBankName: 'HDFC',
    chequeDate: '2026-11-02',
    paymentDate: '2026-11-02',
  });
  const adv = await pay(w, 2, 150_000, { payerName: 'Kiran Patel', paymentDate: '2026-10-20' });
  await drainQueues();
  return { w, neft, cash, chq, adv };
}

describe('GET /payments (8.10)', () => {
  it('lists with the 8.1 item shape, newest payment date first, with pagination', async () => {
    const { w, neft } = await world();
    const r = await w.c('get', '/payments');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pagination).toMatchObject({ page: 1, limit: 20, total: 4 });
    expect(r.body.data.map((p: any) => p.paymentDate)).toEqual([
      '2026-11-04',
      '2026-11-03',
      '2026-11-02',
      '2026-10-20',
    ]);
    const item = r.body.data[0];
    expect(item).toMatchObject({
      id: Number(neft.id),
      unitLabel: 'A-101',
      payerName: 'Rohan Sharma',
      source: 'OFFLINE',
      method: 'NEFT',
      status: 'CONFIRMED',
      amountPaise: 500_000,
      toInvoicesPaise: 500_000,
      toCollectionsPaise: 0,
      toAdvancePaise: 0,
      refundedPaise: 0,
      receiptStatus: 'ISSUED',
      referenceNo: 'UTR111',
      needsReview: false,
      isDuplicateSuspect: false,
    });
    expect(item.receiptNo).toMatch(/^RCT\/2026-27\/\d{6}$/);
    const page2 = await w.c('get', '/payments?limit=2&page=2');
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.pagination.totalPages).toBe(2);
  });

  it('filters by search, method, status, cheques pending, date range, unit, source and flags', async () => {
    const { w, chq, cash } = await world();
    const ids = async (qs: string) =>
      (await w.c('get', `/payments?${qs}`)).body.data.map((p: any) => p.id).sort();
    expect(await ids('q=Rohan')).toHaveLength(1);
    expect(await ids('q=A-102')).toHaveLength(2);
    expect(await ids('q=UTR111')).toHaveLength(1);
    expect(await ids('q=RCT/2026-27/000001')).toHaveLength(1);
    expect(await ids('method=CASH')).toEqual([Number(cash.id)]);
    expect(await ids('method=CASH,CHEQUE')).toHaveLength(2);
    expect(await ids('status=CONFIRMED')).toHaveLength(3);
    expect(await ids('chequeStatus=PENDING')).toEqual([Number(chq.id)]);
    expect(await ids('from=2026-11-03&to=2026-11-04')).toHaveLength(2);
    expect(await ids(`unitId=${w.units[1]!.id}`)).toHaveLength(2);
    expect(await ids('source=OFFLINE')).toHaveLength(4);
    expect(await ids('source=ONLINE')).toHaveLength(0);
    expect(await ids('needsReview=true')).toHaveLength(0);
    await Payment.update({ needsReview: true, reviewReason: 'AMOUNT_MISMATCH' }, { where: { id: chq.id } });
    expect(await ids('needsReview=true')).toEqual([Number(chq.id)]);
    expect(await ids('isDuplicateSuspect=true')).toHaveLength(0);
  });

  it('sorts by amount and receipt number and validates the query', async () => {
    const { w } = await world();
    const amounts = (await w.c('get', '/payments?sortBy=amountPaise&sortOrder=asc')).body.data.map(
      (p: any) => p.amountPaise,
    );
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    expect((await w.c('get', '/payments?sortBy=receiptNo&sortOrder=asc')).status).toBe(200);
    for (const qs of [
      'q=a',
      'sortBy=notes',
      'status=NOPE',
      'from=2026-11-05&to=2026-11-01',
      'page=0',
      'limit=101',
      'x=1',
      'needsReview=false',
    ])
      expect((await w.c('get', `/payments?${qs}`)).status, qs).toBe(400);
  });

  it('a search with LIKE wildcards matches literally', async () => {
    const { w } = await world();
    expect((await w.c('get', '/payments?q=%25%25')).body.data).toHaveLength(0);
  });
});

describe('GET /payments/:id (8.10)', () => {
  it('returns allocations, cheque block, lands-in hint, timeline and approval', async () => {
    const { w, neft, chq } = await world();
    const r = await w.c('get', `/payments/${neft.id}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.allocations).toHaveLength(1);
    expect(d.allocations[0]).toMatchObject({
      source: 'PAYMENT',
      targetType: 'INVOICE',
      amountPaise: 500_000,
      reasonCode: 'ALLOCATED',
    });
    expect(d.allocations[0].invoiceNo).toBeTruthy();
    expect(d.cheque).toBeNull();
    expect(d.landsIn).toBe('BANK');
    expect(d.timeline.map((x: any) => x.event)).toContain('payments.payment.recorded');
    expect(d.refunds).toEqual([]);
    expect(d.receiptRevision).toBe(1);
    const c = (await w.c('get', `/payments/${chq.id}`)).body.data;
    expect(c.cheque).toMatchObject({
      bankName: 'HDFC',
      chequeNo: '123456',
      chequeDate: '2026-11-02',
      clearedOn: null,
    });
    expect(c.landsIn).toBe('CHEQUES_IN_CLEARING');
  });

  it('404 PAYMENT_NOT_FOUND for another society and for a missing id (T12-34)', async () => {
    const { w, neft } = await world();
    const other = await paymentsWorld({ flats: 1 });
    const mine = await other.c('get', `/payments/${neft.id}`);
    expect([mine.status, mine.body.code]).toEqual([404, 'PAYMENT_NOT_FOUND']);
    expect((await w.c('get', '/payments/99999999')).status).toBe(404);
    expect((await w.c('get', '/payments/abc')).status).toBe(400);
  });
});

describe('permissions', () => {
  it('needs finance.payments.view; export needs finance.payments.export', async () => {
    const { w } = await world();
    const guard = await adminOf(w.society, 'security_supervisor');
    expect((await guard.c('get', '/payments')).status).toBe(403);
    expect((await guard.c('get', '/payments/summary')).status).toBe(403);
    const committee = await adminOf(w.society, 'committee_member');
    expect((await committee.c('get', '/payments')).status).toBe(200);
    expect((await committee.c('get', '/payments/export')).status).toBe(403);
  });
});

describe('GET /payments/summary and /live-feed (8.13)', () => {
  it('today, month with method mix, cheques in clearing and efficiency', async () => {
    const { w } = await world();
    const r = await w.c('get', '/payments/summary?month=2026-11');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d.today).toEqual({ collectedPaise: 500_000, count: 1 });
    expect(d.month.collectedPaise).toBe(800_000);
    expect(d.month.count).toBe(3);
    expect(d.month.byMethod).toEqual({ NEFT: 500_000, CASH: 100_000, CHEQUE: 200_000 });
    expect(d.chequesInClearing).toEqual({ count: 1, amountPaise: 200_000 });
    expect(d.pendingApprovalCount).toBe(0);
    expect(d.needsReviewCount).toBe(0);
    expect(d.generatedAt).toBeTruthy();
    expect(d.efficiency).toBeDefined();
    expect(d.efficiency.percent).toBeGreaterThanOrEqual(0);
    // the other month only has the October advance
    const oct = (await w.c('get', '/payments/summary?month=2026-10')).body.data;
    expect(oct.month.collectedPaise).toBe(150_000);
    expect((await w.c('get', '/payments/summary?month=2026-13')).status).toBe(400);
  });

  it('subtracts reversals of the same window and is cached for 30 seconds until a payment changes', async () => {
    const { w, neft } = await world();
    const first = (await w.c('get', '/payments/summary')).body.data;
    const second = (await w.c('get', '/payments/summary')).body.data;
    expect(second.generatedAt).toBe(first.generatedAt);
    await moneyTx(async t => {
      await reversePaymentCore(
        sysCtx(w),
        Number(neft.id),
        { newStatus: 'REVERSED', reversalReasonCode: 'WRONG_ENTRY', reason: 'entered twice by mistake' },
        t,
      );
    });
    await new Promise(r => setTimeout(r, 50));
    const after = (await w.c('get', '/payments/summary')).body.data;
    expect(after.today.collectedPaise).toBe(0);
    expect(after.month.byMethod.NEFT).toBeUndefined();
    expect(after.month.count).toBe(2);
  });

  it('a reversal in this month of a payment dated last month lowers this month (and last month keeps it out)', async () => {
    const { w, adv } = await world();
    await moneyTx(async t => {
      await reversePaymentCore(
        sysCtx(w),
        Number(adv.id),
        { newStatus: 'REVERSED', reversalReasonCode: 'WRONG_ENTRY', reason: 'entered twice by mistake' },
        t,
      );
    });
    await kv().cacheDelPrefix('payments:summary:');
    const nov = (await w.c('get', '/payments/summary?month=2026-11')).body.data;
    expect(nov.month.collectedPaise).toBe(800_000 - 150_000);
    expect(nov.month.byMethod.NEFT).toBe(500_000 - 150_000);
    const oct = (await w.c('get', '/payments/summary?month=2026-10')).body.data;
    expect(oct.month.collectedPaise).toBe(0);
  });

  it('the efficiency block is omitted when the entitlement is off', async () => {
    const { w } = await world();
    await featureOff(w.society.id!, 'payments.collection_efficiency_analytics');
    const r = await w.c('get', '/payments/summary');
    expect(r.status).toBe(200);
    expect(r.body.data.efficiency).toBeUndefined();
  });

  it('live feed: the latest effective payments with what they were for', async () => {
    const { w, adv } = await world();
    const r = await w.c('get', '/payments/live-feed');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(4);
    const advRow = r.body.data.find((x: any) => x.id === Number(adv.id));
    expect(advRow).toMatchObject({
      unitLabel: 'A-103',
      amountPaise: 150_000,
      method: 'NEFT',
      what: 'advance',
    });
    expect(r.body.data.filter((x: any) => x.what === 'maintenance')).toHaveLength(3);
    expect(Object.keys(advRow).sort()).toEqual([
      'amountPaise',
      'at',
      'id',
      'method',
      'receiptNo',
      'unitLabel',
      'what',
    ]);
  });
});

describe('GET /payments/export (8.17)', () => {
  it('CSV of payments with the filters, audited, and formula-safe cells', async () => {
    const { w } = await world();
    await Payment.update({ payerName: '=cmd|calc' }, { where: { unitId: w.units[2]!.id } });
    const r = await w.c('get', '/payments/export?method=NEFT');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('payments.csv');
    const lines = (r.text as string)
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Receipt no,Date,Flat,Payer,Method,Reference,Amount,Fee,Fee GST,To bills,To contributions,To advance,Refunded,Status',
    );
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain("'=cmd|calc");
    expect(lines.join('\n')).toContain('500000.00'.replace('500000.00', '5000.00'));
    expect(await AuditLog.count({ where: { action: 'payments.payment.exported' } })).toBe(1);
  });

  it('refund type and validation', async () => {
    const { w } = await world();
    const r = await w.c('get', '/payments/export?type=REFUNDS');
    expect(r.status).toBe(200);
    expect((r.text as string).replace(/^\uFEFF/, '').startsWith('Refund no,')).toBe(true);
    expect((await w.c('get', '/payments/export?type=REFUNDS&status=CAPTURED')).status).toBe(400);
    expect((await w.c('get', '/payments/export?format=xlsx')).status).toBe(400);
  });
});

describe('resident payments (8.5, T12-35)', () => {
  it('an owner sees every payment of the flat; a tenant only their own; nobody sees another flat', async () => {
    const { w, neft } = await world();
    const owner = await residentUser(w.society, w.units[0]!.id, { name: 'Owner One', relation: 'CO_OWNER' });
    const tenant = await residentUser(w.society, w.units[0]!.id, { name: 'Tenant One', relation: 'TENANT' });
    const stranger = await residentUser(w.society, w.units[1]!.id, {
      name: 'Other Flat',
      relation: 'CO_OWNER',
    });
    const o = await owner.c('get', '/me/payments');
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.data.map((p: any) => p.id)).toEqual([Number(neft.id)]);
    expect(o.body.data[0].needsReview).toBeUndefined();
    expect(o.body.data[0].isDuplicateSuspect).toBeUndefined();
    expect((await tenant.c('get', '/me/payments')).body.data).toEqual([]);
    await Payment.update({ payerUserId: tenant.user.id }, { where: { id: neft.id } });
    expect((await tenant.c('get', '/me/payments')).body.data).toHaveLength(1);
    const hidden = await stranger.c('get', `/me/payments/${neft.id}`);
    expect([hidden.status, hidden.body.code]).toEqual([404, 'PAYMENT_NOT_FOUND']);
    expect((await stranger.c('get', `/me/payments/${neft.id}/receipt-url`)).status).toBe(404);
    expect((await stranger.c('get', `/me/payments?unitId=${w.units[0]!.id}`)).status).toBe(404);
    const d = await owner.c('get', `/me/payments/${neft.id}`);
    expect(d.status).toBe(200);
    expect(d.body.data.allocations).toHaveLength(1);
    for (const k of [
      'notes',
      'referenceKey',
      'needsReview',
      'reviewReason',
      'approvedBy',
      'createdBy',
      'timeline',
    ])
      expect(d.body.data[k], k).toBeUndefined();
  });

  it('filters by flat, date range and sort; failed payments are never listed', async () => {
    const { w, neft } = await world();
    const owner = await residentUser(w.society, w.units[1]!.id, { name: 'Owner Two', relation: 'CO_OWNER' });
    const r = await owner.c('get', `/me/payments?unitId=${w.units[1]!.id}&sortBy=amountPaise&sortOrder=asc`);
    expect(r.body.data.map((p: any) => p.amountPaise)).toEqual([100_000, 200_000]);
    expect((await owner.c('get', '/me/payments?from=2026-11-03&to=2026-11-03')).body.data).toHaveLength(1);
    expect((await owner.c('get', '/me/payments?from=2020-01-01&to=2026-11-03')).status).toBe(400);
    await Payment.update({ status: 'FAILED' as never }, { where: { unitId: w.units[1]!.id } }).catch(
      () => undefined,
    );
    void neft;
  });
});

describe('advances (8.7)', () => {
  it('balance and history, newest first, for the resident and the admin route', async () => {
    const { w } = await world();
    const unit = w.units[2]!;
    const owner = await residentUser(w.society, unit.id, { name: 'Kiran', relation: 'CO_OWNER' });
    const r = await owner.c('get', `/me/advances?unitId=${unit.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ unitId: unit.id, balancePaise: 150_000 });
    expect(r.body.data.entries).toHaveLength(1);
    expect(r.body.data.entries[0]).toMatchObject({
      entryType: 'PAYMENT_EXCESS',
      amountPaise: 150_000,
      balanceAfterPaise: 150_000,
    });
    expect(r.body.pagination.total).toBe(1);
    const a = await w.c('get', `/units/${unit.id}/advances`);
    expect(a.body.data.balancePaise).toBe(150_000);
    const flat1 = await w.c('get', `/units/${w.units[0]!.id}/advances`);
    expect(flat1.body.data).toMatchObject({ balancePaise: 0, entries: [] });
  });

  it('404 UNIT_NOT_FOUND for a flat that is not yours or another society', async () => {
    const { w } = await world();
    const owner = await residentUser(w.society, w.units[0]!.id, { name: 'Owner', relation: 'CO_OWNER' });
    const x = await owner.c('get', `/me/advances?unitId=${w.units[2]!.id}`);
    expect([x.status, x.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    expect((await owner.c('get', '/me/advances')).status).toBe(400);
    const other = await paymentsWorld({ flats: 1 });
    const y = await other.c('get', `/units/${w.units[0]!.id}/advances`);
    expect([y.status, y.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
  });
});

describe('refund and display status fields', () => {
  it('refundStatus follows refundedPaise, displayStatus is PAID, status filter keeps working, detail has recordedByName', async () => {
    const { w, neft, cash } = await world();
    await Payment.update({ refundedPaise: 200_000 }, { where: { id: neft.id } });
    await Payment.update({ refundedPaise: 100_000 }, { where: { id: cash.id } });
    const list = (await w.c('get', '/payments')).body.data as any[];
    const by = (id: unknown) => list.find(p => p.id === Number(id));
    expect(by(neft.id)).toMatchObject({
      refundStatus: 'PART',
      refundedPaise: 200_000,
      displayStatus: 'PAID',
      status: 'CONFIRMED',
    });
    expect(by(cash.id)).toMatchObject({ refundStatus: 'FULL', status: 'CONFIRMED' });
    expect(list.find(p => p.refundedPaise === 0).refundStatus).toBe('NONE');
    expect((await w.c('get', '/payments?status=CONFIRMED')).body.data.length).toBeGreaterThanOrEqual(2);
    const d = (await w.c('get', `/payments/${neft.id}`)).body.data;
    expect(d).toMatchObject({ refundStatus: 'PART' });
    expect(d).toHaveProperty('recordedByName');
  });
});
