import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalRequest,
  AuditLog,
  Fund,
  JournalEntry,
  LedgerAccount,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { registerFundJobs } from '../../../src/modules/accounts/accounts.funds.jobs';
import { fundTransferHooks } from '../../../src/modules/accounts/accounts.funds.transfer';
import { isRegistered } from '../../../src/modules/approvals/approvals.registry';
import { decideOver } from '../../helpers/approvals-decide';
import { addBankLedger, balanceOf, ctxOf, fundIdByType, post, resetAccounts } from '../../helpers/accounts';
import { memberOf, setupSociety } from '../../helpers/society-setup';
import { resetLogins } from '../../helpers/access';

afterAll(closeDb);
beforeEach(async () => {
  resetLogins();
  await resetRateLimits();
  await resetAccounts();
  setNow('2026-11-01T04:30:00Z');
  registerFundJobs();
});

const idem = () => ({ 'Idempotency-Key': randomUUID() });

async function world(plan: 'STANDARD' | 'PREMIUM' = 'PREMIUM') {
  const w = await setupSociety({ plan });
  const sid = w.society.id!;
  await sequelize.transaction(t => ensureBooks(t, sid));
  const treasurer = await memberOf(w.society, 'treasurer');
  /** The treasurer decides in the module 14 inbox (the chairman, `w.c`, requests). */
  const approve = (id: number) => decideOver(treasurer.c as never, id);
  const reject = (id: number, reason: string) => decideOver(treasurer.c as never, id, 'reject', reason);
  return { ...w, sid, treasurer, approve, reject };
}

/** Puts money into a fund the way a system posting does (Dr bank, Cr fund). */
async function fund(w: Awaited<ReturnType<typeof world>>, fundId: number, paise: number, n = 1) {
  const code = (await LedgerAccount.findOne({
    where: { societyId: w.sid, id: (await Fund.findByPk(fundId))!.ledgerAccountId },
  }))!.code;
  const bank =
    (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '1110-001' } })) ??
    (await addBankLedger(w.sid));
  await post(ctxOf(w.society, null), {
    date: '2026-10-05',
    voucherType: 'RECEIPT',
    refType: 'test_fund_in',
    refId: `${fundId}-${n}`,
    narration: 'Contribution received',
    lines: [
      { ledgerAccountCode: bank.code, debitPaise: paise, creditPaise: 0 },
      { ledgerAccountCode: code, debitPaise: 0, creditPaise: paise },
    ],
  });
}

describe('funds list and create (BR-13-31, 8.13)', () => {
  it('lists the three seeded funds with their ledger codes and FY flows', async () => {
    const w = await world('STANDARD');
    const r = await w.c('get', '/accounts/funds');
    expect(r.status).toBe(200);
    expect(r.body.data.map((f: any) => [f.fundType, f.ledgerCode, f.balancePaise])).toEqual([
      ['SINKING', '2410', 0],
      ['REPAIR', '2420', 0],
      ['CORPUS', '2430', 0],
    ]);
    await fund(w, await fundIdByType(w.sid, 'REPAIR'), 250_000);
    const l = await w.c('get', '/accounts/funds', undefined, { query: { fundType: 'REPAIR' } });
    expect(l.body.data).toHaveLength(1);
    expect(l.body.data[0]).toMatchObject({
      balancePaise: 250_000,
      inflowFyPaise: 250_000,
      outflowFyPaise: 0,
    });
  });

  it('creates event funds 2440-001, 2440-002 on any plan, with a FUND ledger under 2440 and an audit row', async () => {
    const w = await world('STANDARD');
    const a = await w.c(
      'post',
      '/accounts/funds',
      { name: 'Ganesh Utsav 2026', purpose: 'Festival' },
      { headers: idem() },
    );
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.data).toMatchObject({
      fundType: 'COLLECTION',
      ledgerCode: '2440-001',
      balancePaise: 0,
      status: 'ACTIVE',
      version: 1,
    });
    const b = await w.c('post', '/accounts/funds', { name: 'Diwali Mela' }, { headers: idem() });
    expect(b.body.data.ledgerCode).toBe('2440-002');
    const ledger = (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '2440-001' } }))!;
    const parent = (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '2440' } }))!;
    expect([ledger.accountType, ledger.subtype, Number(ledger.parentId), ledger.name]).toEqual([
      'FUND',
      'FUND',
      Number(parent.id),
      'Ganesh Utsav 2026',
    ]);
    expect(await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.fund.created' } })).toBe(2);
  });

  it('custom funds need accounting.funds (Premium) and use 2450-NNN', async () => {
    const std = await world('STANDARD');
    const no = await std.c(
      'post',
      '/accounts/funds',
      { name: 'Lift reserve', fundType: 'CUSTOM' },
      { headers: idem() },
    );
    expect([no.status, no.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const w = await world('PREMIUM');
    const r = await w.c(
      'post',
      '/accounts/funds',
      { name: 'Lift reserve', fundType: 'CUSTOM' },
      { headers: idem() },
    );
    expect(r.status).toBe(201);
    expect(r.body.data.ledgerCode).toBe('2450-001');
  });

  it('refuses a duplicate name (case-insensitive, also a seeded one) and bad bodies', async () => {
    const w = await world();
    await w.c('post', '/accounts/funds', { name: 'Garden fund' }, { headers: idem() });
    const d = await w.c('post', '/accounts/funds', { name: '  GARDEN FUND ' }, { headers: idem() });
    expect([d.status, d.body.code]).toEqual([409, 'DUPLICATE_FUND_NAME']);
    const s = await w.c('post', '/accounts/funds', { name: 'sinking fund' }, { headers: idem() });
    expect([s.status, s.body.code]).toEqual([409, 'DUPLICATE_FUND_NAME']);
    for (const body of [
      { name: 'x' },
      { name: 'Okay name', fundType: 'SINKING' },
      { name: 'Okay name', extra: 1 },
    ]) {
      const r = await w.c('post', '/accounts/funds', body, { headers: idem() });
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  it('replays the same Idempotency-Key and creates one fund', async () => {
    const w = await world();
    const h = idem();
    const a = await w.c('post', '/accounts/funds', { name: 'Once only' }, { headers: h });
    const b = await w.c('post', '/accounts/funds', { name: 'Once only' }, { headers: h });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await Fund.count({ where: { societyId: w.sid, name: 'Once only' } })).toBe(1);
  });
});

describe('fund edit and close (BR-13-34)', () => {
  it('renames a fund and its ledger, keeps the name unique, checks the version and needs Premium', async () => {
    const w = await world();
    const c = (await w.c('post', '/accounts/funds', { name: 'Old name' }, { headers: idem() })).body.data;
    const r = await w.c('patch', `/accounts/funds/${c.id}`, {
      name: 'New name',
      purpose: 'Why',
      showToResidents: false,
      usageRequiresResolution: true,
      version: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'New name',
      purpose: 'Why',
      showToResidents: false,
      usageRequiresResolution: true,
      version: 2,
    });
    expect((await LedgerAccount.findOne({ where: { societyId: w.sid, code: c.ledgerCode } }))!.name).toBe(
      'New name',
    );
    const stale = await w.c('patch', `/accounts/funds/${c.id}`, { name: 'Again', version: 1 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const dup = await w.c('patch', `/accounts/funds/${c.id}`, { name: 'Sinking fund', version: 2 });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE_FUND_NAME']);
    const std = await world('STANDARD');
    const f = await fundIdByType(std.sid, 'REPAIR');
    const p = await std.c('patch', `/accounts/funds/${f}`, { name: 'Nope', version: 1 });
    expect([p.status, p.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });

  it('seeded funds cannot be closed; a fund with money cannot be closed; an empty one can and then rejects postings', async () => {
    const w = await world();
    const sink = await fundIdByType(w.sid, 'SINKING');
    const locked = await w.c('patch', `/accounts/funds/${sink}`, { status: 'CLOSED', version: 1 });
    expect([locked.status, locked.body.code]).toEqual([422, 'SYSTEM_ACCOUNT_LOCKED']);
    const c = (await w.c('post', '/accounts/funds', { name: 'Event fund' }, { headers: idem() })).body.data;
    await fund(w, c.id, 100_000);
    const nz = await w.c('patch', `/accounts/funds/${c.id}`, { status: 'CLOSED', version: 1 });
    expect([nz.status, nz.body.code]).toEqual([422, 'FUND_BALANCE_NOT_ZERO']);
    const e = (await w.c('post', '/accounts/funds', { name: 'Empty fund' }, { headers: idem() })).body.data;
    const ok = await w.c('patch', `/accounts/funds/${e.id}`, { status: 'CLOSED', version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('CLOSED');
    expect(await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.fund.closed' } })).toBe(1);
    await expect(fund(w, e.id, 5_000, 9)).rejects.toMatchObject({ code: 'FUND_INACTIVE' });
    const again = await w.c('patch', `/accounts/funds/${e.id}`, { name: 'Zed', version: 2 });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await w.c('get', '/accounts/funds')).body.data.map((f: any) => f.id)).not.toContain(e.id);
    expect(
      (await w.c('get', '/accounts/funds', undefined, { query: { status: 'CLOSED' } })).body.data,
    ).toHaveLength(1);
  });
});

describe('fund statement (8.13)', () => {
  it('returns opening, closing and rows with a running balance from the fund ledger', async () => {
    const w = await world();
    const repair = await fundIdByType(w.sid, 'REPAIR');
    await fund(w, repair, 300_000, 1);
    await fund(w, repair, 200_000, 2);
    const r = await w.c('get', `/accounts/funds/${repair}/statement`, undefined, {
      query: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ openingPaise: 0, closingPaise: 500_000 });
    expect(r.body.data.rows.map((x: any) => [x.inPaise, x.outPaise, x.runningPaise])).toEqual([
      [300_000, 0, 300_000],
      [200_000, 0, 500_000],
    ]);
    const later = await w.c('get', `/accounts/funds/${repair}/statement`, undefined, {
      query: { from: '2026-10-20', to: '2026-11-01' },
    });
    expect(later.body.data).toMatchObject({ openingPaise: 500_000, closingPaise: 500_000, rows: [] });
  });

  it('refuses a range over 366 days, a reversed range and another society fund', async () => {
    const w = await world();
    const f = await fundIdByType(w.sid, 'REPAIR');
    const long = await w.c('get', `/accounts/funds/${f}/statement`, undefined, {
      query: { from: '2025-01-01', to: '2026-11-01' },
    });
    expect([long.status, long.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const rev = await w.c('get', `/accounts/funds/${f}/statement`, undefined, {
      query: { from: '2026-11-01', to: '2026-10-01' },
    });
    expect(rev.status).toBe(400);
    const other = await world();
    const o = await w.c('get', `/accounts/funds/${await fundIdByType(other.sid, 'REPAIR')}/statement`);
    expect([o.status, o.body.code]).toEqual([404, 'FUND_NOT_FOUND']);
  });
});

describe('fund transfer (BR-13-33, 8.13)', () => {
  const body = (o: Record<string, unknown> = {}) => ({
    fromFundId: null,
    toFundId: null,
    amountPaise: 100_000,
    date: '2026-10-20',
    reason: 'Move to the repair work',
    ...o,
  });

  it('requests approval (202), posts a JOURNAL voucher on approval and moves the two fund balances', async () => {
    const w = await world();
    const repair = await fundIdByType(w.sid, 'REPAIR');
    const sinking = await fundIdByType(w.sid, 'SINKING');
    await fund(w, repair, 500_000);
    const r = await w.c('post', '/accounts/fund-transfers', body({ fromFundId: repair, toFundId: sinking }), {
      headers: idem(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.data).toMatchObject({ status: 'PENDING' });
    const req = (await ApprovalRequest.findByPk(r.body.data.approvalRequestId))!;
    expect([req.type, req.entityType, Number(req.entityId), Number(req.amountPaise), req.status]).toEqual([
      'FUND_TRANSFER',
      'fund',
      sinking,
      100_000,
      'PENDING',
    ]);
    expect(req.payload).toMatchObject({ fromFundId: repair, toFundId: sinking, date: '2026-10-20' });
    expect(await balanceOf(w.sid, '2420')).toBe(-500_000); // nothing moved yet
    const id = r.body.data.approvalRequestId;
    expect((await w.approve(id)).status).toBe(200);
    expect(await balanceOf(w.sid, '2420')).toBe(-400_000);
    expect(await balanceOf(w.sid, '2410')).toBe(-100_000);
    const e = (await JournalEntry.findOne({
      where: { societyId: w.sid, refType: 'fund_transfer', refId: String(id) },
    }))!;
    expect([e.voucherType, e.status, e.entryDate]).toEqual(['JOURNAL', 'POSTED', '2026-10-20']);
    expect(e.voucherNo).toMatch(/^JV\//);
    const funds = (await w.c('get', '/accounts/funds')).body.data;
    expect(funds.find((f: any) => f.id === sinking).balancePaise).toBe(100_000);
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.fund_transfer.requested' } }),
    ).toBe(1);
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.fund_transfer.posted' } }),
    ).toBe(1);
  });

  it('moves money from General (3100) into a fund and back', async () => {
    const w = await world();
    const repair = await fundIdByType(w.sid, 'REPAIR');
    const a = await w.c('post', '/accounts/fund-transfers', body({ toFundId: repair }), { headers: idem() });
    expect((await w.approve(a.body.data.approvalRequestId)).status).toBe(200);
    expect(await balanceOf(w.sid, '2420')).toBe(-100_000);
    expect(await balanceOf(w.sid, '3100')).toBe(100_000);
    const b = await w.c(
      'post',
      '/accounts/fund-transfers',
      body({ fromFundId: repair, amountPaise: 40_000 }),
      { headers: idem() },
    );
    expect((await w.approve(b.body.data.approvalRequestId)).status).toBe(200);
    expect(await balanceOf(w.sid, '2420')).toBe(-60_000);
    expect(await balanceOf(w.sid, '3100')).toBe(60_000);
  });

  it('maker-checker: the requester cannot approve; a rejection posts nothing', async () => {
    const w = await world();
    const repair = await fundIdByType(w.sid, 'REPAIR');
    const a = await w.c('post', '/accounts/fund-transfers', body({ toFundId: repair }), { headers: idem() });
    const id = a.body.data.approvalRequestId;
    expect((await decideOver(w.c as never, id)).body.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await w.reject(id, 'Not this month')).status).toBe(200);
    expect(await JournalEntry.count({ where: { societyId: w.sid, refType: 'fund_transfer' } })).toBe(0);
    expect((await ApprovalRequest.findByPk(id))!.status).toBe('REJECTED');
  });

  it('errors: same fund, not found, insufficient balance, closed fund, locked period, future date, plan', async () => {
    const w = await world();
    const repair = await fundIdByType(w.sid, 'REPAIR');
    const sinking = await fundIdByType(w.sid, 'SINKING');
    const t = (o: Record<string, unknown>) =>
      w.c('post', '/accounts/fund-transfers', body(o), { headers: idem() });
    let r = await t({ fromFundId: repair, toFundId: repair });
    expect([r.status, r.body.code]).toEqual([422, 'FUND_TRANSFER_SAME_FUND']);
    r = await t({});
    expect([r.status, r.body.code]).toEqual([422, 'FUND_TRANSFER_SAME_FUND']);
    r = await t({ toFundId: 999_999 });
    expect([r.status, r.body.code]).toEqual([404, 'FUND_NOT_FOUND']);
    r = await t({ fromFundId: repair, toFundId: sinking, amountPaise: 100 });
    expect([r.status, r.body.code]).toEqual([422, 'FUND_BALANCE_INSUFFICIENT']);
    r = await t({ toFundId: sinking, amountPaise: 99 });
    expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    r = await t({ toFundId: sinking, date: '2027-01-05' });
    expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    await sequelize.query('UPDATE society_balances SET booksLockedThrough = ? WHERE societyId = ?', {
      replacements: ['2026-10-31', w.sid],
    });
    r = await t({ toFundId: sinking });
    expect([r.status, r.body.code]).toEqual([409, 'PERIOD_LOCKED']);
    await sequelize.query('UPDATE society_balances SET booksLockedThrough = NULL WHERE societyId = ?', {
      replacements: [w.sid],
    });
    const ev = (await w.c('post', '/accounts/funds', { name: 'Closed one' }, { headers: idem() })).body.data;
    await w.c('patch', `/accounts/funds/${ev.id}`, { status: 'CLOSED', version: 1 });
    r = await t({ toFundId: ev.id });
    expect([r.status, r.body.code]).toEqual([422, 'FUND_INACTIVE']);
    const std = await world('STANDARD');
    r = await std.c(
      'post',
      '/accounts/fund-transfers',
      body({ toFundId: await fundIdByType(std.sid, 'REPAIR') }),
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });

  it('re-checks on approval: a transfer that no longer has the money fails with FUND_BALANCE_INSUFFICIENT and posts nothing', async () => {
    const w = await world();
    const repair = await fundIdByType(w.sid, 'REPAIR');
    const sinking = await fundIdByType(w.sid, 'SINKING');
    await fund(w, repair, 150_000);
    const a = await w.c(
      'post',
      '/accounts/fund-transfers',
      body({ fromFundId: repair, toFundId: sinking, amountPaise: 120_000 }),
      { headers: idem() },
    );
    // a second transfer out of the repair fund (another entity: the fund it names) is approved first
    const b = await w.c(
      'post',
      '/accounts/fund-transfers',
      body({ fromFundId: repair, amountPaise: 100_000 }),
      { headers: idem() },
    );
    expect((await w.approve(b.body.data.approvalRequestId)).status).toBe(200);
    const late = await w.approve(a.body.data.approvalRequestId);
    expect([late.status, late.body.code]).toEqual([422, 'FUND_BALANCE_INSUFFICIENT']);
    expect((await ApprovalRequest.findByPk(a.body.data.approvalRequestId))!.status).toBe('PENDING');
    expect(await balanceOf(w.sid, '2420')).toBe(-50_000);
    expect(await JournalEntry.count({ where: { societyId: w.sid, refType: 'fund_transfer' } })).toBe(1);
  });

  it('registers FUND_TRANSFER with module 14 and describes the fund', async () => {
    const w = await world();
    expect(isRegistered('FUND_TRANSFER')).toBe(true);
    const repair = await fundIdByType(w.sid, 'REPAIR');
    expect(await fundTransferHooks.describe(repair)).toEqual([
      { label: 'Fund', value: 'Repair and maintenance fund' },
    ]);
  });
});
