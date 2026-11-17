import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, JournalEntry, JournalLine, SocietyBalance, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { istDate, now } from '../../../src/lib/clock';
import { setAccountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { seedAccountsOpening } from '../../../seeders/accounts-opening';
import { Society } from '../../../src/models';
import { balanceOf, fundIdByType, useRealJournal } from '../../helpers/accounts';
import { idemH, resetRuns, runSociety, type RunSociety } from '../../helpers/billing-runs';
import { memberOf } from '../../helpers/society-setup';

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
const post = (w: { c: RunSociety['c'] }, body: Record<string, unknown>, headers = idemH()) =>
  w.c('post', '/accounts/opening-balances', body, { headers });

async function addBank(w: RunSociety, code = '1110-001') {
  await sequelize.transaction(t => ensureBooks(t, w.society.id!));
  await sequelize.query(
    `INSERT INTO ledger_accounts (societyId, code, name, accountType, subtype, parentId, isSystem, createdAt, updatedAt)
     SELECT :sid, :code, 'Bank - Test', 'ASSET', 'BANK', id, 1, NOW(3), NOW(3) FROM ledger_accounts WHERE societyId = :sid AND code = '1110'`,
    { replacements: { sid: w.society.id!, code } },
  );
}

describe('POST /accounts/opening-balances (8.12)', () => {
  it('worked example: bank, cash, sinking and repair fund; the 3900 line balances the voucher', async () => {
    const w = await runSociety({ flats: 1 });
    await addBank(w);
    const sid = w.society.id!;
    const sinking = await fundIdByType(sid, 'SINKING');
    const r = await post(w, {
      asOfDate: today(),
      lines: [
        { ledgerAccountCode: '1110-001', debitPaise: 100_000_000, creditPaise: 0 },
        { ledgerAccountCode: '1120', debitPaise: 500_000, creditPaise: 0 },
        { ledgerAccountCode: 'COLLECTION_FUND', fundId: sinking, debitPaise: 0, creditPaise: 60_000_000 },
        { ledgerAccountCode: '2420', debitPaise: 0, creditPaise: 20_000_000 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      replayed: false,
      totalPaise: 100_500_000,
      balancingLine: { ledgerAccountCode: '3900', debitPaise: 0, creditPaise: 20_500_000 },
    });
    const e = (await JournalEntry.findByPk(r.body.data.journalEntryId))!;
    expect(e).toMatchObject({
      voucherType: 'OPENING_BALANCE',
      refType: 'opening',
      status: 'POSTED',
      source: 'SYSTEM',
    });
    expect(e.voucherNo).toMatch(/^[A-Z]+\//);
    expect(Number(e.totalPaise)).toBe(100_500_000);
    expect(await JournalLine.count({ where: { journalEntryId: e.id } })).toBe(5);
    expect(await balanceOf(sid, '1110-001')).toBe(100_000_000);
    expect(await balanceOf(sid, '1120')).toBe(500_000);
    expect(await balanceOf(sid, '2410')).toBe(-60_000_000);
    expect(await balanceOf(sid, '2420')).toBe(-20_000_000);
    expect(await balanceOf(sid, '3900')).toBe(-20_500_000);
    const b = (await SocietyBalance.findOne({ where: { societyId: sid } }))!;
    expect([b.inBankPaise, b.cashPaise, b.totalPaise, b.earmarkedFundsPaise].map(Number)).toEqual([
      100_000_000, 500_000, 100_500_000, 80_000_000,
    ]);
    expect(
      await AuditLog.count({ where: { action: 'accounts.opening_balance.posted', entityId: String(e.id) } }),
    ).toBe(1);
  });

  it('the refId is the Idempotency-Key: the same key and body replays (one entry); the same key with another body is 409', async () => {
    const w = await runSociety({ flats: 1 });
    const headers = idemH();
    const body = {
      asOfDate: today(),
      lines: [{ ledgerAccountCode: '1120', debitPaise: 10_000, creditPaise: 0 }],
    };
    const a = await post(w, body, headers);
    const b = await post(w, body, headers);
    expect(a.status).toBe(201);
    expect(b.body.data.journalEntryId).toBe(a.body.data.journalEntryId);
    expect(
      await JournalEntry.count({ where: { societyId: w.society.id!, voucherType: 'OPENING_BALANCE' } }),
    ).toBe(1);
    expect(await balanceOf(w.society.id!, '1120')).toBe(10_000);
    const c = await post(w, { ...body, narration: 'Other body' }, headers);
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a debit-only line set is balanced to 3900 debit side when credits exceed (credit-heavy gives a debit line)', async () => {
    const w = await runSociety({ flats: 1 });
    const r = await post(w, {
      asOfDate: today(),
      lines: [{ ledgerAccountCode: '2420', debitPaise: 0, creditPaise: 40_000 }],
    });
    expect(r.body.data.balancingLine).toEqual({
      ledgerAccountCode: '3900',
      debitPaise: 40_000,
      creditPaise: 0,
    });
    expect(await balanceOf(w.society.id!, '3900')).toBe(40_000);
  });

  it('an already balanced set adds no 3900 line; autoBalance false with unbalanced lines is 422 JOURNAL_NOT_BALANCED', async () => {
    const w = await runSociety({ flats: 1 });
    const bal = await post(w, {
      asOfDate: today(),
      lines: [
        { ledgerAccountCode: '1120', debitPaise: 5_000, creditPaise: 0 },
        { ledgerAccountCode: '2420', debitPaise: 0, creditPaise: 5_000 },
      ],
    });
    expect(bal.body.data.balancingLine).toBeNull();
    const nb = await post(w, {
      asOfDate: today(),
      autoBalance: false,
      lines: [
        { ledgerAccountCode: '1120', debitPaise: 5_000, creditPaise: 0 },
        { ledgerAccountCode: '2420', debitPaise: 0, creditPaise: 4_000 },
      ],
    });
    expect(nb.status).toBe(422);
    expect(nb.body.code).toBe('JOURNAL_NOT_BALANCED');
    expect(nb.body.errors[0]).toMatchObject({ debitPaise: 5_000, creditPaise: 4_000 });
  });

  it('default narration names the date; a given narration is kept', async () => {
    const w = await runSociety({ flats: 1 });
    const a = await post(w, {
      asOfDate: today(),
      lines: [{ ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 }],
    });
    expect((await JournalEntry.findByPk(a.body.data.journalEntryId))!.narration).toBe(
      `Opening balances as of ${today()}`,
    );
    const b = await post(w, {
      asOfDate: today(),
      narration: 'Go-live cash',
      lines: [{ ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 }],
    });
    expect((await JournalEntry.findByPk(b.body.data.journalEntryId))!.narration).toBe('Go-live cash');
  });

  it('engine errors: UNKNOWN_LEDGER_CODE, ACCOUNT_NOT_POSTABLE, JOURNAL_LINE_INVALID', async () => {
    const w = await runSociety({ flats: 1 });
    const one = (line: Record<string, unknown>) => post(w, { asOfDate: today(), lines: [line] });
    expect((await one({ ledgerAccountCode: '9999', debitPaise: 100, creditPaise: 0 })).body.code).toBe(
      'UNKNOWN_LEDGER_CODE',
    );
    expect((await one({ ledgerAccountCode: '1110', debitPaise: 100, creditPaise: 0 })).body.code).toBe(
      'ACCOUNT_NOT_POSTABLE',
    );
    expect((await one({ ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 100 })).body.code).toBe(
      'JOURNAL_LINE_INVALID',
    );
    expect((await one({ ledgerAccountCode: '1120', debitPaise: 0, creditPaise: 0 })).body.code).toBe(
      'JOURNAL_LINE_INVALID',
    );
    expect(await JournalEntry.count({ where: { societyId: w.society.id! } })).toBe(0);
  });

  it('validation: date in the future or malformed, empty and oversize line lists, unknown keys', async () => {
    const w = await runSociety({ flats: 1 });
    const line = { ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 };
    const future = new Date(Date.parse(`${today()}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    expect((await post(w, { asOfDate: future, lines: [line] })).status).toBe(400);
    expect((await post(w, { asOfDate: '2026-02-30x', lines: [line] })).status).toBe(400);
    expect((await post(w, { asOfDate: today(), lines: [] })).status).toBe(400);
    expect(
      (await post(w, { asOfDate: today(), lines: Array.from({ length: 501 }, () => line) })).status,
    ).toBe(400);
    expect((await post(w, { asOfDate: today(), lines: [line], extra: true })).status).toBe(400);
    expect((await post(w, { lines: [line] })).status).toBe(400);
    expect(
      (await w.c('post', '/accounts/opening-balances', { asOfDate: today(), lines: [line] })).status,
    ).toBe(400); // no Idempotency-Key
  });

  it('409 PERIOD_LOCKED for a locked date and for a closed financial year', async () => {
    const w = await runSociety({ flats: 1 });
    const sid = w.society.id!;
    await sequelize.transaction(t => ensureBooks(t, sid));
    const line = { ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 };
    await SocietyBalance.update({ booksLockedThrough: '2026-09-30' } as never, { where: { societyId: sid } });
    const locked = await post(w, { asOfDate: '2026-09-15', lines: [line] });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('PERIOD_LOCKED');
    await SocietyBalance.update({ booksLockedThrough: null, lastClosedFinancialYear: '2025-26' } as never, {
      where: { societyId: sid },
    });
    const closed = await post(w, { asOfDate: '2026-03-31', lines: [line] });
    expect(closed.body.code).toBe('PERIOD_LOCKED');
    expect((await post(w, { asOfDate: '2026-04-01', lines: [line] })).status).toBe(201);
  });

  it('plan gating (BR-13-51): bank, cash and fund lines on Starter; any other account needs opening_balance_import', async () => {
    const s = await runSociety({ flats: 1, plan: 'STARTER' });
    const simple = await post(s, {
      asOfDate: today(),
      lines: [{ ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 }],
    });
    expect(simple.status, JSON.stringify(simple.body)).toBe(201);
    const other = await post(s, {
      asOfDate: today(),
      autoBalance: false,
      lines: [
        { ledgerAccountCode: '2110', debitPaise: 0, creditPaise: 100 },
        { ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 },
      ],
    });
    expect(other.status).toBe(402);
    expect(other.body.code).toBe('FEATURE_NOT_IN_PLAN');
  });

  it('Premium: other accounts post when they balance on their own; autoBalance true is refused with them', async () => {
    const w = await runSociety({ flats: 1 });
    const lines = [
      { ledgerAccountCode: '2110', debitPaise: 0, creditPaise: 7_000 },
      { ledgerAccountCode: '1430', debitPaise: 7_000, creditPaise: 0 },
    ];
    const withAuto = await post(w, { asOfDate: today(), autoBalance: true, lines });
    expect(withAuto.status).toBe(400);
    const r = await post(w, { asOfDate: today(), lines });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.balancingLine).toBeNull();
    expect(await balanceOf(w.society.id!, '2110')).toBe(-7_000);
    // not balanced on their own: no 3900 help
    const nb = await post(w, {
      asOfDate: today(),
      lines: [lines[0]!, { ledgerAccountCode: '1430', debitPaise: 6_000, creditPaise: 0 }],
    });
    expect(nb.body.code).toBe('JOURNAL_NOT_BALANCED');
  });

  it('needs finance.accounts.create: the Auditor gets 403; a society with no books yet is seeded on first use', async () => {
    const w = await runSociety({ flats: 1 });
    const auditor = await memberOf(w.society, 'auditor');
    const d = await post(auditor, {
      asOfDate: today(),
      lines: [{ ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 }],
    });
    expect(d.status).toBe(403);
    expect(d.body.code).toBe('PERMISSION_DENIED');
    expect(
      (
        await post(w, {
          asOfDate: today(),
          lines: [{ ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 }],
        })
      ).status,
    ).toBe(201);
  });

  it('an opening voucher cannot be reversed by the manual route (BR-13-5 is the engine rule): journals are untouched here', async () => {
    const w = await runSociety({ flats: 1 });
    const r = await post(w, {
      asOfDate: today(),
      lines: [{ ledgerAccountCode: '1120', debitPaise: 100, creditPaise: 0 }],
    });
    const e = (await JournalEntry.findByPk(r.body.data.journalEntryId))!;
    expect(e.source).toBe('SYSTEM');
  });
});

describe('demo seeder accounts-opening', () => {
  it('posts once per demo society and is idempotent', async () => {
    const a = await runSociety({ flats: 1 });
    await Society.update({ slug: 'sky-heights' } as never, { where: { id: a.society.id! } });
    const first = await seedAccountsOpening();
    expect(first.created).toEqual(['sky-heights opening balances']);
    expect(await balanceOf(a.society.id!, '1120')).toBe(2_500_000);
    expect(await balanceOf(a.society.id!, '2410')).toBe(-60_000_000);
    const second = await seedAccountsOpening();
    expect(second.created).toEqual([]);
    expect(
      await JournalEntry.count({ where: { societyId: a.society.id!, voucherType: 'OPENING_BALANCE' } }),
    ).toBe(1);
  });
});
