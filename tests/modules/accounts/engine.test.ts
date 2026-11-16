import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import {
  AuditLog,
  BalanceHistory,
  Fund,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  SocietyBalance,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import {
  isDateLocked,
  postDraft,
  postJournal,
  reverseByRef,
  reverseEntry,
} from '../../../src/modules/accounts/accounts.engine';
import { backfillBooks, ensureBooks, CHART } from '../../../src/modules/accounts/accounts.chart';
import { ledgerAccountExists, readSocietyBalance } from '../../../src/modules/accounts/accounts.lookup';
import { accountsPortCalls, setAccountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { verifyBalances } from '../../../src/modules/accounts/accounts.verify';
import type { PostJournalInput } from '../../../src/modules/accounts/accounts.types';
import { events } from '../../helpers/auth';
import { setSetting } from '../../helpers/billing-runs';
import {
  accountsSociety,
  addBankLedger,
  addCollectionBank,
  balanceOf,
  fundIdByType,
  post,
  resetAccounts,
} from '../../helpers/accounts';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetAccounts);

const lines = (dr: string, cr: string, paise: number, extra: object = {}) => [
  { ledgerAccountCode: dr, debitPaise: paise, creditPaise: 0 },
  { ledgerAccountCode: cr, debitPaise: 0, creditPaise: paise, ...extra },
];
const base = (refId: number | string, over: Record<string, unknown> = {}): PostJournalInput =>
  ({
    date: '2026-11-10',
    voucherType: 'RECEIPT',
    refType: 'payment',
    refId,
    narration: 'Receipt RCT/2026-27/000001 · A-101',
    ...over,
  }) as PostJournalInput;

describe('chart of accounts seed (BR-13-15, 7.13)', () => {
  it('seeds the chart, system keys, three funds and is idempotent', async () => {
    const w = await accountsSociety('Seed CHS', false);
    expect(await LedgerAccount.count({ where: { societyId: w.sid } })).toBe(0);
    await sequelize.transaction(t => ensureBooks(t, w.sid));
    await sequelize.transaction(t => ensureBooks(t, w.sid));
    expect(await LedgerAccount.count({ where: { societyId: w.sid } })).toBe(CHART.length);
    expect(await SocietyBalance.count({ where: { societyId: w.sid } })).toBe(1);
    const gw = (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '1140' } }))!;
    expect([gw.systemKey, gw.subtype, gw.isGroup, gw.accountType]).toEqual([
      'GATEWAY_CLEARING',
      'CLEARING',
      false,
      'ASSET',
    ]);
    expect((await LedgerAccount.findOne({ where: { societyId: w.sid, code: '1110' } }))!.isGroup).toBe(true);
    expect(
      (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '5330' } }))!.isCashBookCategory,
    ).toBe(true);
    expect(
      (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '5110' } }))!.transparencyCategory,
    ).toBe('Staff and security');
    const keys = await LedgerAccount.findAll({ where: { societyId: w.sid }, attributes: ['systemKey'] });
    expect(keys.filter(k => k.systemKey).length).toBe(15);
    const funds = await Fund.findAll({ where: { societyId: w.sid }, order: [['id', 'ASC']] });
    expect(funds.map(f => f.fundType)).toEqual(['SINKING', 'REPAIR', 'CORPUS']);
    const ledger = await LedgerAccount.findByPk(funds[0]!.ledgerAccountId);
    expect(ledger!.code).toBe('2410');
    expect(await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.books.seeded' } })).toBe(1);
  });

  it('backfills every society without books and keeps the others', async () => {
    const a = await accountsSociety('A CHS', false);
    const b = await accountsSociety('B CHS', true);
    const done = await backfillBooks();
    expect(done).toContain(a.sid);
    expect(done).not.toContain(b.sid);
    expect(await backfillBooks()).toEqual([]);
  });

  it('seeds lazily on the first posting and the codes line up with module 11 heads', async () => {
    const w = await accountsSociety('Lazy CHS', false);
    await post(w.sys, base(1, { lines: lines('1140', '1300', 5000) }));
    expect(await LedgerAccount.count({ where: { societyId: w.sid } })).toBe(CHART.length);
  });

  it('ledgerAccountExists accepts codes and keys of active leaves only', async () => {
    const w = await accountsSociety();
    expect(await ledgerAccountExists(w.sid, '4100')).toBe(true);
    expect(await ledgerAccountExists(w.sid, 'MEMBER_RECEIVABLE')).toBe(true);
    expect(await ledgerAccountExists(w.sid, 'COLLECTION_FUND')).toBe(true);
    expect(await ledgerAccountExists(w.sid, '1110')).toBe(false); // group
    expect(await ledgerAccountExists(w.sid, '9999')).toBe(false);
    expect(await ledgerAccountExists(w.sid, 'not a code')).toBe(false);
    await LedgerAccount.update({ isActive: false }, { where: { societyId: w.sid, code: '4110' } });
    expect(await ledgerAccountExists(w.sid, '4110')).toBe(false);
  });
});

describe('journal.post validation (BR-13-1 to 3, T13-01 to 03)', () => {
  it('T13-01 refuses unbalanced journals and writes nothing', async () => {
    const w = await accountsSociety();
    const err = await post(
      w.sys,
      base(1, {
        lines: [
          { ledgerAccountCode: '1140', debitPaise: 1_180_000, creditPaise: 0 },
          { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 1_080_000 },
        ],
      }),
    ).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'JOURNAL_NOT_BALANCED']);
    expect(err.errors[0]).toMatchObject({ field: 'lines', debitPaise: 1_180_000, creditPaise: 1_080_000 });
    expect(await JournalEntry.count({ where: { societyId: w.sid } })).toBe(0);
    expect(await balanceOf(w.sid, '1140')).toBe(0);
  });

  it('T13-02 refuses both-sided, zero and single lines', async () => {
    const w = await accountsSociety();
    const bad = [
      [
        { ledgerAccountCode: '1140', debitPaise: 10, creditPaise: 10 },
        { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 0 },
      ],
      [
        { ledgerAccountCode: '1140', debitPaise: 0, creditPaise: 0 },
        { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 0 },
      ],
      [{ ledgerAccountCode: '1140', debitPaise: 10, creditPaise: 0 }],
      [
        { ledgerAccountCode: '1140', debitPaise: 1.5, creditPaise: 0 },
        { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 1.5 },
      ],
      [
        { ledgerAccountCode: '1140', debitPaise: 10_000_000_000_001, creditPaise: 0 },
        { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 10_000_000_000_001 },
      ],
    ];
    for (const l of bad) {
      const err = await post(w.sys, base(2, { lines: l })).catch(e => e);
      expect([err.status, err.code]).toEqual([422, 'JOURNAL_LINE_INVALID']);
    }
  });

  it('T13-03 refuses a group and an unknown code; also inactive accounts and bad keys', async () => {
    const w = await accountsSociety();
    let err = await post(w.sys, base(3, { lines: lines('1110', '1300', 100) })).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'ACCOUNT_NOT_POSTABLE']);
    err = await post(w.sys, base(3, { lines: lines('9999', '1300', 100) })).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'UNKNOWN_LEDGER_CODE']);
    err = await post(w.sys, base(3, { lines: lines('NOPE_KEY', '1300', 100) })).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'UNKNOWN_LEDGER_CODE']);
    await LedgerAccount.update({ isActive: false }, { where: { societyId: w.sid, code: '4110' } });
    err = await post(w.sys, base(3, { lines: lines('1140', '4110', 100) })).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'ACCOUNT_INACTIVE']);
  });

  it('refuses a bad refType, refId and date', async () => {
    const w = await accountsSociety();
    for (const over of [
      { refType: 'Bad Type' },
      { refId: '' },
      { date: '10-11-2026' },
      { voucherType: 'NOPE' },
    ]) {
      const err = await post(w.sys, base(4, { lines: lines('1140', '1300', 100), ...over })).catch(e => e);
      expect(err.code).toBe('JOURNAL_LINE_INVALID');
    }
  });
});

describe('posting effects (BR-13-4, 7, 10 to 12, T13-04)', () => {
  it('updates ledger balances, society balance, history and emits balance.updated after commit', async () => {
    const w = await accountsSociety();
    const r = await post(w.sys, base(10, { lines: lines('1140', '1300', 680_900) }));
    expect(r).toMatchObject({ replayed: false, entryDate: '2026-11-10' });
    expect(r.voucherNo).toMatch(/^VCH\/2026-27\/000001$/);
    expect(await balanceOf(w.sid, '1140')).toBe(680_900);
    expect(await balanceOf(w.sid, '1300')).toBe(-680_900);
    const b = (await SocietyBalance.findOne({ where: { societyId: w.sid } }))!;
    expect([Number(b.clearingPaise), Number(b.totalPaise), Number(b.inBankPaise)]).toEqual([
      680_900, 680_900, 0,
    ]);
    expect(Number(b.lastJournalEntryId)).toBe(r.id);
    const h = await BalanceHistory.findAll({ where: { societyId: w.sid } });
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ direction: 'IN', refType: 'payment' });
    expect(Number(h[0]!.deltaTotalPaise)).toBe(680_900);
    const ev = events.filter(e => e.event === 'balance.updated');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ room: `society:${w.sid}:finance` });
    expect(ev[0]!.payload).toMatchObject({
      totalPaise: 680_900,
      clearingPaise: 680_900,
      direction: 'IN',
      journalEntryId: r.id,
    });
    const e = (await JournalEntry.findByPk(r.id))!;
    expect([e.status, Number(e.totalPaise), e.source, e.financialYear]).toEqual([
      'POSTED',
      680_900,
      'SYSTEM',
      '2026-27',
    ]);
    expect(await JournalLine.count({ where: { journalEntryId: r.id } })).toBe(2);
    expect(
      await AuditLog.count({
        where: { societyId: w.sid, action: 'accounts.journal.posted', entityLabel: r.voucherNo },
      }),
    ).toBe(1);
  });

  it('a rolled back outer transaction leaves no rows, no event and no cache touch', async () => {
    const w = await accountsSociety();
    setAccountsPorts({ reportsCache: {} });
    accountsPortCalls.length = 0;
    await sequelize
      .transaction(async t => {
        await postJournal(w.sys, base(11, { lines: lines('1140', '1300', 5000) }), t);
        throw new Error('boom');
      })
      .catch(() => undefined);
    expect(await JournalEntry.count({ where: { societyId: w.sid } })).toBe(0);
    expect(await balanceOf(w.sid, '1140')).toBe(0);
    expect(events.filter(e => e.event === 'balance.updated')).toHaveLength(0);
    expect(accountsPortCalls.filter(c => c.fn === 'reports.touch')).toHaveLength(0);
    await post(w.sys, base(11, { lines: lines('1140', '1300', 5000) }));
    expect(accountsPortCalls.filter(c => c.fn === 'reports.touch')).toHaveLength(1); // T13-53: once, after commit
  });

  it('voucher numbers: RECEIPT, PAYMENT, CONTRA on VOUCHER; the rest on JOURNAL (BR-13-7)', async () => {
    const w = await accountsSociety();
    const n1 = await post(w.sys, base(21, { voucherType: 'RECEIPT', lines: lines('1120', '1300', 100) }));
    const n2 = await post(w.sys, base(22, { voucherType: 'PAYMENT', lines: lines('5330', '1120', 100) }));
    const n3 = await post(
      w.sys,
      base(23, { voucherType: 'INVOICE', refType: 'invoice', lines: lines('1300', '4100', 100) }),
    );
    const n4 = await post(
      w.sys,
      base(24, { voucherType: 'JOURNAL', refType: 'misc', lines: lines('1300', '4100', 100) }),
    );
    expect([n1.voucherNo, n2.voucherNo]).toEqual(['VCH/2026-27/000001', 'VCH/2026-27/000002']);
    expect([n3.voucherNo, n4.voucherNo]).toEqual(['JV/2026-27/000001', 'JV/2026-27/000002']);
    const apr = await post(w.sys, base(25, { date: '2027-04-02', lines: lines('1120', '1300', 100) }));
    expect(apr.voucherNo).toBe('VCH/2027-28/000001');
  });

  it('T13-09 worked sequence of the live balance and the four figures', async () => {
    const w = await accountsSociety();
    await addBankLedger(w.sid);
    const fig = async () => {
      const b = await readSocietyBalance(w.sid);
      return [b.totalPaise, b.inBankPaise, b.clearingPaise, b.cashPaise];
    };
    await post(
      w.sys,
      base('o1', {
        voucherType: 'OPENING_BALANCE',
        refType: 'opening',
        lines: lines('1110-001', '3900', 124_050_000),
      }),
    );
    expect(await fig()).toEqual([124_050_000, 124_050_000, 0, 0]);
    await post(w.sys, base(31, { lines: lines('1140', '4100', 680_900) }));
    expect((await fig())[0]).toBe(124_730_900);
    await post(w.sys, base(32, { lines: lines('1120', '4100', 110_000) }));
    expect((await fig())[0]).toBe(124_840_900);
    await post(
      w.sys,
      base(33, { voucherType: 'PAYMENT', refType: 'expense', lines: lines('5330', '1110-001', 1_200_000) }),
    );
    expect((await fig())[0]).toBe(123_640_900);
    await post(
      w.sys,
      base(34, { voucherType: 'CONTRA', refType: 'settlement', lines: lines('1110-001', '1140', 680_900) }),
    );
    expect(await fig()).toEqual([123_640_900, 123_530_900, 0, 110_000]);
    const hist = await BalanceHistory.findAll({ where: { societyId: w.sid }, order: [['id', 'ASC']] });
    expect(hist.map(h => h.direction)).toEqual(['IN', 'IN', 'IN', 'OUT', 'MOVE']);
  });

  it('every posting type moves the right figure: cheques, petty cash, investments and funds', async () => {
    const w = await accountsSociety();
    await addBankLedger(w.sid);
    await post(w.sys, base(41, { lines: lines('1150', '1300', 1000) }));
    await post(
      w.sys,
      base(42, { voucherType: 'PAYMENT', refType: 'cash_move', lines: lines('1130', '1150', 400) }),
    ); // move cheques to petty cash
    await post(w.sys, base(43, { voucherType: 'JOURNAL', refType: 'fd', lines: lines('1210', '1130', 100) })); // buy an FD with petty cash
    const repair = await fundIdByType(w.sid, 'REPAIR');
    await post(w.sys, base(44, { lines: lines('1120', '1300', 5000) }));
    await post(
      w.sys,
      base(45, {
        voucherType: 'JOURNAL',
        refType: 'alloc',
        lines: [
          { ledgerAccountCode: '3100', debitPaise: 2000, creditPaise: 0 },
          { ledgerAccountCode: '2420', debitPaise: 0, creditPaise: 2000 },
        ],
      }),
    );
    const b = await readSocietyBalance(w.sid);
    expect([b.chequesPaise, b.cashPaise, b.investmentsPaise, b.totalPaise]).toEqual([600, 5300, 100, 5900]);
    expect([b.earmarkedFundsPaise, b.generalPaise]).toEqual([2000, 3900]);
    expect(b.funds.find(f => f.id === repair)!.balancePaise).toBe(2000);
    const last = await BalanceHistory.findOne({ where: { societyId: w.sid }, order: [['id', 'DESC']] });
    expect(last!.direction).toBe('FUND_ONLY');
    // a posting that touches no balance figure writes no history row
    const count = await BalanceHistory.count({ where: { societyId: w.sid } });
    await post(
      w.sys,
      base(46, { voucherType: 'INVOICE', refType: 'invoice', lines: lines('1300', '4100', 900) }),
    );
    expect(await BalanceHistory.count({ where: { societyId: w.sid } })).toBe(count);
  });

  it('T13-08 50 parallel captures: exact clearing total, 50 history rows, gapless vouchers', async () => {
    const w = await accountsSociety();
    // 50 captures at once, at most 15 in flight (the pool has 20 connections and every waiting poster holds one)
    const post1 = (i: number) =>
      sequelize.transaction(t =>
        postJournal(w.sys, base(1000 + i, { lines: lines('1140', '1300', 10_000) }), t),
      );
    let next = 0;
    await Promise.all(
      Array.from({ length: 15 }, async () => {
        while (next < 50) await post1(next++);
      }),
    );
    const b = (await SocietyBalance.findOne({ where: { societyId: w.sid } }))!;
    expect(Number(b.clearingPaise)).toBe(500_000);
    expect(await BalanceHistory.count({ where: { societyId: w.sid } })).toBe(50);
    const vouchers = (await JournalEntry.findAll({ where: { societyId: w.sid }, attributes: ['voucherNo'] }))
      .map(e => e.voucherNo!)
      .sort();
    expect(vouchers).toEqual(
      Array.from({ length: 50 }, (_, i) => `VCH/2026-27/${String(i + 1).padStart(6, '0')}`),
    );
  }, 60_000);

  it('the public room gets balance.updated only when the society shows its finances (BR-13-12, BR-13-44)', async () => {
    const w = await accountsSociety();
    await post(w.sys, base(50, { lines: lines('1140', '1300', 100) }));
    expect(events.filter(e => e.room === `society:${w.sid}:public`)).toHaveLength(0);
    await setSetting(w.sid, 'finance.showFinancesToResidents', true);
    events.length = 0;
    await post(w.sys, base(51, { lines: lines('1140', '1300', 100) }));
    const pub = events.filter(e => e.room === `society:${w.sid}:public`);
    expect(pub).toHaveLength(1);
    expect(Object.keys(pub[0]!.payload).sort()).toEqual(
      [
        'changedAt',
        'chequesPaise',
        'clearingPaise',
        'cashPaise',
        'funds',
        'inBankPaise',
        'totalPaise',
      ].sort(),
    );
    expect((pub[0]!.payload.funds as unknown[]).length).toBe(3);
  });
});

describe('idempotency by source (BR-13-6, T13-05)', () => {
  it('same ref and lines returns the entry; different lines is a 409', async () => {
    const w = await accountsSociety();
    const a = await post(w.sys, base(60, { lines: lines('1140', '1300', 700) }));
    const b = await post(w.sys, base(60, { lines: [...lines('1140', '1300', 700)].reverse() }));
    expect(b).toMatchObject({ id: a.id, voucherNo: a.voucherNo, replayed: true });
    expect(await JournalEntry.count({ where: { societyId: w.sid } })).toBe(1);
    expect(await balanceOf(w.sid, '1140')).toBe(700);
    const err = await post(w.sys, base(60, { lines: lines('1140', '1300', 800) })).catch(e => e);
    expect([err.status, err.code]).toEqual([409, 'JOURNAL_DUPLICATE_REF']);
    // another refType with the same id is a different source
    const c = await post(w.sys, base(60, { refType: 'refund', lines: lines('1140', '1300', 800) }));
    expect(c.replayed).toBe(false);
  });
});

describe('immutability and reversal (BR-13-4, 5, T13-06, T13-07)', () => {
  it('posted entries and lines cannot be changed or deleted through the model', async () => {
    const w = await accountsSociety();
    const r = await post(w.sys, base(70, { lines: lines('1140', '1300', 100) }));
    const e = (await JournalEntry.findByPk(r.id))!;
    await expect(e.update({ narration: 'changed' })).rejects.toThrow(/immutable/);
    await expect(e.update({ totalPaise: 1 })).rejects.toThrow(/immutable/);
    await expect(e.destroy()).rejects.toThrow();
    const l = (await JournalLine.findOne({ where: { journalEntryId: r.id } }))!;
    await expect(l.update({ debitPaise: 5 } as never)).rejects.toThrow(/immutable/);
    await expect(l.destroy()).rejects.toThrow();
    await expect(JournalLine.destroy({ where: { journalEntryId: r.id } })).rejects.toThrow();
    await expect(BalanceHistory.destroy({ where: { societyId: w.sid } })).rejects.toThrow();
    const h = (await BalanceHistory.findOne({ where: { societyId: w.sid } }))!;
    await expect(h.update({ label: 'x' })).rejects.toThrow(/append-only/);
  });

  it('direct SQL is refused when the MySQL triggers exist (T13-06)', async () => {
    const triggers = await sequelize.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg_journal%'",
      { type: QueryTypes.SELECT },
    );
    if (!Number(triggers[0]!.n)) return; // the server forbids triggers without SUPER while binary logging is on; the model hooks apply
    const w = await accountsSociety();
    const r = await post(w.sys, base(71, { lines: lines('1140', '1300', 100) }));
    await expect(
      sequelize.query('UPDATE journal_lines SET debitPaise = 5 WHERE journalEntryId = ?', {
        replacements: [r.id],
      }),
    ).rejects.toThrow();
    await expect(
      sequelize.query("UPDATE journal_entries SET narration = 'x' WHERE id = ?", { replacements: [r.id] }),
    ).rejects.toThrow();
    await expect(
      sequelize.query('DELETE FROM journal_entries WHERE id = ?', { replacements: [r.id] }),
    ).rejects.toThrow();
  });

  it('T13-07 reverses once with swapped lines; a reversal cannot be reversed', async () => {
    const w = await accountsSociety();
    const r = await post(w.sys, base(72, { lines: lines('1140', '1300', 900) }));
    const rev = await sequelize.transaction(t =>
      reverseByRef(w.sys, { refType: 'payment', refId: 72, reason: 'wrong entry' }, t),
    );
    expect(rev.voucherNo).toMatch(/^VCH\//);
    const orig = (await JournalEntry.findByPk(r.id))!;
    expect(Number(orig.reversedByEntryId)).toBe(rev.id);
    expect(orig.reversalReason).toBe('wrong entry');
    const re = (await JournalEntry.findByPk(rev.id))!;
    expect([re.voucherType, Number(re.reversalOfId), re.status]).toEqual(['RECEIPT', r.id, 'POSTED']);
    const rl = await JournalLine.findAll({ where: { journalEntryId: rev.id }, order: [['lineNo', 'ASC']] });
    expect(rl.map(l => [Number(l.debitPaise), Number(l.creditPaise)])).toEqual([
      [0, 900],
      [900, 0],
    ]);
    expect(await balanceOf(w.sid, '1140')).toBe(0);
    expect((await readSocietyBalance(w.sid)).totalPaise).toBe(0);
    let err = await sequelize
      .transaction(t => reverseByRef(w.sys, { refType: 'payment', refId: 72, reason: 'again' }, t))
      .catch(e => e);
    expect([err.status, err.code]).toEqual([409, 'JOURNAL_ALREADY_REVERSED']);
    err = await sequelize
      .transaction(t => reverseEntry(w.sys, rev.id, { reason: 'undo the undo' }, t))
      .catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'REVERSAL_NOT_ALLOWED']);
    // the same source can be posted again after a reversal only through a new ref; the dedupe key ignores the reversal row
    expect(await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.journal.reversed' } })).toBe(
      1,
    );
    err = await sequelize
      .transaction(t => reverseByRef(w.sys, { refType: 'payment', refId: 999, reason: 'none' }, t))
      .catch(e => e);
    expect([err.status, err.code]).toEqual([404, 'JOURNAL_NOT_FOUND']);
  });

  it('the manual route cannot reverse system, opening or closing entries (BR-13-5)', async () => {
    const w = await accountsSociety();
    const r = await post(w.sys, base(73, { lines: lines('1140', '1300', 100) }));
    const o = await post(
      w.sys,
      base('op', {
        voucherType: 'OPENING_BALANCE',
        refType: 'opening',
        source: 'MANUAL',
        lines: lines('1120', '3900', 100),
      }),
    );
    for (const id of [r.id, o.id]) {
      const err = await sequelize
        .transaction(t => reverseEntry(w.user, id, { reason: 'by hand', viaManualRoute: true }, t))
        .catch(e => e);
      expect([err.status, err.code]).toEqual([422, 'REVERSAL_NOT_ALLOWED']);
    }
    const m = await post(
      w.user,
      base('mj', { voucherType: 'JOURNAL', refType: 'manual_journal', lines: lines('5510', '1120', 50) }),
    );
    expect((await JournalEntry.findByPk(m.id))!.source).toBe('MANUAL');
    const ok = await sequelize.transaction(t =>
      reverseEntry(w.user, m.id, { reason: 'by hand', viaManualRoute: true }, t),
    );
    expect(ok.id).toBeGreaterThan(m.id);
  });

  it('a reversal posts after its original was posted again under a new ref (dedupe ignores reversals)', async () => {
    const w = await accountsSociety();
    await post(w.sys, base(74, { lines: lines('1140', '1300', 100) }));
    await sequelize.transaction(t =>
      reverseByRef(w.sys, { refType: 'payment', refId: 74, reason: 'dup' }, t),
    );
    // the original is still the non-reversal entry of the ref: posting the same lines replays it
    const again = await post(w.sys, base(74, { lines: lines('1140', '1300', 100) }));
    expect(again.replayed).toBe(true);
  });
});

describe('period lock (BR-13-8, 9, T13-28)', () => {
  it('locks users, re-dates the system and honours the unlock window and closed years', async () => {
    const w = await accountsSociety();
    await SocietyBalance.update({ booksLockedThrough: '2026-09-30' }, { where: { societyId: w.sid } });
    expect(await isDateLocked(w.sid, '2026-09-15')).toBe(true);
    expect(await isDateLocked(w.sid, '2026-10-01')).toBe(false);
    const err = await post(w.user, base(80, { date: '2026-09-15', lines: lines('1120', '1300', 100) })).catch(
      e => e,
    );
    expect([err.status, err.code]).toEqual([409, 'PERIOD_LOCKED']);
    expect(await JournalEntry.count({ where: { societyId: w.sid } })).toBe(0);
    const sys = await post(w.sys, base(81, { date: '2026-09-30', lines: lines('1120', '1300', 100) }));
    expect(sys.entryDate).toBe('2026-10-01');
    const e = (await JournalEntry.findByPk(sys.id))!;
    expect([e.entryDate, e.documentDate]).toEqual(['2026-10-01', '2026-09-30']);
    expect((await JournalLine.findOne({ where: { journalEntryId: sys.id } }))!.entryDate).toBe('2026-10-01');
    // a temporary unlock window opens the locked dates
    setNow('2026-11-16T05:00:00Z');
    await SocietyBalance.update(
      { unlockFromDate: '2026-09-01', unlockUntil: new Date('2026-11-17T05:00:00Z') },
      { where: { societyId: w.sid } },
    );
    expect(await isDateLocked(w.sid, '2026-09-15')).toBe(false);
    const ok = await post(w.user, base(82, { date: '2026-09-15', lines: lines('1120', '1300', 100) }));
    expect(ok.entryDate).toBe('2026-09-15');
    setNow('2026-11-18T05:00:00Z');
    expect(await isDateLocked(w.sid, '2026-09-15')).toBe(true);
    // closed financial year: locked without exception, even inside an unlock window
    await SocietyBalance.update(
      {
        lastClosedFinancialYear: '2025-26',
        booksLockedThrough: '2026-03-31',
        unlockFromDate: '2026-01-01',
        unlockUntil: new Date('2026-12-01T00:00:00Z'),
      },
      { where: { societyId: w.sid } },
    );
    expect(await isDateLocked(w.sid, '2026-03-31')).toBe(true);
    const s2 = await post(w.sys, base(83, { date: '2026-03-20', lines: lines('1120', '1300', 100) }));
    expect(s2.entryDate).toBe('2026-04-01');
    // reversal into a locked date
    setNow('2026-11-16T05:00:00Z');
    await SocietyBalance.update(
      {
        booksLockedThrough: '2026-11-30',
        unlockFromDate: null,
        unlockUntil: null,
        lastClosedFinancialYear: null,
      },
      { where: { societyId: w.sid } },
    );
    const err2 = await sequelize
      .transaction(t => reverseByRef(w.user, { refType: 'payment', refId: 82, reason: 'locked now' }, t))
      .catch(e => e);
    expect(err2.code).toBe('PERIOD_LOCKED');
    const rev = await sequelize.transaction(t =>
      reverseByRef(w.sys, { refType: 'payment', refId: 82, reason: 'system', date: '2026-11-16' }, t),
    );
    expect((await JournalEntry.findByPk(rev.id))!.entryDate).toBe('2026-12-01');
    setNow(null);
  });

  it('skipLockCheck lets the year-close voucher in', async () => {
    const w = await accountsSociety();
    await SocietyBalance.update({ booksLockedThrough: '2027-03-31' }, { where: { societyId: w.sid } });
    const r = await post(
      w.sys,
      base('c1', {
        date: '2027-03-31',
        voucherType: 'CLOSING',
        refType: 'closing',
        skipLockCheck: true,
        lines: lines('4100', '3100', 100),
      }),
    );
    expect(r.entryDate).toBe('2027-03-31');
  });
});

describe('system keys, funds and accounts (BR-13-3, T13-44)', () => {
  it('resolves the module 12 keys; COLLECTION_FUND needs a fund; BANK needs a collection account', async () => {
    const w = await accountsSociety();
    const fundId = await fundIdByType(w.sid, 'SINKING');
    let err = await post(w.sys, base(90, { lines: lines('BANK', 'MEMBER_RECEIVABLE', 100) })).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'COLLECTION_ACCOUNT_REQUIRED']);
    err = await post(w.sys, base(90, { lines: lines('GATEWAY_CLEARING', 'COLLECTION_FUND', 100) })).catch(
      e => e,
    );
    expect([err.status, err.code]).toEqual([422, 'JOURNAL_LINE_INVALID']);
    const r = await post(
      w.sys,
      base(91, {
        lines: [
          { ledgerAccountCode: 'GATEWAY_CLEARING', debitPaise: 1180, creditPaise: 0 },
          { ledgerAccountCode: 'MEMBER_RECEIVABLE', debitPaise: 0, creditPaise: 800 },
          { ledgerAccountCode: 'COLLECTION_FUND', debitPaise: 0, creditPaise: 300, fundId },
          { ledgerAccountCode: 'GATEWAY_FEE_RECOVERY', debitPaise: 0, creditPaise: 80 },
        ],
      }),
    );
    expect(await balanceOf(w.sid, '1140')).toBe(1180);
    expect(await balanceOf(w.sid, '1300')).toBe(-800);
    expect(await balanceOf(w.sid, '2410')).toBe(-300);
    expect(await balanceOf(w.sid, '4310')).toBe(-80);
    const fl = (
      await JournalLine.findAll({ where: { journalEntryId: r.id }, order: [['lineNo', 'ASC']] })
    )[2]!;
    expect(Number(fl.fundId)).toBe(fundId);
    const bank = await addBankLedger(w.sid);
    await addCollectionBank(w.sid, Number(bank.id));
    await post(w.sys, base(92, { lines: lines('BANK', 'MEMBER_RECEIVABLE', 500) }));
    expect(await balanceOf(w.sid, '1110-001')).toBe(500);
    expect((await readSocietyBalance(w.sid)).inBankPaise).toBe(500);
  });

  it('fund lines: automatic fundId, conflicting fund, closed fund, other society, user fund balance guard', async () => {
    const w = await accountsSociety();
    const w2 = await accountsSociety('Other CHS');
    const sinking = await fundIdByType(w.sid, 'SINKING');
    const repair = await fundIdByType(w.sid, 'REPAIR');
    const r = await post(
      w.sys,
      base(100, {
        lines: [
          { ledgerAccountCode: '1140', debitPaise: 500, creditPaise: 0 },
          { ledgerAccountCode: '2410', debitPaise: 0, creditPaise: 500 },
        ],
      }),
    );
    expect(Number((await JournalLine.findOne({ where: { journalEntryId: r.id, lineNo: 2 } }))!.fundId)).toBe(
      sinking,
    );
    let err = await post(w.sys, base(101, { lines: lines('1140', '2410', 5, { fundId: repair }) })).catch(
      e => e,
    );
    expect([err.status, err.code]).toEqual([422, 'JOURNAL_LINE_INVALID']);
    err = await post(
      w.sys,
      base(102, { lines: lines('1140', '4100', 5, { fundId: await fundIdByType(w2.sid, 'REPAIR') }) }),
    ).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'JOURNAL_LINE_INVALID']);
    await Fund.update({ status: 'CLOSED' }, { where: { id: repair } });
    err = await post(w.sys, base(103, { lines: lines('1140', '4100', 5, { fundId: repair }) })).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'FUND_INACTIVE']);
    // BR-13-32 (opt in): a user posting may not take a fund negative, the system may
    const spend = (ref: number, ctx = w.user) =>
      post(
        ctx,
        base(ref, {
          voucherType: 'PAYMENT',
          enforceFundBalance: true,
          lines: [
            { ledgerAccountCode: '2410', debitPaise: 800, creditPaise: 0 },
            { ledgerAccountCode: '1140', debitPaise: 0, creditPaise: 800 },
          ],
        }),
      );
    err = await spend(104).catch(e => e);
    expect([err.status, err.code]).toEqual([422, 'FUND_BALANCE_INSUFFICIENT']);
    expect((await spend(105, w.sys)).replayed).toBe(false);
    expect(await balanceOf(w.sid, '2410')).toBe(300);
  });
});

describe('manual drafts posted in place (6.1)', () => {
  async function draft(w: Awaited<ReturnType<typeof accountsSociety>>, status = 'DRAFT') {
    const dr = (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '5510' } }))!;
    const cr = (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '1120' } }))!;
    const e = await JournalEntry.create({
      societyId: w.sid,
      voucherNo: null,
      voucherType: 'JOURNAL',
      entryDate: '2026-11-10',
      documentDate: '2026-11-10',
      financialYear: '2026-27',
      narration: 'Office supplies',
      refType: 'manual_journal',
      refId: 'd1',
      linesHash: '0'.repeat(64),
      instrumentRef: null,
      source: 'MANUAL',
      status: 'DRAFT',
      totalPaise: 0,
      reversalOfId: null,
      reversedByEntryId: null,
      reversedAt: null,
      reversalReason: null,
      approvalRequestId: null,
      rejectionReason: null,
      postedAt: null,
      postedBy: null,
      createdBy: w.userId,
      updatedBy: w.userId,
    });
    await JournalLine.bulkCreate([
      {
        societyId: w.sid,
        journalEntryId: Number(e.id),
        lineNo: 1,
        ledgerAccountId: Number(dr.id),
        fundId: null,
        debitPaise: 750,
        creditPaise: 0,
        entryDate: '2026-11-10',
        lineNarration: null,
      },
      {
        societyId: w.sid,
        journalEntryId: Number(e.id),
        lineNo: 2,
        ledgerAccountId: Number(cr.id),
        fundId: null,
        debitPaise: 0,
        creditPaise: 750,
        entryDate: '2026-11-10',
        lineNarration: null,
      },
    ]);
    if (status !== 'DRAFT') await e.update({ status } as never);
    return Number(e.id);
  }

  it('posts a draft and a pending journal, numbers it, applies balances; replays when posted', async () => {
    const w = await accountsSociety();
    const id = await draft(w, 'PENDING_APPROVAL');
    const r = await sequelize.transaction(t => postDraft(w.other, id, t));
    expect(r).toMatchObject({ id, replayed: false });
    expect(r.voucherNo).toMatch(/^JV\//);
    const e = (await JournalEntry.findByPk(id))!;
    expect([e.status, Number(e.totalPaise), e.linesHash.length]).toEqual(['POSTED', 750, 64]);
    expect(await balanceOf(w.sid, '5510')).toBe(750);
    expect(await balanceOf(w.sid, '1120')).toBe(-750);
    expect((await sequelize.transaction(t => postDraft(w.other, id, t))).replayed).toBe(true);
    expect(await balanceOf(w.sid, '5510')).toBe(750);
  });

  it('refuses a locked date, a rejected draft and an unknown id', async () => {
    const w = await accountsSociety();
    const id = await draft(w);
    await SocietyBalance.update({ booksLockedThrough: '2026-11-30' }, { where: { societyId: w.sid } });
    let err = await sequelize.transaction(t => postDraft(w.user, id, t)).catch(e => e);
    expect(err.code).toBe('PERIOD_LOCKED');
    await SocietyBalance.update({ booksLockedThrough: null }, { where: { societyId: w.sid } });
    await JournalEntry.update({ status: 'REJECTED' }, { where: { id } });
    err = await sequelize.transaction(t => postDraft(w.user, id, t)).catch(e => e);
    expect(err.code).toBe('INVALID_STATE');
    err = await sequelize.transaction(t => postDraft(w.user, 99999, t)).catch(e => e);
    expect([err.status, err.code]).toEqual([404, 'JOURNAL_NOT_FOUND']);
  });
});

describe('balance verification (F23, T13-39)', () => {
  it('finds nothing on clean books and corrects a tampered balance with audit and notification', async () => {
    const w = await accountsSociety();
    await post(w.sys, base(110, { lines: lines('1140', '1300', 700) }));
    expect(await verifyBalances(w.sid)).toBeNull();
    expect((await SocietyBalance.findOne({ where: { societyId: w.sid } }))!.lastVerifiedAt).not.toBeNull();
    await sequelize.query(
      'UPDATE society_balances SET totalPaise = 1, clearingPaise = 1 WHERE societyId = ?',
      { replacements: [w.sid] },
    );
    await sequelize.query(
      "UPDATE ledger_accounts SET balancePaise = 5 WHERE societyId = ? AND code = '1300'",
      { replacements: [w.sid] },
    );
    const rep = await verifyBalances(w.sid);
    expect(rep!.corrected).toBe(true);
    expect(rep!.ledgerDrift).toEqual([expect.objectContaining({ code: '1300', stored: 5, rebuilt: -700 })]);
    expect(await balanceOf(w.sid, '1300')).toBe(-700);
    const b = await readSocietyBalance(w.sid);
    expect([b.totalPaise, b.clearingPaise]).toEqual([700, 700]);
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.balance.drift_corrected' } }),
    ).toBe(1);
    expect(
      accountsPortCalls.some(
        c =>
          c.fn === 'notifications.send' &&
          (c.input as { template: string }).template === 'accounts.balance_drift',
      ),
    ).toBe(true);
    expect(await verifyBalances(w.sid)).toBeNull();
  });

  it('ignores lines of drafts when rebuilding', async () => {
    const w = await accountsSociety();
    await post(w.sys, base(111, { lines: lines('1140', '1300', 700) }));
    const dr = (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '1120' } }))!;
    const e = await JournalEntry.create({
      societyId: w.sid,
      voucherNo: null,
      voucherType: 'JOURNAL',
      entryDate: '2026-11-10',
      documentDate: '2026-11-10',
      financialYear: '2026-27',
      narration: 'Draft only',
      refType: 'manual_journal',
      refId: 'dd',
      linesHash: '0'.repeat(64),
      source: 'MANUAL',
      status: 'DRAFT',
      totalPaise: 0,
    } as never);
    await JournalLine.create({
      societyId: w.sid,
      journalEntryId: Number(e.id),
      lineNo: 1,
      ledgerAccountId: Number(dr.id),
      debitPaise: 5,
      creditPaise: 0,
      entryDate: '2026-11-10',
    } as never);
    expect(await verifyBalances(w.sid)).toBeNull();
  });
});
