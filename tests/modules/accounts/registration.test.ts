import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import {
  AuditLog,
  BankAccount,
  JournalEntry,
  LedgerAccount,
  SocietyBalance,
  closeDb,
  sequelize,
} from '../../../src/models';
import { queueRegistry } from '../../../src/lib/queue';
import { exportProviders, registerExportProvider } from '../../../src/modules/societies/societies.exports';
import { purgeHandlerList, retentionHandlerList } from '../../../src/modules/societies/societies.purge';
import {
  registerAccounts,
  balance,
  funds,
  ledgerAccounts,
  bankAccounts,
  deposits,
  settlements,
  expenses,
  accountReports,
  accounts,
  cashBook,
  expenseReports,
  ReadTimeoutError,
  journal,
} from '../../../src/modules/accounts/accounts.public';
import { ACCOUNTS_TABLES, accountsExportProvider } from '../../../src/modules/accounts/accounts.exports';
import { deleteRetainedAccounts, purgeAccounts } from '../../../src/modules/accounts/accounts.purge';
import { ACCOUNTS_SEEDERS, seedAccounts } from '../../../seeders/accounts';
import {
  ACCOUNT_SUBTYPES,
  APPROVAL_TYPES,
  ENT,
  ERR,
  PERM,
  SYSTEM_KEYS,
} from '../../../src/modules/accounts/accounts.constants';
import { isKnownKey } from '../../../src/modules/access-control/access-control.permissions';
import { FEATURE_ROWS } from '../../../src/modules/subscriptions/subscriptions.catalogue-data';
import {
  accountsSociety,
  addBankLedger,
  addCollectionBank,
  post,
  resetAccounts,
} from '../../helpers/accounts';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetAccounts);

describe('start-up registration', () => {
  it('registers the export provider, purge and retention handlers, queue and job; repeating it is harmless', async () => {
    registerAccounts();
    registerAccounts();
    expect(exportProviders().filter(p => p.module === 'accounts')).toHaveLength(1);
    expect(
      exportProviders()
        .find(p => p.module === 'accounts')!
        .tables.map(t => t.name),
    ).toEqual([...ACCOUNTS_TABLES]);
    expect(purgeHandlerList().find(h => h.module === 'accounts')).toBeDefined();
    const ret = retentionHandlerList();
    const iAccounts = ret.findIndex(h => h.module === 'accounts');
    const iPayments = ret.findIndex(h => h.module === 'payments');
    expect(iAccounts).toBeGreaterThanOrEqual(0);
    if (iPayments >= 0) expect(iAccounts).toBeLessThan(iPayments); // expenses reference collections, deposits reference invoices
    expect(queueRegistry.get('accounts')).toBeDefined();
  });

  it('the constants match the spec lists', () => {
    expect(Object.values(APPROVAL_TYPES).sort()).toEqual([
      'DEPOSIT_REFUND',
      'EXPENSE',
      'FUND_TRANSFER',
      'MANUAL_JOURNAL',
      'PERIOD_UNLOCK',
    ]);
    expect(ACCOUNT_SUBTYPES).toHaveLength(14);
    expect(ERR.journalNotBalanced).toBe('JOURNAL_NOT_BALANCED');
    expect(ERR.periodLocked).toBe('PERIOD_LOCKED');
    expect(Object.keys(SYSTEM_KEYS)).toHaveLength(15);
  });

  it('the permission and entitlement keys of the constants exist in the catalogues', async () => {
    for (const k of Object.values(PERM)) expect(isKnownKey(k), k).toBe(true);
    const features = new Set(FEATURE_ROWS.map(r => r[0]));
    for (const k of Object.values(ENT)) expect(features.has(k), k).toBe(true);
  });
});

describe('public interface of section 8.20 and 8.21', () => {
  it('real readers work and the part stubs say they are not implemented', async () => {
    const w = await accountsSociety();
    const b = await balance.get(w.sid);
    expect(b).toMatchObject({ totalPaise: 0, inBankPaise: 0, generalPaise: 0, lastChangedAt: null });
    expect(b.funds.map(f => f.name)).toEqual(['Sinking fund', 'Repair and maintenance fund', 'Corpus fund']);
    expect(await ledgerAccounts.exists(w.sid, '5330')).toBe(true);
    const f = await funds.get(w.sid, b.funds[0]!.id);
    expect(f).toMatchObject({ fundType: 'SINKING', status: 'ACTIVE', ledgerCode: '2410', balancePaise: 0 });
    expect(await funds.get(w.sid + 99, b.funds[0]!.id)).toBeNull();
    expect(await bankAccounts.get(w.sid, 1)).toBeNull();
    const bank = await addBankLedger(w.sid);
    const id = await addCollectionBank(w.sid, Number(bank.id));
    expect(await bankAccounts.get(w.sid, id)).toMatchObject({
      maskedNumber: 'XXXXXX4821',
      ledgerCode: '1110-001',
      isCollectionAccount: true,
      verificationStatus: 'UNVERIFIED',
    });
    expect(await accounts.bankLedgerCode(w.sid, id)).toBe('1110-001');
    expect(await accounts.collectionBankAccount(w.sid)).toEqual({ id, ledgerCode: '1110-001' });
    expect(await accounts.isDateLocked(w.sid, '2026-01-01')).toBe(false);
    await expect(accounts.bankLedgerCode(w.sid, 99999)).rejects.toMatchObject({
      code: 'BANK_ACCOUNT_NOT_FOUND',
    });
    const stubs: (() => Promise<unknown>)[] = [
      () => accountReports.run(w.sid, 'trial-balance', {}, { deadlineMs: 100 }),
      () => accountReports.fundStatement(w.sid, 1, '2026-04-01', '2027-03-31', { deadlineMs: 100 }),
      () => cashBook.monthlyTotals(w.sid, '2026-04-01', '2027-03-31', { deadlineMs: 100 }),
      () => expenseReports.byHead(w.sid, { from: '2026-04-01', to: '2027-03-31' }, { deadlineMs: 100 }),
      () => expenseReports.tdsDeposited(w.sid, { from: '2026-04-01', to: '2027-03-31' }, { deadlineMs: 100 }),
    ];
    expect(await expenses.listForCollection(w.sid, 1)).toEqual([]); // filled by 13.2a
    for (const s of stubs)
      await expect(s()).rejects.toMatchObject({ status: 501, code: 'NOT_IMPLEMENTED_IN_FOUNDATION' });
    // deposits.request, requestRefund and registerOwner are real since 13.4a (tests/modules/accounts/accounts.deposits.flow.test.ts)
    expect(deposits.registerOwner).toBeTypeOf('function');
    expect(new ReadTimeoutError(5)).toBeInstanceOf(Error);
    expect(journal.post).toBeTypeOf('function');
    expect(settlements.ingest).toBeTypeOf('function');
  });
});

describe('export, purge and retention of the 12 tables', () => {
  it('exports every table of the society, leaves the encrypted account number out, and only that society', async () => {
    const w = await accountsSociety();
    const o = await accountsSociety('Other CHS');
    const bank = await addBankLedger(w.sid);
    await addCollectionBank(w.sid, Number(bank.id));
    await post(w.sys, {
      date: '2026-11-10',
      voucherType: 'RECEIPT',
      refType: 'payment',
      refId: 1,
      narration: 'Receipt one',
      lines: [
        { ledgerAccountCode: '1140', debitPaise: 5, creditPaise: 0 },
        { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 5 },
      ],
    });
    await post(o.sys, {
      date: '2026-11-10',
      voucherType: 'RECEIPT',
      refType: 'payment',
      refId: 1,
      narration: 'Receipt other',
      lines: [
        { ledgerAccountCode: '1140', debitPaise: 7, creditPaise: 0 },
        { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 7 },
      ],
    });
    const counts: Record<string, number> = {};
    for (const t of accountsExportProvider.tables) {
      let n = 0;
      for await (const row of t.stream(w.sid)) {
        n += 1;
        expect(Number(row.societyId)).toBe(w.sid);
        expect(row).not.toHaveProperty('accountNumberEnc');
      }
      counts[t.name] = n;
    }
    expect(counts.ledger_accounts).toBeGreaterThan(100);
    expect(counts).toMatchObject({
      funds: 3,
      journal_entries: 1,
      journal_lines: 2,
      society_balances: 1,
      balance_history: 1,
      bank_accounts: 1,
      expenses: 0,
    });
    expect(registerExportProvider).toBeTypeOf('function');
  });

  it('purge touches nothing; the retention delete removes posted journals, bank accounts and the chart of one society only', async () => {
    const w = await accountsSociety();
    const o = await accountsSociety('Other CHS');
    const bank = await addBankLedger(w.sid);
    await addCollectionBank(w.sid, Number(bank.id));
    for (const x of [w, o])
      await post(x.sys, {
        date: '2026-11-10',
        voucherType: 'RECEIPT',
        refType: 'payment',
        refId: 1,
        narration: 'Receipt one',
        lines: [
          { ledgerAccountCode: '1140', debitPaise: 5, creditPaise: 0 },
          { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 5 },
        ],
      });
    await sequelize.transaction(async t => {
      await post(w.sys, {
        date: '2026-11-10',
        voucherType: 'RECEIPT',
        refType: 'payment',
        refId: 2,
        narration: 'Receipt two',
        lines: [
          { ledgerAccountCode: '1140', debitPaise: 5, creditPaise: 0 },
          { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: 5 },
        ],
      });
      void t;
    });
    expect(await purgeAccounts(w.sid)).toEqual({ deleted: 0, anonymised: 0 });
    expect(await JournalEntry.count({ where: { societyId: w.sid } })).toBe(2);
    const r = await deleteRetainedAccounts(w.sid);
    expect(r.deleted).toBeGreaterThan(100);
    for (const model of [JournalEntry, LedgerAccount, BankAccount, SocietyBalance])
      expect(await (model as typeof JournalEntry).count({ where: { societyId: w.sid } })).toBe(0);
    expect(await JournalEntry.count({ where: { societyId: o.sid } })).toBe(1);
    expect(await LedgerAccount.count({ where: { societyId: o.sid } })).toBeGreaterThan(100);
    // the delete bypass is off again on that connection pool: a posted entry still cannot be deleted through the model
    const e = (await JournalEntry.findOne({ where: { societyId: o.sid } }))!;
    await expect(e.destroy()).rejects.toThrow();
    expect(await AuditLog.count({ where: { societyId: w.sid } })).toBeGreaterThan(0);
  });
});

describe('seeder', () => {
  it('seeds the chart of every society and is idempotent', async () => {
    const a = await accountsSociety('A CHS', false);
    const b = await accountsSociety('B CHS', false);
    expect(ACCOUNTS_SEEDERS.map(s => s.name)).toContain('chart');
    const r1 = await seedAccounts();
    expect(r1.created.join(' ')).toContain(`society ${a.sid}`);
    expect(r1.created.join(' ')).toContain(`society ${b.sid}`);
    const r2 = await seedAccounts();
    expect(r2.created).toEqual([]);
    expect(r2.skipped[0]).toContain('already');
    const n = await sequelize.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM society_balances WHERE chartSeededAt IS NOT NULL',
      { type: QueryTypes.SELECT },
    );
    expect(Number(n[0]!.n)).toBe(2);
  });
});
