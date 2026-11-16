import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Invoice, Payment, PaymentAllocation, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { advanceBalance, applyAdvancesForUnit } from '../../../src/modules/payments/payments.advances';
import { chequeReturnCount, chequeReturnCounts } from '../../../src/modules/payments/payments.billing-hooks';
import { runChequeReminders } from '../../../src/modules/payments/payments.cheques.jobs';
import { paymentsPortCalls, setPaymentsPorts } from '../../../src/modules/payments/payments.ports';
import { memberOf } from '../../helpers/society-setup';
import { mkInvoice, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { idemH, recordAndApprove, recordOffline, decide } from '../../helpers/payments-offline';
import type { RunSociety } from '../../helpers/billing-runs';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
});

const journalCalls = () => paymentsPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any);
const received = (w: RunSociety, unitIndex: number, amountPaise: number, o: Record<string, unknown> = {}) =>
  recordAndApprove(w, unitIndex, { method: 'CHEQUE', amountPaise, ...o });
const deposit = (w: RunSociety, ids: number[], depositedOn = '2026-11-04', bankAccountId = 5) =>
  w.c('post', '/payments/cheques/deposit', { paymentIds: ids, depositedOn, bankAccountId });
const clear = (w: RunSociety, p: Payment, clearedOn = '2026-11-04') =>
  w.c('post', `/payments/${p.id}/cheque/clear`, { clearedOn, version: Number(p.version) });
const bounce = (w: RunSociety, id: number, version: number, o: Record<string, unknown> = {}) =>
  w.c(
    'post',
    `/payments/${id}/cheque/bounce`,
    { bouncedOn: '2026-11-04', reason: 'Funds insufficient', version, ...o },
    { headers: idemH() },
  );
const fresh = async (id: number) => (await Payment.findByPk(id))!;

describe('cheque lifecycle (8.12)', () => {
  it('approval makes a cheque RECEIVED with a receipt; deposit, then clear: CONTRA journal and a new receipt revision', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 200_000, '2026-11-20');
    const p = await received(w, 0, 200_000);
    expect([p.status, p.receiptStatus, Number(p.receiptRevision)]).toEqual(['RECEIVED', 'ISSUED', 1]);
    expect(p.referenceKey).toMatch(/^CHQ:hdfcbank:/);
    expect((await Invoice.findByPk(inv.id))!.status).toBe('PAID');
    expect(journalCalls().find(j => j.voucherType === 'RECEIPT').lines[0]).toMatchObject({
      accountCode: 'CHEQUES_IN_CLEARING',
      debitPaise: 200_000,
    });

    const d = await deposit(w, [Number(p.id)]);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.data).toMatchObject({
      deposited: 1,
      payments: [{ id: Number(p.id), status: 'DEPOSITED', version: 3 }],
    });
    const dep = await fresh(Number(p.id));
    expect([dep.depositedOn, Number(dep.depositBankAccountId)]).toEqual(['2026-11-04', 5]);

    const c = await clear(w, dep, '2026-11-05'.replace('05', '04'));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.status).toBe('CLEARED');
    const done = await fresh(Number(p.id));
    expect([done.clearedOn, Number(done.receiptRevision), done.receiptPdfStatus]).toEqual([
      '2026-11-04',
      2,
      'PENDING',
    ]);
    expect(journalCalls().find(j => j.voucherType === 'CONTRA').lines).toEqual([
      expect.objectContaining({ accountCode: 'BANK', debitPaise: 200_000 }),
      expect.objectContaining({ accountCode: 'CHEQUES_IN_CLEARING', creditPaise: 200_000 }),
    ]);
    for (const a of ['payments.cheque.deposited', 'payments.cheque.cleared'])
      expect(await AuditLog.count({ where: { action: a, entityId: String(p.id) } })).toBe(1);
  });

  it('T12-24: clearing a RECEIVED cheque is INVALID_STATE; a wrong version is STALE_VERSION; clear before deposit date is 400', async () => {
    const w = await paymentsWorld();
    const p = await received(w, 0, 100_000);
    const r = await clear(w, p);
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    await deposit(w, [Number(p.id)]);
    const stale = await w.c('post', `/payments/${p.id}/cheque/clear`, {
      clearedOn: '2026-11-04',
      version: 1,
    });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const future = await w.c('post', `/payments/${p.id}/cheque/clear`, {
      clearedOn: '2026-11-09',
      version: 3,
    });
    expect([future.status, future.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const before = await w.c('post', `/payments/${p.id}/cheque/clear`, {
      clearedOn: '2026-11-03',
      version: 3,
    });
    expect(before.status).toBe(400);
  });

  it('deposit batch is all or nothing: unknown id 404, a cheque not RECEIVED 409, unknown bank account 404', async () => {
    const w = await paymentsWorld();
    const a = await received(w, 0, 100_000);
    const b = await received(w, 1, 100_000);
    expect((await deposit(w, [Number(a.id), 999_999_999])).status).toBe(404);
    expect((await deposit(w, [Number(a.id), Number(b.id)])).body.data.deposited).toBe(2);
    const again = await deposit(w, [Number(a.id)]);
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    const c = await received(w, 0, 130_000);
    const mixed = await deposit(w, [Number(c.id), Number(a.id)]);
    expect(mixed.status).toBe(409);
    expect((await fresh(Number(c.id))).status).toBe('RECEIVED');
    setPaymentsPorts({ bankAccounts: { get: async () => null } });
    const nb = await deposit(w, [Number(c.id)]);
    expect([nb.status, nb.body.code]).toEqual([404, 'BANK_ACCOUNT_NOT_FOUND']);
  });

  it('a post-dated cheque cannot be deposited before its date (CHEQUE_DATE_INVALID); a future deposit date is 400', async () => {
    const w = await paymentsWorld();
    const p = await received(w, 0, 100_000, {
      cheque: { bankName: 'HDFC Bank', chequeNo: '778899', chequeDate: '2026-11-20' },
    });
    const early = await deposit(w, [Number(p.id)], '2026-11-04');
    expect([early.status, early.body.code]).toEqual([422, 'CHEQUE_DATE_INVALID']);
    expect((await deposit(w, [Number(p.id)], '2026-11-20')).status).toBe(400);
    await Payment.update({ chequeDate: '2026-11-04' } as never, { where: { id: p.id } });
    expect((await deposit(w, [Number(p.id)], '2026-11-04')).status).toBe(200);
  });

  it('T12-21: bounce with the default charge: allocations reversed, receipt CANCELLED, charge invoice, Cr CHEQUES_IN_CLEARING', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 200_000, '2026-11-20');
    const p = await received(w, 0, 200_000);
    await deposit(w, [Number(p.id)]);
    const dep = await fresh(Number(p.id));
    const r = await bounce(w, Number(p.id), Number(dep.version));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'BOUNCED', receiptStatus: 'CANCELLED' });
    expect(r.body.data.cheque).toMatchObject({ bouncedOn: '2026-11-04', bounceReason: 'Funds insufficient' });
    const b = await fresh(Number(p.id));
    expect([b.referenceKey, Number(b.toInvoicesPaise)]).toEqual([null, 0]);
    expect((await Invoice.findByPk(inv.id))!.status).toBe('ISSUED');
    expect(await PaymentAllocation.sum('amountPaise', { where: { paymentId: p.id } })).toBe(0);
    const charge = (await Invoice.findByPk(Number(b.bounceChargeInvoiceId)))!;
    expect(Number(charge.totalPaise)).toBe(50_000);
    expect(charge.dueDate).toBe('2026-11-11');
    const mirror = journalCalls()
      .filter(j => j.voucherType === 'JOURNAL' && j.refType === 'payment')
      .pop();
    expect(mirror.lines.find((l: any) => l.accountCode === 'CHEQUES_IN_CLEARING')).toMatchObject({
      creditPaise: 200_000,
    });
    for (const a of ['payments.cheque.bounced', 'payments.receipt.cancelled'])
      expect(await AuditLog.count({ where: { action: a, entityId: String(p.id) } })).toBe(1);
    const sent = paymentsPortCalls.filter(
      c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.cheque_bounced',
    );
    expect(sent.length).toBe(1);
    // the invoice-bound payer can pay again by a fresh cheque (same cheque re-presented)
    const again = await recordOffline(w, 0, {
      method: 'CHEQUE',
      amountPaise: 200_000,
      cheque: { bankName: 'HDFC Bank', chequeNo: String(p.referenceNo), chequeDate: '2026-11-04' },
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('bounce without a charge, with a custom charge, and the charge setting at 0', async () => {
    const w = await paymentsWorld();
    const mk = async (unit: number) => {
      const p = await received(w, unit, 100_000 + unit * 1000 + Math.floor(Math.random() * 500));
      await deposit(w, [Number(p.id)]);
      return fresh(Number(p.id));
    };
    const a = await mk(0);
    const ra = await bounce(w, Number(a.id), Number(a.version), { applyBounceCharge: false });
    expect(ra.body.data.cheque.bounceChargeInvoiceId).toBeNull();
    const b = await mk(1);
    const rb = await bounce(w, Number(b.id), Number(b.version), { bounceChargePaise: 75_000 });
    const inv = (await Invoice.findByPk(rb.body.data.cheque.bounceChargeInvoiceId))!;
    expect(Number(inv.totalPaise)).toBe(75_000);
    const c = await mk(0);
    const rc = await bounce(w, Number(c.id), Number(c.version), { bounceChargePaise: 0 });
    expect(rc.body.data.cheque.bounceChargeInvoiceId).toBeNull();
  });

  it('T12-23: bounce after the advance part was applied: applications reversed first, advance ends at 0, never negative', async () => {
    const w = await paymentsWorld();
    const inv1 = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const p = await received(w, 0, 300_000); // 100,000 to the invoice, 200,000 advance
    expect(Number((await fresh(Number(p.id))).toAdvancePaise)).toBe(200_000);
    const inv2 = await mkInvoice(w, 0, 150_000, '2026-12-20');
    await moneyTx(t => applyAdvancesForUnit(sysCtx(w), w.society.id!, w.units[0]!.id, t)); // the advance goes to the new invoice
    expect((await Invoice.findByPk(inv2.id))!.status).toBe('PAID');
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(50_000);
    await deposit(w, [Number(p.id)]);
    const dep = await fresh(Number(p.id));
    const r = await bounce(w, Number(p.id), Number(dep.version), { applyBounceCharge: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(0);
    expect((await Invoice.findByPk(inv1.id))!.status).toBe('ISSUED');
    expect((await Invoice.findByPk(inv2.id))!.status).not.toBe('PAID');
  });

  it('BOUNCE_WINDOW_PASSED: a cleared cheque can bounce within 30 days of clearing, not after', async () => {
    const w = await paymentsWorld();
    const p = await received(w, 0, 100_000);
    await deposit(w, [Number(p.id)]);
    await clear(w, await fresh(Number(p.id)));
    await Payment.update({ clearedOn: '2026-10-10' } as never, { where: { id: p.id } }); // 25 days ago
    const ok = await fresh(Number(p.id));
    const r1 = await bounce(w, Number(p.id), Number(ok.version), { applyBounceCharge: false });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const q = await received(w, 1, 110_000);
    await deposit(w, [Number(q.id)]);
    await clear(w, await fresh(Number(q.id)));
    await Payment.update({ clearedOn: '2026-10-03' } as never, { where: { id: q.id } }); // 32 days ago
    const late = await fresh(Number(q.id));
    const r2 = await bounce(w, Number(q.id), Number(late.version));
    expect([r2.status, r2.body.code]).toEqual([422, 'BOUNCE_WINDOW_PASSED']);
  });

  it('bounce state and version guards: a RECEIVED cheque cannot bounce; a stale version is 409', async () => {
    const w = await paymentsWorld();
    const p = await received(w, 0, 100_000);
    const r = await bounce(w, Number(p.id), Number(p.version));
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    await deposit(w, [Number(p.id)]);
    const stale = await bounce(w, Number(p.id), 1);
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const short = await bounce(w, Number(p.id), 3, { reason: 'bad' });
    expect(short.status).toBe(400);
  });

  it('return to payer: only from RECEIVED; reverses everything, status RETURNED, the cheque can be recorded again', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const p = await received(w, 0, 100_000);
    const r = await w.c('post', `/payments/${p.id}/cheque/return`, {
      reason: 'Payer asked for it back',
      version: Number(p.version),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'RETURNED', receiptStatus: 'CANCELLED' });
    expect((await Invoice.findByPk(inv.id))!.status).toBe('ISSUED');
    expect((await fresh(Number(p.id))).bounceChargeInvoiceId).toBeNull();
    expect(
      await AuditLog.count({ where: { action: 'payments.cheque.returned', entityId: String(p.id) } }),
    ).toBe(1);
    const q = await received(w, 1, 100_000);
    await deposit(w, [Number(q.id)]);
    const bad = await w.c('post', `/payments/${q.id}/cheque/return`, {
      reason: 'Too late for this',
      version: 3,
    });
    expect([bad.status, bad.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('T12-22: after two bounces in 12 months a third cheque for the flat is CHEQUE_PAYMENTS_BLOCKED; other flats and cash are fine', async () => {
    const w = await paymentsWorld();
    for (let i = 0; i < 2; i++) {
      const p = await received(w, 0, 100_000 + i * 1000);
      await deposit(w, [Number(p.id)]);
      const dep = await fresh(Number(p.id));
      expect((await bounce(w, Number(p.id), Number(dep.version), { applyBounceCharge: false })).status).toBe(
        200,
      );
    }
    const blocked = await recordOffline(w, 0, { method: 'CHEQUE', amountPaise: 90_000 });
    expect([blocked.status, blocked.body.code]).toEqual([422, 'CHEQUE_PAYMENTS_BLOCKED']);
    expect((await recordOffline(w, 1, { method: 'CHEQUE', amountPaise: 90_000 })).status).toBe(201);
    expect((await recordOffline(w, 0, { method: 'NEFT', amountPaise: 90_000 })).status).toBe(201);
    // 12 months after the oldest bounce the flat may pay by cheque again
    const oldest = await Payment.findOne({
      where: { unitId: w.units[0]!.id, status: 'BOUNCED' },
      order: [['id', 'ASC']],
    });
    await Payment.update({ bouncedOn: '2025-11-03' } as never, { where: { id: oldest!.id } });
    const later = await recordOffline(w, 0, { method: 'CHEQUE', amountPaise: 90_000 });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
  });

  it('T12-49: chequeReturnCount counts bounced and returned cheques since the date; the batch has an entry for every flat', async () => {
    const w = await paymentsWorld({ flats: 3 });
    const a = await received(w, 0, 100_000);
    await deposit(w, [Number(a.id)]);
    await bounce(w, Number(a.id), Number((await fresh(Number(a.id))).version), { applyBounceCharge: false });
    const b = await received(w, 0, 110_000);
    await w.c('post', `/payments/${b.id}/cheque/return`, {
      reason: 'Returned to payer',
      version: Number(b.version),
    });
    const c = await received(w, 0, 120_000);
    await deposit(w, [Number(c.id)]);
    await clear(w, await fresh(Number(c.id)));
    expect(await chequeReturnCount(w.society.id!, w.units[0]!.id, '2025-11-04')).toBe(2);
    const m = await chequeReturnCounts(
      w.society.id!,
      w.units.map(u => u.id),
      '2025-11-04',
    );
    expect([...m.values()]).toEqual([2, 0, 0]);
  });

  it('the cheques list filters by status, flat, text and due-for-deposit', async () => {
    const w = await paymentsWorld();
    const due = await received(w, 0, 100_000, {
      cheque: { bankName: 'Axis Bank', chequeNo: '314159', chequeDate: '2026-11-01' },
    });
    const later = await received(w, 1, 110_000, {
      cheque: { bankName: 'ICICI Bank', chequeNo: '271828', chequeDate: '2026-11-20' },
    });
    await recordOffline(w, 1, { amountPaise: 5_000 }); // cash is never listed
    await deposit(w, [Number(due.id)]);
    const all = await w.c('get', '/payments/cheques/list');
    expect(all.body.data.map((x: any) => x.id)).toEqual([Number(due.id), Number(later.id)]);
    expect(all.body.pagination.total).toBe(2);
    expect(all.body.data[0]).toMatchObject({
      unitLabel: w.units[0]!.label,
      cheque: { bankName: 'Axis Bank', chequeNo: '314159' },
    });
    const q = async (query: Record<string, string>) =>
      (await w.c('get', '/payments/cheques/list', undefined, { query })).body.data.map((x: any) => x.id);
    expect(await q({ status: 'DEPOSITED' })).toEqual([Number(due.id)]);
    expect(await q({ status: 'received,deposited' })).toHaveLength(2);
    expect(await q({ unitId: String(w.units[1]!.id) })).toEqual([Number(later.id)]);
    expect(await q({ q: 'icici' })).toEqual([Number(later.id)]);
    expect(await q({ q: '314159' })).toEqual([Number(due.id)]);
    expect(await q({ chequeFrom: '2026-11-10' })).toEqual([Number(later.id)]);
    expect(await q({ dueForDeposit: 'true' })).toEqual([]);
    await Payment.update({ chequeDate: '2026-11-01' } as never, { where: { id: later.id } });
    expect(await q({ dueForDeposit: 'true' })).toEqual([Number(later.id)]);
    expect(
      (await w.c('get', '/payments/cheques/list', undefined, { query: { status: 'NOPE' } })).status,
    ).toBe(400);
  });

  it('cheque-reminder job: one notification per society for cheques RECEIVED two or more days after their date', async () => {
    const w = await paymentsWorld();
    await received(w, 0, 100_000, {
      cheque: { bankName: 'Axis Bank', chequeNo: '112233', chequeDate: '2026-11-01' },
    });
    await received(w, 1, 100_000, {
      cheque: { bankName: 'Axis Bank', chequeNo: '112234', chequeDate: '2026-11-03' },
    });
    const before = paymentsPortCalls.length;
    expect(await runChequeReminders('2026-11-04')).toBeGreaterThanOrEqual(1);
    const calls = paymentsPortCalls
      .slice(before)
      .filter(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.cheque_deposit_due',
      );
    const mine = calls.filter(c => (c.input as any).data.societyId === w.society.id!);
    expect(mine).toHaveLength(1);
    expect((mine[0]!.input as any).data).toMatchObject({ count: 1, totalPaise: 100_000 });
  });

  it("T12-34: another society's payment id is 404 PAYMENT_NOT_FOUND on deposit, clear, bounce and return", async () => {
    const a = await paymentsWorld();
    const b = await paymentsWorld();
    const p = await received(a, 0, 100_000);
    const id = Number(p.id);
    const dep = await deposit(b, [id]);
    expect([dep.status, dep.body.code]).toEqual([404, 'PAYMENT_NOT_FOUND']);
    for (const r of [
      await b.c('post', `/payments/${id}/cheque/clear`, { clearedOn: '2026-11-04', version: 2 }),
      await bounce(b, id, 2),
      await b.c('post', `/payments/${id}/cheque/return`, { reason: 'Not theirs to return', version: 2 }),
    ])
      expect([r.status, r.body.code]).toEqual([404, 'PAYMENT_NOT_FOUND']);
    expect((await fresh(id)).status).toBe('RECEIVED');
  });

  it('T12-36: a member without finance.payments.edit gets 403 on the cheque routes', async () => {
    const w = await paymentsWorld();
    const p = await received(w, 0, 100_000);
    const member = await memberOf2(w);
    for (const [path, body] of [
      [
        '/payments/cheques/deposit',
        { paymentIds: [Number(p.id)], depositedOn: '2026-11-04', bankAccountId: 1 },
      ],
      [`/payments/${p.id}/cheque/clear`, { clearedOn: '2026-11-04', version: 2 }],
    ] as const) {
      const r = await member('post', path, body);
      expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    }
    void decide;
  });
});

async function memberOf2(w: RunSociety) {
  const m = await memberOf(w.society, 'committee_member');
  return m.c;
}
