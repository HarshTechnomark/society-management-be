import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { LedgerAccount, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import {
  ReadTimeoutError,
  accountReports,
  cashBook,
  expenseReports,
  registerAccounts,
} from '../../../src/modules/accounts/accounts.public';
import { reverseEntry } from '../../../src/modules/accounts/accounts.engine';
import { readRows } from '../../../src/modules/accounts/accounts.reports.queries';
import { accountsSociety, balanceOf, post, resetAccounts } from '../../helpers/accounts';
import { expenseRow, ledgerId, reportBooks } from '../../helpers/accounts.reports';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeAll(() => registerAccounts());
beforeEach(async () => {
  await resetAccounts();
});

const opts = { deadlineMs: 20_000 };
const FY = { from: '2026-04-01', to: '2027-03-31' };
type Row = Record<string, any>;

async function world() {
  const w = await accountsSociety();
  const b = await reportBooks(w);
  return { w, ...b };
}

describe('trial balance (T13-51)', () => {
  it('debits equal credits and every row equals the ledger balance', async () => {
    const { w } = await world();
    const r = await accountReports.run(w.sid, 'trial-balance', { asOf: '2026-07-31' }, opts);
    expect(r.totals).toEqual({ debitPaise: 1_618_000, creditPaise: 1_618_000 });
    const byCode = Object.fromEntries((r.rows as Row[]).map(x => [x.code, x]));
    expect(byCode['1110-001']).toMatchObject({ debitPaise: 1_347_000, creditPaise: 0 });
    expect(byCode['4100']).toMatchObject({ debitPaise: 0, creditPaise: 300_000 });
    expect(byCode['2410']).toMatchObject({ creditPaise: 275_000 });
    expect(byCode['2140']).toBeUndefined(); // zero balance is hidden
    for (const x of r.rows as Row[]) {
      const bal = await balanceOf(w.sid, x.code);
      expect(x.debitPaise - x.creditPaise).toBe(bal);
    }
  });

  it('includeZero shows the zero accounts, an earlier date only counts earlier lines, a group level rolls up', async () => {
    const { w } = await world();
    const all = await accountReports.run(w.sid, 'trial-balance', { asOf: '2026-07-31', includeZero: true }, opts);
    expect((all.rows as Row[]).find(x => x.code === '2140')).toMatchObject({ debitPaise: 0, creditPaise: 0 });
    const early = await accountReports.run(w.sid, 'trial-balance', { asOf: '2026-05-31' }, opts);
    expect(early.totals).toEqual({ debitPaise: 1_220_000, creditPaise: 1_220_000 });
    const l1 = await accountReports.run(w.sid, 'trial-balance', { asOf: '2026-07-31', level: 1 }, opts);
    expect((l1.rows as Row[]).every(x => x.isGroup === true)).toBe(true);
    expect(l1.totals).toEqual({ debitPaise: 1_493_000 + 125_000, creditPaise: 1_618_000 });
  });

  it('financialYear stands for its last day; a fund filter only counts the lines of that fund', async () => {
    const { w, sinking } = await world();
    const fy = await accountReports.run(w.sid, 'trial-balance', { financialYear: '2026-27' }, opts);
    expect(fy.totals?.debitPaise).toBe(1_618_000);
    const f = await accountReports.run(w.sid, 'trial-balance', { asOf: '2026-07-31', fundId: sinking }, opts);
    // only the fund ledger line and the tagged expense line carry the fund
    expect((f.rows as Row[]).map(x => x.code).sort()).toEqual(['2410', '5330']);
  });

  it('never shows another society', async () => {
    const { w } = await world();
    const o = await accountsSociety('Other CHS');
    await post(o.sys, {
      date: '2026-07-01',
      voucherType: 'RECEIPT',
      refType: 'payment',
      refId: 1,
      narration: 'Other receipt',
      lines: [
        { ledgerAccountCode: '1140', debitPaise: 777, creditPaise: 0 },
        { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 777 },
      ],
    });
    const r = await accountReports.run(w.sid, 'trial-balance', { asOf: '2026-12-31' }, opts);
    expect(r.totals?.debitPaise).toBe(1_618_000);
    expect((r.rows as Row[]).find(x => x.code === '1140')).toBeUndefined();
  });
});

describe('income and expenditure', () => {
  it('income minus expenditure of the period, ignoring balance sheet accounts', async () => {
    const { w } = await world();
    const r = await accountReports.run(w.sid, 'income-expenditure', { from: '2026-04-01', to: '2026-07-31' }, opts);
    const rows = r.rows as Row[];
    expect(rows.filter(x => x.section === 'INCOME').map(x => [x.code, x.amountPaise])).toEqual([['4100', 300_000]]);
    expect(rows.filter(x => x.section === 'EXPENDITURE').map(x => [x.code, x.amountPaise])).toEqual([
      ['5330', 125_000],
    ]);
    expect(r.totals).toEqual({ debitPaise: 125_000, creditPaise: 300_000 });
  });

  it('matches the journal lines of the period (June only has the cash receipt of 50,000)', async () => {
    const { w } = await world();
    const r = await accountReports.run(w.sid, 'income-expenditure', { from: '2026-06-01', to: '2026-06-30' }, opts);
    expect(r.totals).toEqual({ debitPaise: 0, creditPaise: 50_000 });
    const [raw] = await sequelize.query<{ c: string }>(
      `SELECT SUM(l.creditPaise - l.debitPaise) c FROM journal_lines l JOIN ledger_accounts a ON a.id = l.ledgerAccountId
        WHERE l.societyId = ? AND a.accountType = 'INCOME' AND l.entryDate BETWEEN '2026-06-01' AND '2026-06-30'`,
      { replacements: [w.sid], type: QueryTypes.SELECT },
    );
    expect(Number(raw!.c)).toBe(50_000);
  });
});

describe('balance sheet', () => {
  it('assets equal liabilities, funds and surplus, including the surplus of the year', async () => {
    const { w } = await world();
    const r = await accountReports.run(w.sid, 'balance-sheet', { asOf: '2026-07-31' }, opts);
    expect(r.totals).toEqual({ debitPaise: 1_493_000, creditPaise: 1_493_000 });
    const rows = r.rows as Row[];
    const sum = (s: string) => rows.filter(x => x.section === s).reduce((t, x) => t + x.amountPaise, 0);
    expect(sum('ASSETS')).toBe(1_493_000);
    expect(sum('LIABILITIES')).toBe(18_000);
    expect(sum('FUNDS')).toBe(275_000);
    expect(rows.find(x => x.name.startsWith('Surplus (deficit) of the current'))!.amountPaise).toBe(175_000);
  });

  it('balances on every date of the year and in the year after (earlier surplus carried)', async () => {
    const { w } = await world();
    for (const asOf of ['2026-04-01', '2026-05-25', '2026-06-30', '2026-12-31', '2027-04-30']) {
      const r = await accountReports.run(w.sid, 'balance-sheet', { asOf }, opts);
      expect(r.totals?.debitPaise, asOf).toBe(r.totals?.creditPaise);
    }
    const next = await accountReports.run(w.sid, 'balance-sheet', { asOf: '2027-04-30' }, opts);
    expect((next.rows as Row[]).find(x => x.name.startsWith('Surplus (deficit) of earlier'))!.amountPaise).toBe(175_000);
  });
});

describe('general ledger', () => {
  it('lists lines with a running balance in the natural side of the account', async () => {
    const { w, bank } = await world();
    const r = await accountReports.run(
      w.sid,
      'general-ledger',
      { ledgerAccountId: Number(bank.id), from: '2026-04-01', to: '2026-07-31' },
      opts,
    );
    const rows = r.rows as Row[];
    expect(rows.map(x => x.runningPaise)).toEqual([
      1_000_000, 1_200_000, 1_102_000, 1_082_000, 1_382_000, 1_372_000, 1_347_000,
    ]);
    expect(r.total).toBe(7);
    expect(r.totals).toEqual({ debitPaise: 1_500_000, creditPaise: 153_000 });
  });

  it('opening balance for a later window, credit-normal accounts, pages and groups', async () => {
    const { w, bank } = await world();
    const later = await accountReports.run(
      w.sid,
      'general-ledger',
      { ledgerAccountId: Number(bank.id), from: '2026-06-01', to: '2026-07-31' },
      opts,
    );
    expect((later.rows as Row[])[0]!.runningPaise).toBe(1_102_000 - 20_000);
    const income = await accountReports.run(
      w.sid,
      'general-ledger',
      { ledgerAccountId: await ledgerId(w.sid, '4100'), from: '2026-04-01', to: '2026-12-31' },
      opts,
    );
    expect((income.rows as Row[]).at(-1)!.runningPaise).toBe(300_000);
    const paged = await accountReports.run(
      w.sid,
      'general-ledger',
      { ledgerAccountId: Number(bank.id), from: '2026-04-01', to: '2026-07-31', page: 2, limit: 3 },
      opts,
    );
    expect((paged.rows as Row[]).map(x => x.runningPaise)).toEqual([1_082_000, 1_382_000, 1_372_000]);
    expect(paged.total).toBe(7);
    // the group 1110 stands for its leaves
    const group = await accountReports.run(
      w.sid,
      'general-ledger',
      { ledgerAccountId: await ledgerId(w.sid, '1110'), from: '2026-04-01', to: '2026-07-31' },
      opts,
    );
    expect(group.total).toBe(7);
  });

  it('needs an account of this society', async () => {
    const { w } = await world();
    const o = await accountsSociety('Other CHS');
    await expect(
      accountReports.run(w.sid, 'general-ledger', { from: '2026-04-01', to: '2026-07-31' }, opts),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      accountReports.run(
        w.sid,
        'general-ledger',
        { ledgerAccountId: await ledgerId(o.sid, '4100'), from: '2026-04-01', to: '2026-07-31' },
        opts,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'LEDGER_ACCOUNT_NOT_FOUND' });
  });
});

describe('period rules', () => {
  it('a range is at most 366 days and not backwards', async () => {
    const { w } = await world();
    await expect(
      accountReports.run(w.sid, 'income-expenditure', { from: '2026-01-01', to: '2027-03-31' }, opts),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      accountReports.run(w.sid, 'income-expenditure', { from: '2026-05-01', to: '2026-04-30' }, opts),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const fy = await accountReports.run(w.sid, 'income-expenditure', { financialYear: '2026-27' }, opts);
    expect(fy.totals).toEqual({ debitPaise: 125_000, creditPaise: 300_000 });
  });
});

describe('receipts and payments', () => {
  it('groups cash and bank movements by counter account, leaves out contra and closes to the cash ledgers', async () => {
    const { w } = await world();
    const r = await accountReports.run(w.sid, 'receipts-payments', { from: '2026-04-01', to: '2026-07-31' }, opts);
    const rows = r.rows as Row[];
    const side = (s: string) => rows.filter(x => x.side === s).map(x => [x.code, x.amountPaise]);
    expect(side('RECEIPT')).toEqual([
      ['2410', 300_000],
      ['3900', 1_000_000],
      ['4100', 250_000],
    ]);
    expect(side('PAYMENT')).toEqual([
      ['1410', 18_000],
      ['4100', 50_000],
      ['5330', 125_000],
    ]);
    // both sides of the statement are equal: opening + receipts = payments + closing
    expect(r.totals?.debitPaise).toBe(r.totals?.creditPaise);
    const cash = (await balanceOf(w.sid, '1110-001')) + (await balanceOf(w.sid, '1120'));
    expect(r.totals?.creditPaise).toBe(193_000 + cash);
  });

  it('a later window starts from the cash and bank balance at its start', async () => {
    const { w } = await world();
    const r = await accountReports.run(w.sid, 'receipts-payments', { from: '2026-07-01', to: '2026-07-31' }, opts);
    // before 1 July: bank 1,372,000 (+10,000 contra) and cash 60,000 - 10,000... both ledgers together
    expect(r.totals?.debitPaise).toBe(r.totals?.creditPaise);
  });
});

describe('GST summary and TDS register', () => {
  it('output and input per month', async () => {
    const { w } = await world();
    const r = await accountReports.run(w.sid, 'gst-summary' as never, { from: '2026-04-01', to: '2026-07-31' }, opts);
    expect(r.rows).toEqual([
      expect.objectContaining({ month: '2026-05', inputCreditPaise: 18_000, outputTotalPaise: 0, netPayablePaise: -18_000 }),
      expect.objectContaining({
        month: '2026-07',
        outputCgstPaise: 9_000,
        outputSgstPaise: 9_000,
        outputIgstPaise: 0,
        outputTotalPaise: 18_000,
        inputCreditPaise: 0,
        netPayablePaise: 18_000,
      }),
    ]);
    expect(r.totals).toEqual({ debitPaise: 18_000, creditPaise: 18_000 });
  });

  it('lines on 2140 with payee, section, voucher and challan; a reversed expense is left out', async () => {
    const { w, bank } = await world();
    const j = await post(w.user, {
      date: '2026-07-20',
      voucherType: 'PAYMENT',
      refType: 'expense',
      refId: 'R',
      narration: 'Reversed expense',
      lines: [
        { ledgerAccountCode: '5330', debitPaise: 55_000, creditPaise: 0 },
        { ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: 50_000 },
        { ledgerAccountCode: '2140', debitPaise: 0, creditPaise: 5_000 },
      ],
    });
    await expenseRow(w.sid, w.userId, {
      journalEntryId: j.id,
      status: 'REVERSED',
      date: '2026-07-20',
      gross: 55_000,
      tds: 5_000,
      section: '194C',
      bankLedgerId: Number(bank.id),
    });
    await sequelize.transaction(t => reverseEntry(w.user, j.id, { date: '2026-07-21', reason: 'Wrong amount' }, t));
    const r = await accountReports.run(w.sid, 'tds-register' as never, { from: '2026-04-01', to: '2026-07-31' }, opts);
    expect(r.rows).toEqual([
      expect.objectContaining({
        date: '2026-05-20',
        payee: 'Lift Co',
        tdsSection: '194C',
        grossAmountPaise: 118_000,
        deductedPaise: 20_000,
        depositedPaise: 0,
      }),
      expect.objectContaining({
        date: '2026-06-05',
        payee: 'Income Tax Department',
        deductedPaise: 0,
        depositedPaise: 20_000,
        challanNo: 'CHALLAN123',
      }),
    ]);
    expect((r.rows as Row[])[0]!.voucherNo).toMatch(/^VCH\//);
    expect(r.totals).toEqual({ debitPaise: 20_000, creditPaise: 20_000 });
  });
});

describe('fund statement and cash book', () => {
  it('lines on the fund ledger with the running balance and opening and closing', async () => {
    const { w, sinking } = await world();
    const r = await accountReports.fundStatement(w.sid, sinking, '2026-04-01', '2026-12-31', opts);
    expect(r.rows.map(x => [x.date, x.inPaise, x.outPaise, x.runningPaise])).toEqual([
      ['2026-06-10', 300_000, 0, 300_000],
      ['2026-07-10', 0, 25_000, 275_000],
    ]);
    expect(r.totals).toEqual({ openingPaise: 0, closingPaise: 275_000 });
    expect(r.totals.closingPaise).toBe(-(await balanceOf(w.sid, '2410')));
    const later = await accountReports.fundStatement(w.sid, sinking, '2026-07-01', '2026-12-31', opts);
    expect(later.totals).toEqual({ openingPaise: 300_000, closingPaise: 275_000 });
    expect(later.rows[0]!.runningPaise).toBe(275_000);
  });

  it('an unknown fund or one of another society is FUND_NOT_FOUND', async () => {
    const { w, sinking } = await world();
    const o = await accountsSociety('Other CHS');
    await expect(accountReports.fundStatement(o.sid, sinking, '2026-04-01', '2026-12-31', opts)).rejects.toMatchObject({
      status: 404,
      code: 'FUND_NOT_FOUND',
    });
    await expect(accountReports.fundStatement(w.sid, 999999, '2026-04-01', '2026-12-31', opts)).rejects.toMatchObject({
      code: 'FUND_NOT_FOUND',
    });
  });

  it('monthly totals leave contra moves out and carry the closing balance', async () => {
    const { w } = await world();
    const r = await cashBook.monthlyTotals(w.sid, '2026-04-01', '2026-08-31', opts);
    expect(r.rows).toEqual([
      { month: '2026-04', inPaise: 1_000_000, outPaise: 0, closingPaise: 1_000_000 },
      { month: '2026-05', inPaise: 200_000, outPaise: 98_000, closingPaise: 1_102_000 },
      { month: '2026-06', inPaise: 350_000, outPaise: 20_000, closingPaise: 1_432_000 },
      { month: '2026-07', inPaise: 0, outPaise: 75_000, closingPaise: 1_357_000 },
      { month: '2026-08', inPaise: 0, outPaise: 0, closingPaise: 1_357_000 },
    ]);
    const cash = (await balanceOf(w.sid, '1110-001')) + (await balanceOf(w.sid, '1120'));
    expect(r.rows.at(-1)!.closingPaise).toBe(cash);
    await expect(cashBook.monthlyTotals(w.sid, '2023-01-01', '2026-08-31', opts)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('expense readers (T13-51, T13-54)', () => {
  it('byHead groups POSTED expenses and leaves a reversed one out', async () => {
    const { w, bank, sinking } = await world();
    await expenseRow(w.sid, w.userId, {
      status: 'REVERSED',
      date: '2026-07-12',
      gross: 99_000,
      bankLedgerId: Number(bank.id),
    });
    await LedgerAccount.update({ transparencyCategory: 'Repairs' } as never, {
      where: { societyId: w.sid, code: '5330' },
    });
    const r = await expenseReports.byHead(w.sid, { ...FY }, opts);
    expect(r.rows).toEqual([
      expect.objectContaining({ code: '5330', head: expect.any(String), transparencyCategory: 'Repairs', count: 2, amountPaise: 143_000 }),
      expect.objectContaining({ code: '2140', count: 1, amountPaise: 20_000, transparencyCategory: null }),
    ]);
    expect(r.totals).toEqual({ count: 3, amountPaise: 163_000 });
    const f = await expenseReports.byHead(w.sid, { ...FY, fundId: sinking }, opts);
    expect(f.rows.map(x => [x.code, x.amountPaise])).toEqual([['5330', 25_000]]);
    const sorted = await expenseReports.byHead(w.sid, { ...FY, sortBy: 'head', sortDir: 'asc', limit: 1, page: 2 }, opts);
    expect(sorted.rows).toHaveLength(1);
    expect(sorted.total).toBe(2);
    const o = await accountsSociety('Other CHS');
    expect((await expenseReports.byHead(o.sid, { ...FY }, opts)).rows).toEqual([]);
  });

  it('tdsDeposited: one row per section, deposits from STATUTORY_DUE to 2140, reversed expenses out', async () => {
    const { w, bank } = await world();
    const j = await post(w.user, {
      date: '2026-07-22',
      voucherType: 'PAYMENT',
      refType: 'expense',
      refId: 'J',
      narration: 'Professional fee',
      lines: [
        { ledgerAccountCode: '5330', debitPaise: 500_000, creditPaise: 0 },
        { ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: 450_000 },
        { ledgerAccountCode: '2140', debitPaise: 0, creditPaise: 50_000 },
      ],
    });
    await expenseRow(w.sid, w.userId, {
      journalEntryId: j.id,
      date: '2026-07-22',
      gross: 500_000,
      tds: 50_000,
      section: '194J',
      bankLedgerId: Number(bank.id),
    });
    await expenseRow(w.sid, w.userId, {
      status: 'REVERSED',
      date: '2026-07-23',
      gross: 60_000,
      tds: 6_000,
      section: '194C',
      bankLedgerId: Number(bank.id),
    });
    const r = await expenseReports.tdsDeposited(w.sid, { ...FY }, opts);
    expect(r.rows).toEqual([
      { tdsSection: '194C', deductedPaise: 20_000, depositedPaise: 20_000, challanNo: 'CHALLAN123' },
      { tdsSection: '194J', deductedPaise: 50_000, depositedPaise: 0, challanNo: null },
    ]);
    expect(r.totals).toEqual({ deductedPaise: 70_000, depositedPaise: 20_000 });
    const none = await expenseReports.tdsDeposited(w.sid, { ...FY, vendorId: 4242 }, opts);
    expect(none).toEqual({ rows: [], total: 0, totals: { deductedPaise: 0, depositedPaise: 0 } });
    const desc = await expenseReports.tdsDeposited(w.sid, { ...FY, sortBy: 'deductedPaise', sortDir: 'desc' }, opts);
    expect(desc.rows.map(x => x.tdsSection)).toEqual(['194J', '194C']);
  });
});

describe('read deadline', () => {
  it('a read that cannot finish in deadlineMs throws ReadTimeoutError', async () => {
    const heavy =
      'SELECT COUNT(*) AS n FROM information_schema.columns a, information_schema.columns b, information_schema.columns c';
    const err = await readRows(heavy, {}, { deadlineMs: 20 }).catch(e => e);
    expect(err).toBeInstanceOf(ReadTimeoutError);
    expect(err.deadlineMs).toBe(20);
  });
});
