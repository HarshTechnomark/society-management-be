import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JournalEntry, LedgerAccount, SocietyBalance, closeDb, sequelize } from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { accountsPortCalls, setAccountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { registerAccounts } from '../../../src/modules/accounts/accounts.public';
import * as periods from '../../../src/modules/accounts/accounts.periods.service';
import { registerDepositHooks } from '../../../src/modules/accounts/accounts.periods.jobs';
import { committeeApprove, committeeReject } from '../../helpers/approvals-decide';
import { ApprovalRequest } from '../../../src/models';
import { ctxFor } from '../../helpers/billing-invoices';
import { idemH, type RunSociety } from '../../helpers/billing-runs';
import { paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { addBankLedger, balanceOf, post, useRealJournal } from '../../helpers/accounts';

beforeAll(() => {
  try {
    registerAccounts();
  } catch {
    // already registered by another file in this worker
  }
});
afterAll(async () => {
  await drainQueues();
  await closeDb();
});

let w: RunSociety;
let admin: ReturnType<typeof ctxFor>;
const sid = () => w.society.id!;
const books = async () => (await SocietyBalance.findOne({ where: { societyId: sid() } }))!;

beforeEach(async () => {
  await resetPayments();
  setAccountsPorts();
  useRealJournal();
  registerDepositHooks();
  w = await paymentsWorld({ flats: 1 });
  admin = ctxFor(w, w.user.id!);
  await sequelize.transaction(t => ensureBooks(t, sid()));
  await addBankLedger(sid());
});

const income = (date: string, amount: number, refId: number) =>
  post(admin, {
    date,
    voucherType: 'RECEIPT',
    refType: 'test_income',
    refId,
    narration: 'Test income',
    lines: [
      { ledgerAccountCode: '1110-001', debitPaise: amount, creditPaise: 0 },
      { ledgerAccountCode: '4100', debitPaise: 0, creditPaise: amount },
    ],
  });
const spend = (date: string, amount: number, refId: number) =>
  post(admin, {
    date,
    voucherType: 'PAYMENT',
    refType: 'test_spend',
    refId,
    narration: 'Test spend',
    lines: [
      { ledgerAccountCode: '5600', debitPaise: amount, creditPaise: 0 },
      { ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: amount },
    ],
  });
const lock = async (through: string) =>
  periods.lockPeriod(admin, { lockThrough: through, version: (await books()).version });

describe('lock (BR-13-48, T13-28, T13-29)', () => {
  it('moves the lock date forward to a month end before the current month', async () => {
    const p = await lock('2026-09-30');
    expect(p.booksLockedThrough).toBe('2026-09-30');
    expect(p.version).toBe(2);
    expect(
      accountsPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'accounts.period_locked',
      ),
    ).toBe(true);
    await expect(lock('2026-09-30')).rejects.toMatchObject({ code: 'LOCK_DATE_INVALID' }); // not forward
    await expect(lock('2026-08-31')).rejects.toMatchObject({ code: 'LOCK_DATE_INVALID' }); // backwards
    const p2 = await lock('2026-10-31');
    expect(p2.booksLockedThrough).toBe('2026-10-31');
  });

  it('refuses a date that is not a month end, the current month and a stale version', async () => {
    await expect(lock('2026-09-15')).rejects.toMatchObject({ status: 422, code: 'LOCK_DATE_INVALID' });
    await expect(lock('2026-11-30')).rejects.toMatchObject({ status: 422, code: 'LOCK_DATE_INVALID' });
    await expect(periods.lockPeriod(admin, { lockThrough: '2026-09-30', version: 99 })).rejects.toMatchObject(
      {
        status: 409,
        code: 'STALE_VERSION',
      },
    );
  });

  it('pending drafts dated on or before the lock block it with the list', async () => {
    await JournalEntry.create({
      societyId: sid(),
      voucherNo: null,
      voucherType: 'JOURNAL',
      entryDate: '2026-09-10',
      documentDate: '2026-09-10',
      financialYear: '2026-27',
      narration: 'Pending manual journal',
      refType: 'manual_journal',
      refId: 'draft-1',
      linesHash: 'x'.repeat(64),
      source: 'MANUAL',
      status: 'DRAFT',
      totalPaise: 0,
    } as never);
    const err: any = await lock('2026-09-30').catch(e => e);
    expect(err).toMatchObject({ status: 422, code: 'LOCK_PRECONDITION_FAILED' });
    expect(err.errors[0]).toMatchObject({ type: 'journal' });
    expect((await books()).booksLockedThrough).toBeNull();
  });

  it('a user posting into the locked period is 409 PERIOD_LOCKED, a system posting is re-dated (T13-28)', async () => {
    await lock('2026-09-30');
    await expect(income('2026-09-15', 1000, 1)).rejects.toMatchObject({ status: 409, code: 'PERIOD_LOCKED' });
    const sys = await post(sysCtx(w), {
      date: '2026-09-30',
      voucherType: 'RECEIPT',
      refType: 'test_income',
      refId: 2,
      narration: 'Settlement',
      lines: [
        { ledgerAccountCode: '1110-001', debitPaise: 1000, creditPaise: 0 },
        { ledgerAccountCode: '4100', debitPaise: 0, creditPaise: 1000 },
      ],
    });
    expect(sys.entryDate).toBe('2026-10-01');
    expect((await JournalEntry.findByPk(sys.id))!.documentDate).toBe('2026-09-30');
  });

  it('GET periods reports the lock, the years and the blockers', async () => {
    await income('2026-01-10', 1000, 1);
    const p = await periods.getPeriods(sid());
    expect(p.years.map(y => y.financialYear)).toEqual(['2025-26', '2026-27']);
    expect(p.years[0]).toMatchObject({ status: 'OPEN', canClose: false });
    expect(p.years[0]!.blockers.join(' ')).toMatch(/Lock the books through 2026-03-31/);
    expect(p.years[1]!.blockers.join(' ')).toMatch(/not ended/);
  });
});

describe('temporary unlock (BR-13-49)', () => {
  const ask = (o: Record<string, unknown> = {}) =>
    periods.requestUnlock(admin, {
      fromDate: '2026-09-01',
      hours: 2,
      reason: 'Correct a September bill',
      ...o,
    });

  it('request, approval, window, hand relock and the relock job', async () => {
    await lock('2026-09-30');
    const r = await ask();
    expect(r.status).toBe('PENDING');
    const req = (await ApprovalRequest.findByPk(r.approvalRequestId))!;
    expect([req.type, req.entityType, req.payload]).toEqual([
      'PERIOD_UNLOCK',
      'society_balance',
      { fromDate: '2026-09-01', hours: 2, categoryKey: 'PERIOD_UNLOCK' },
    ]);
    await expect(ask()).rejects.toMatchObject({ status: 409, code: 'UNLOCK_ALREADY_ACTIVE' });
    await committeeApprove(r.approvalRequestId);
    const p = await periods.getPeriods(sid());
    expect(p.unlock).toMatchObject({ fromDate: '2026-09-01', approvalRequestId: r.approvalRequestId });
    await income('2026-09-15', 1000, 5); // allowed inside the window
    await expect(ask()).rejects.toMatchObject({ code: 'UNLOCK_ALREADY_ACTIVE' });
    expect(
      accountsPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'accounts.period_unlocked',
      ),
    ).toBe(true);

    advance(3 * 3_600_000);
    expect(await periods.relockJob()).toBe(1);
    expect((await periods.getPeriods(sid())).unlock).toBeNull();
    await expect(income('2026-09-16', 1000, 6)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    expect(await periods.relockJob()).toBe(0);
  });

  it('the books can be locked again by hand', async () => {
    await lock('2026-09-30');
    const r = await ask();
    await committeeApprove(r.approvalRequestId);
    const v = (await books()).version;
    await expect(periods.relockPeriod(admin, { version: v + 3 })).rejects.toMatchObject({
      code: 'STALE_VERSION',
    });
    const p = await periods.relockPeriod(admin, { version: v });
    expect(p.unlock).toBeNull();
    await expect(periods.relockPeriod(admin, { version: p.version })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('a rejected request leaves the books locked and lets the next request through', async () => {
    await lock('2026-09-30');
    const r = await ask();
    await committeeReject(r.approvalRequestId, 'Not needed');
    expect((await periods.getPeriods(sid())).unlock).toBeNull();
    await expect(income('2026-09-15', 1000, 7)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    expect((await ask()).status).toBe('PENDING');
  });

  it('validates the hours, the first-of-month date and that the date is locked', async () => {
    await lock('2026-09-30');
    await expect(ask({ hours: 500 })).rejects.toMatchObject({ status: 400 });
    await expect(ask({ fromDate: '2026-09-10' })).rejects.toMatchObject({ code: 'LOCK_DATE_INVALID' });
    await expect(ask({ fromDate: '2026-10-01' })).rejects.toMatchObject({ code: 'LOCK_DATE_INVALID' });
  });
});

describe('financial year close (BR-13-50, T13-30)', () => {
  async function yearWorld() {
    await income('2026-01-10', 100_000, 1);
    await spend('2026-02-10', 30_000, 1);
  }
  const close = async (fy = '2025-26') =>
    periods.requestYearClose(admin, fy, { confirm: true, version: (await books()).version });

  it('refuses while the preconditions fail, then posts the CLOSING voucher and sets the closed year', async () => {
    await yearWorld();
    const err: any = await close().catch(e => e);
    expect(err).toMatchObject({ status: 422, code: 'YEAR_CLOSE_PRECONDITION' });
    expect(err.errors.map((e: any) => e.message).join(' ')).toMatch(/Lock the books through 2026-03-31/);
    await close('2026-27').catch(e => expect(e).toMatchObject({ code: 'YEAR_CLOSE_PRECONDITION' }));

    await lock('2026-03-31');
    const { jobId } = await close();
    expect(jobId).toBe(`year-close:${sid()}:2025-26`);
    await drainQueues();

    expect((await books()).lastClosedFinancialYear).toBe('2025-26');
    expect(await balanceOf(sid(), '4100')).toBe(0);
    expect(await balanceOf(sid(), '5600')).toBe(0);
    expect(await balanceOf(sid(), '3100')).toBe(-70_000); // surplus = income - expense
    const e = (await JournalEntry.findOne({ where: { societyId: sid(), voucherType: 'CLOSING' } }))!;
    expect([e.entryDate, e.status, e.financialYear]).toEqual(['2026-03-31', 'POSTED', '2025-26']);
    expect(await LedgerAccount.sum('balancePaise', { where: { societyId: sid() } })).toBe(0);
    expect(
      accountsPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'accounts.year_closed',
      ),
    ).toBe(true);

    await expect(close()).rejects.toMatchObject({ status: 409, code: 'YEAR_ALREADY_CLOSED' });
    await expect(income('2026-02-01', 1000, 9)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    const sys = await post(sysCtx(w), {
      date: '2026-03-20',
      voucherType: 'RECEIPT',
      refType: 'test_income',
      refId: 10,
      narration: 'Late settlement',
      lines: [
        { ledgerAccountCode: '1110-001', debitPaise: 500, creditPaise: 0 },
        { ledgerAccountCode: '4100', debitPaise: 0, creditPaise: 500 },
      ],
    });
    expect(sys.entryDate).toBe('2026-04-01');
    const p = await periods.getPeriods(sid());
    expect(p.lastClosedFinancialYear).toBe('2025-26');
    expect(p.years[0]).toMatchObject({ status: 'CLOSED', canClose: false });
  });

  it('an open temporary unlock, a pending expense and a pending journal block the close', async () => {
    await yearWorld();
    await lock('2026-03-31');
    const r = await periods.requestUnlock(admin, {
      fromDate: '2026-03-01',
      hours: 5,
      reason: 'Fix a March entry',
    });
    await committeeApprove(r.approvalRequestId);
    const err: any = await close().catch(e => e);
    expect(err.errors.map((e: any) => e.message).join(' ')).toMatch(/temporary unlock/);
    await periods.relockPeriod(admin, { version: (await books()).version });
    await JournalEntry.create({
      societyId: sid(),
      voucherNo: null,
      voucherType: 'JOURNAL',
      entryDate: '2026-03-15',
      documentDate: '2026-03-15',
      financialYear: '2025-26',
      narration: 'Pending journal',
      refType: 'manual_journal',
      refId: 'draft-2',
      linesHash: 'y'.repeat(64),
      source: 'MANUAL',
      status: 'PENDING_APPROVAL',
      totalPaise: 0,
    } as never);
    const err2: any = await close().catch(e => e);
    expect(err2.errors.map((e: any) => e.message).join(' ')).toMatch(/journal/);
  });

  it('the job is safe to run twice and aborts when the year is already closed', async () => {
    await yearWorld();
    await lock('2026-03-31');
    const first = await periods.yearCloseJob({ societyId: sid(), financialYear: '2025-26' });
    expect(first).toEqual({ vouchers: 1, closed: true });
    expect(await periods.yearCloseJob({ societyId: sid(), financialYear: '2025-26' })).toEqual({
      vouchers: 0,
      closed: false,
    });
  });

  it('more than 199 leaves split into several CLOSING vouchers', async () => {
    await income('2026-01-10', 1000, 1);
    // 2025-26 has an income line: add 200 more expense leaves in a second posting to force two vouchers
    const group = (await LedgerAccount.findOne({
      where: { societyId: sid(), accountType: 'EXPENSE', isGroup: true },
    }))!;
    await Promise.all(
      Array.from({ length: 205 }, (_v, i) =>
        LedgerAccount.create({
          societyId: sid(),
          code: `5990-${String(i + 1).padStart(3, '0')}`,
          name: `Bulk expense ${i + 1}`,
          accountType: 'EXPENSE',
          subtype: 'OTHER',
          parentId: group.id,
        } as never),
      ),
    );
    for (let b = 0; b < 2; b++) {
      const n = b === 0 ? 100 : 105;
      const lines = Array.from({ length: n }, (_v, i) => ({
        ledgerAccountCode: `5990-${String(b * 100 + i + 1).padStart(3, '0')}`,
        debitPaise: 10,
        creditPaise: 0,
      }));
      lines.push({ ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: 10 * n } as never);
      await post(admin, {
        date: '2026-02-01',
        voucherType: 'PAYMENT',
        refType: 'bulk_spend',
        refId: b + 1,
        narration: 'Bulk spend',
        lines,
      });
    }
    await lock('2026-03-31');
    const r = await periods.yearCloseJob({ societyId: sid(), financialYear: '2025-26' });
    expect(r).toEqual({ vouchers: 2, closed: true });
    expect(await balanceOf(sid(), '5990-001')).toBe(0);
    expect(await balanceOf(sid(), '3100')).toBe(-(1000 - 2050));
  });
});

describe('routes (8.18)', () => {
  it('lock and unlock-request over HTTP; stale version and bad body are rejected', async () => {
    const g = await w.c('get', '/accounts/periods');
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const v = g.body.data.version;
    const bad = await w.c('post', '/accounts/period-lock', {
      lockThrough: '2026-09-30',
      version: v,
      extra: 1,
    });
    expect(bad.status).toBe(400);
    const stale = await w.c('post', '/accounts/period-lock', { lockThrough: '2026-09-30', version: v + 4 });
    expect(stale.body.code).toBe('STALE_VERSION');
    const ok = await w.c('post', '/accounts/period-lock', { lockThrough: '2026-09-30', version: v });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.booksLockedThrough).toBe('2026-09-30');
    const un = await w.c(
      'post',
      '/accounts/period-lock/unlock-requests',
      { fromDate: '2026-09-01', hours: 3, reason: 'Fix September entries' },
      { headers: idemH() },
    );
    expect(un.status, JSON.stringify(un.body)).toBe(202);
    const again = await w.c(
      'post',
      '/accounts/period-lock/unlock-requests',
      { fromDate: '2026-09-01', hours: 3, reason: 'Fix September entries' },
      { headers: idemH() },
    );
    expect(again.body.code).toBe('UNLOCK_ALREADY_ACTIVE');
    const g2 = await w.c('get', '/accounts/periods');
    expect(g2.body.data.maxUnlockHours).toBe(72);
    expect(g2.body.data.pendingUnlock).toMatchObject({
      approvalRequestId: un.body.data.approvalRequestId,
      fromDate: '2026-09-01',
      hours: 3,
      reason: 'Fix September entries',
    });
  });

  it('year close answers 202 with a job id and 422 with the reasons', async () => {
    const v = (await books()).version;
    const r = await w.c('post', '/accounts/financial-years/2025-26/close', { confirm: true, version: v });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('YEAR_CLOSE_PRECONDITION');
    const noConfirm = await w.c('post', '/accounts/financial-years/2025-26/close', { version: v });
    expect(noConfirm.status).toBe(400);
    const badFy = await w.c('post', '/accounts/financial-years/2025/close', { confirm: true, version: v });
    expect(badFy.status).toBe(400);
  });
});
