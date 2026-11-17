import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, BalanceHistory, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { istDate, now } from '../../../src/lib/clock';
import { addDaysYmd } from '../../../src/modules/accounts/accounts.shared';
import { balance } from '../../../src/modules/accounts/accounts.public';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { fundIdByType, useRealJournal } from '../../helpers/accounts';
import { idemH, resetRuns, runSociety, type RunSociety } from '../../helpers/billing-runs';
import { memberOf } from '../../helpers/society-setup';
import { setAccountsPorts } from '../../../src/modules/accounts/accounts.ports';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetRuns();
  setAccountsPorts();
  useRealJournal();
});

const today = () => istDate(now());
const opening = (w: RunSociety, body: Record<string, unknown>) =>
  w.c('post', '/accounts/opening-balances', body, { headers: idemH() });

/** The worked opening of 8.12: bank 100,000,000 and cash 500,000 debit, sinking 60,000,000 and repair 20,000,000 credit. */
async function openStandard(w: RunSociety, asOfDate = today()) {
  const sid = w.society.id!;
  await sequelize.transaction(t => ensureBooks(t, sid));
  const bank = await sequelize.query(
    `INSERT INTO ledger_accounts (societyId, code, name, accountType, subtype, parentId, isSystem, createdAt, updatedAt)
     SELECT :sid, '1110-001', 'Bank - Test', 'ASSET', 'BANK', id, 1, NOW(3), NOW(3) FROM ledger_accounts WHERE societyId = :sid AND code = '1110'`,
    { replacements: { sid } },
  );
  void bank;
  return opening(w, {
    asOfDate,
    lines: [
      { ledgerAccountCode: '1110-001', debitPaise: 100_000_000, creditPaise: 0 },
      { ledgerAccountCode: '1120', debitPaise: 500_000, creditPaise: 0 },
      { ledgerAccountCode: '2410', debitPaise: 0, creditPaise: 60_000_000 },
      { ledgerAccountCode: '2420', debitPaise: 0, creditPaise: 20_000_000 },
    ],
  });
}

describe('GET /society-balance (8.1)', () => {
  it('a society without postings returns zeros, the three standard funds and no movements', async () => {
    const w = await runSociety({ flats: 1 });
    const r = await w.c('get', '/society-balance');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      totalPaise: 0,
      inBankPaise: 0,
      clearingPaise: 0,
      cashPaise: 0,
      chequesPaise: 0,
      investmentsPaise: 0,
      earmarkedFundsPaise: 0,
      generalPaise: 0,
      lastChangedAt: null,
      bankAccounts: [],
      movements: [],
    });
  });

  it('shows the four figures, earmarked funds, general money, fund balances and the movements after an opening', async () => {
    const w = await runSociety({ flats: 1 });
    const r0 = await openStandard(w);
    expect(r0.status, JSON.stringify(r0.body)).toBe(201);
    const r = await w.c('get', '/society-balance');
    expect(r.body.data).toMatchObject({
      totalPaise: 100_500_000,
      inBankPaise: 100_000_000,
      cashPaise: 500_000,
      earmarkedFundsPaise: 80_000_000,
      generalPaise: 20_500_000,
    });
    const sinking = r.body.data.funds.find((f: any) => f.fundType === 'SINKING');
    expect(sinking).toMatchObject({ name: 'Sinking fund', balancePaise: 60_000_000 });
    expect(Object.keys(sinking).sort()).toEqual(['balancePaise', 'fundType', 'id', 'name']);
    expect(r.body.data.movements).toHaveLength(1);
    expect(r.body.data.movements[0]).toMatchObject({
      direction: 'IN',
      deltaTotalPaise: 100_500_000,
      totalPaise: 100_500_000,
    });
    expect(typeof r.body.data.lastChangedAt).toBe('string');
  });

  it('lists the active bank accounts with a masked number and the reconciliation facts', async () => {
    const w = await runSociety({ flats: 1 });
    await openStandard(w);
    const sid = w.society.id!;
    await sequelize.query(
      `INSERT INTO bank_accounts (societyId, ledgerAccountId, displayName, bankName, ifsc, accountHolderName, accountNumberEnc,
         accountNumberLast4, accountNumberHash, isCollectionAccount, lastReconciledDate, lastReconciledBalancePaise, createdAt, updatedAt)
       SELECT :sid, id, 'HDFC Current', 'HDFC Bank', 'HDFC0001234', 'Sky CHS', 'enc', '4821', REPEAT('a', 64), 1, '2026-10-19', 99000000, NOW(3), NOW(3)
         FROM ledger_accounts WHERE societyId = :sid AND code = '1110-001'`,
      { replacements: { sid } },
    );
    const r = await w.c('get', '/society-balance');
    expect(r.body.data.bankAccounts).toEqual([
      expect.objectContaining({
        displayName: 'HDFC Current',
        maskedNumber: 'XXXXXX4821',
        ledgerCode: '1110-001',
        balancePaise: 100_000_000,
        isCollectionAccount: true,
        lastReconciledDate: '2026-10-19',
        lastReconciledBalancePaise: 99_000_000,
      }),
    ]);
    expect(JSON.stringify(r.body)).not.toContain('accountNumberEnc');
  });

  it('keeps only the last 20 movements, newest first', async () => {
    const w = await runSociety({ flats: 1 });
    await openStandard(w);
    for (let i = 0; i < 22; i++)
      expect(
        (
          await opening(w, {
            asOfDate: today(),
            lines: [{ ledgerAccountCode: '1120', debitPaise: 100 + i, creditPaise: 0 }],
          })
        ).status,
      ).toBe(201);
    const r = await w.c('get', '/society-balance');
    expect(r.body.data.movements).toHaveLength(20);
    expect(r.body.data.movements[0].totalPaise).toBeGreaterThan(r.body.data.movements[19].totalPaise);
  });

  it('shows negative general money when the funds are not backed by cash (BR-13-17)', async () => {
    const w = await runSociety({ flats: 1 });
    await sequelize.transaction(t => ensureBooks(t, w.society.id!));
    const fundId = await fundIdByType(w.society.id!, 'REPAIR');
    await opening(w, {
      asOfDate: today(),
      autoBalance: false,
      lines: [
        { ledgerAccountCode: '3900', debitPaise: 500_000, creditPaise: 0 },
        { ledgerAccountCode: 'COLLECTION_FUND', fundId, debitPaise: 0, creditPaise: 500_000 },
      ],
    });
    const r = await w.c('get', '/society-balance');
    expect(r.body.data).toMatchObject({
      totalPaise: 0,
      earmarkedFundsPaise: 500_000,
      generalPaise: -500_000,
    });
  });

  it('is open to a reader with the view key (the Auditor); works on the Starter plan (always on)', async () => {
    const starter = await runSociety({ flats: 1, plan: 'STARTER' });
    expect((await starter.c('get', '/society-balance')).status).toBe(200);
    const w = await runSociety({ flats: 1 });
    const auditor = await memberOf(w.society, 'auditor');
    expect((await auditor.c('get', '/society-balance')).status).toBe(200);
  });

  it('balance.get public reader agrees with the route', async () => {
    const w = await runSociety({ flats: 1 });
    await openStandard(w);
    const b = await balance.get(w.society.id!);
    expect(b.totalPaise).toBe(100_500_000);
    expect(b.generalPaise).toBe(20_500_000);
  });
});

describe('GET /society-balance/history (8.2)', () => {
  it('one point per day, repeating the previous value on quiet days; zero before the first posting', async () => {
    const w = await runSociety({ flats: 1 });
    const d2 = addDaysYmd(today(), -2);
    const d4 = addDaysYmd(today(), -4);
    await openStandard(w, d2);
    await opening(w, {
      asOfDate: today(),
      lines: [{ ledgerAccountCode: '1120', debitPaise: 1_000, creditPaise: 0 }],
    });
    const r = await w.c('get', '/society-balance/history', undefined, { query: { from: d4, to: today() } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pts = r.body.data.points as any[];
    expect(pts.map(p => p.date)).toEqual([d4, addDaysYmd(today(), -3), d2, addDaysYmd(today(), -1), today()]);
    expect(pts.map(p => p.totalPaise)).toEqual([0, 0, 100_500_000, 100_500_000, 100_501_000]);
    expect(pts[2]).toMatchObject({
      inBankPaise: 100_000_000,
      cashPaise: 500_000,
      clearingPaise: 0,
      chequesPaise: 0,
    });
  });

  it('a range that starts after the last posting carries the last value in', async () => {
    const w = await runSociety({ flats: 1 });
    await openStandard(w, addDaysYmd(today(), -10));
    const r = await w.c('get', '/society-balance/history', undefined, {
      query: { from: addDaysYmd(today(), -2), to: today() },
    });
    expect(r.body.data.points.map((p: any) => p.totalPaise)).toEqual([100_500_000, 100_500_000, 100_500_000]);
  });

  it('refuses a bad range with 400 VALIDATION_FAILED', async () => {
    const w = await runSociety({ flats: 1 });
    const q = (from: string, to: string) =>
      w.c('get', '/society-balance/history', undefined, { query: { from, to } });
    for (const [from, to] of [
      [today(), addDaysYmd(today(), -1)],
      [addDaysYmd(today(), -400), today()],
      [today(), addDaysYmd(today(), 3)],
      ['1999-12-31', '2000-01-05'],
      ['2026-13-40', '2026-13-41'],
    ]) {
      const r = await q(from!, to!);
      expect(r.status, `${from}..${to}`).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
    expect((await w.c('get', '/society-balance/history')).status).toBe(400);
    expect((await q(addDaysYmd(today(), -366), today())).status).toBe(200);
  });

  it('balance.history (public) returns the same points', async () => {
    const w = await runSociety({ flats: 1 });
    await openStandard(w);
    const out = await balance.history(w.society.id!, today(), today());
    expect(out.points).toEqual([expect.objectContaining({ date: today(), totalPaise: 100_500_000 })]);
    expect(await BalanceHistory.count({ where: { societyId: w.society.id! } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'accounts.opening_balance.posted' } })).toBe(1);
  });
});
