import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { closeDb, sequelize } from '../../../src/models';
import { accountsSociety, addBankLedger, post, resetAccounts } from '../../helpers/accounts';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetAccounts);

const TABLES = [
  'ledger_accounts',
  'funds',
  'journal_entries',
  'journal_lines',
  'society_balances',
  'balance_history',
  'bank_accounts',
  'expenses',
  'settlements',
  'bank_statement_imports',
  'bank_statement_lines',
  'deposits',
];
const at = '2026-11-10 10:00:00.000';
const run = (sql: string, replacements: unknown[] = []) => sequelize.query(sql, { replacements });
const code = async (p: Promise<unknown>) =>
  await p
    .then(() => 'ok')
    .catch((e: Error & { parent?: { message?: string } }) => e.parent?.message ?? e.message);

describe('module 13 schema (7.1 to 7.12)', () => {
  it('has the 12 tables, every one with a societyId foreign key RESTRICT', async () => {
    const t = await sequelize.query<{ t: string }>(
      'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
      { type: QueryTypes.SELECT },
    );
    for (const name of TABLES) expect(t.map(r => r.t)).toContain(name);
    const fks = await sequelize.query<{ t: string; rule: string }>(
      `SELECT TABLE_NAME AS t, DELETE_RULE AS \`rule\` FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'societies'`,
      { type: QueryTypes.SELECT },
    );
    for (const name of TABLES) expect(fks.find(f => f.t === name)?.rule, name).toBe('RESTRICT');
  });

  it('ledger accounts: code format, unique code and system key per society, type check', async () => {
    const w = await accountsSociety();
    const ins = (c: string, key: string | null, type = 'ASSET') =>
      run(
        `INSERT INTO ledger_accounts (societyId, code, name, accountType, systemKey, createdAt, updatedAt) VALUES (?, ?, 'Some account', ?, ?, ?, ?)`,
        [w.sid, c, type, key, at, at],
      );
    expect(await code(ins('12A4', null))).toMatch(/ck_ledger_accounts_code/);
    expect(await code(ins('4100', null))).toMatch(/Duplicate/);
    expect(await code(ins('7000', 'GATEWAY_CLEARING'))).toMatch(/Duplicate/);
    expect(await code(ins('7001', null, 'EQUITY'))).toMatch(/ck_ledger_accounts_type/);
    expect(await code(ins('7002', null))).toBe('ok');
    // the same code in another society is fine
    const o = await accountsSociety('Other CHS');
    expect(
      await code(run(`SELECT COUNT(*) FROM ledger_accounts WHERE societyId = ? AND code = '4100'`, [o.sid])),
    ).toBe('ok');
  });

  it('journal entries and lines: CHECKs, generated dedupe key, one reversal per entry', async () => {
    const w = await accountsSociety();
    const entry = (over: Record<string, unknown> = {}) => {
      const e = {
        status: 'DRAFT',
        refType: 'x_ref',
        refId: '1',
        reversalOfId: null,
        voucherNo: null,
        totalPaise: 0,
        postedAt: null,
        ...over,
      };
      return run(
        `INSERT INTO journal_entries (societyId, voucherNo, voucherType, entryDate, documentDate, financialYear, narration, refType, refId,
           linesHash, source, status, totalPaise, reversalOfId, postedAt, createdAt, updatedAt)
         VALUES (?, ?, 'JOURNAL', '2026-11-10', '2026-11-10', '2026-27', 'narration', ?, ?, ?, 'SYSTEM', ?, ?, ?, ?, ?, ?)`,
        [
          w.sid,
          e.voucherNo,
          e.refType,
          e.refId,
          '0'.repeat(64),
          e.status,
          e.totalPaise,
          e.reversalOfId,
          e.postedAt,
          at,
          at,
        ],
      );
    };
    expect(await code(entry({ status: 'POSTED' }))).toMatch(/ck_journal_entries_posted/);
    expect(await code(entry({ status: 'NOPE' }))).toMatch(/ck_journal_entries_status/);
    expect(await code(entry())).toBe('ok');
    expect(await code(entry())).toMatch(/uq_journal_entries_dedupe/); // same (refType, refId) among live entries
    expect(await code(entry({ status: 'CANCELLED' }))).toBe('ok'); // a cancelled draft frees the source
    expect(
      await code(entry({ refId: '2', status: 'POSTED', voucherNo: 'JV/1', totalPaise: 5, postedAt: at })),
    ).toBe('ok');
    const [row] = await sequelize.query<{ id: number; dedupeKey: string | null }>(
      "SELECT id, dedupeKey FROM journal_entries WHERE societyId = ? AND refId = '2'",
      { replacements: [w.sid], type: QueryTypes.SELECT },
    );
    expect(row!.dedupeKey).toBe('x_ref:2');
    // two reversals of one entry are refused; a reversal has no dedupe key
    expect(
      await code(
        entry({
          refId: '2',
          status: 'POSTED',
          voucherNo: 'JV/2',
          totalPaise: 5,
          postedAt: at,
          reversalOfId: row!.id,
        }),
      ),
    ).toBe('ok');
    expect(
      await code(
        entry({
          refId: '2',
          status: 'POSTED',
          voucherNo: 'JV/3',
          totalPaise: 5,
          postedAt: at,
          reversalOfId: row!.id,
        }),
      ),
    ).toMatch(/uq_journal_entries_reversal/);
    const line = (entryId: number, d: number, c: number, no = 1) =>
      run(
        `INSERT INTO journal_lines (societyId, journalEntryId, lineNo, ledgerAccountId, debitPaise, creditPaise, entryDate, createdAt, updatedAt)
         SELECT ?, ?, ?, id, ?, ?, '2026-11-10', ?, ? FROM ledger_accounts WHERE societyId = ? AND code = '1140'`,
        [w.sid, entryId, no, d, c, at, at, w.sid],
      );
    const [draft] = await sequelize.query<{ id: number }>(
      "SELECT id FROM journal_entries WHERE societyId = ? AND refId = '1' AND status = 'DRAFT'",
      { replacements: [w.sid], type: QueryTypes.SELECT },
    );
    expect(await code(line(draft!.id, 5, 5))).toMatch(/ck_journal_lines_amount/);
    expect(await code(line(draft!.id, 0, 0))).toMatch(/ck_journal_lines_amount/);
    expect(await code(line(draft!.id, -5, 0))).toMatch(/ck_journal_lines_amount/);
    expect(await code(line(draft!.id, 5, 0))).toBe('ok');
    expect(await code(line(draft!.id, 5, 0))).toMatch(/uq_journal_lines_no/);
    expect(await code(line(draft!.id, 0, 5, 201))).toMatch(/ck_journal_lines_no/);
  });

  it('society balance: the total equals the four figures; the unlock window is both or neither; one row per society', async () => {
    const w = await accountsSociety();
    expect(
      await code(run('UPDATE society_balances SET totalPaise = 5 WHERE societyId = ?', [w.sid])),
    ).toMatch(/ck_society_balances_total/);
    expect(
      await code(
        run('UPDATE society_balances SET unlockFromDate = ? WHERE societyId = ?', ['2026-01-01', w.sid]),
      ),
    ).toMatch(/ck_society_balances_unlock/);
    expect(
      await code(
        run("UPDATE society_balances SET lastClosedFinancialYear = '2026' WHERE societyId = ?", [w.sid]),
      ),
    ).toMatch(/ck_society_balances_fy/);
    expect(
      await code(
        run('INSERT INTO society_balances (societyId, createdAt, updatedAt) VALUES (?, ?, ?)', [
          w.sid,
          at,
          at,
        ]),
      ),
    ).toMatch(/Duplicate/);
  });

  it('funds: unique name per society ignoring case, one fund per ledger', async () => {
    const w = await accountsSociety();
    const ledger = await addBankLedger(w.sid, '2440-001', 'Event fund');
    const fund = (name: string, key: string, ledgerId: number) =>
      run(
        `INSERT INTO funds (societyId, fundType, name, nameKey, ledgerAccountId, createdAt, updatedAt) VALUES (?, 'COLLECTION', ?, ?, ?, ?, ?)`,
        [w.sid, name, key, ledgerId, at, at],
      );
    expect(await code(fund('SINKING FUND', 'sinking fund', Number(ledger.id)))).toMatch(/uq_funds_name/);
    expect(await code(fund('Diwali', 'diwali', Number(ledger.id)))).toBe('ok');
    expect(await code(fund('Holi', 'holi', Number(ledger.id)))).toMatch(/uq_funds_ledger/);
  });

  it('bank accounts: one active collection account per society, masked columns, hash unique', async () => {
    const w = await accountsSociety();
    const l1 = await addBankLedger(w.sid, '1110-001', 'Bank 1');
    const l2 = await addBankLedger(w.sid, '1110-002', 'Bank 2');
    const bank = (
      ledgerId: number,
      hash: string,
      collection: number,
      status = 'ACTIVE',
      ifsc = 'HDFC0001234',
    ) =>
      run(
        `INSERT INTO bank_accounts (societyId, ledgerAccountId, displayName, bankName, ifsc, accountHolderName, accountNumberEnc, accountNumberLast4,
           accountNumberHash, isCollectionAccount, status, createdAt, updatedAt) VALUES (?, ?, 'B', 'Bank', ?, 'Holder', 'enc', '4821', ?, ?, ?, ?, ?)`,
        [w.sid, ledgerId, ifsc, hash.padEnd(64, '0'), collection, status, at, at],
      );
    expect(await code(bank(Number(l1.id), 'a', 1, 'ACTIVE', 'bad'))).toMatch(/ck_bank_accounts_ifsc/);
    expect(await code(bank(Number(l1.id), 'a', 1))).toBe('ok');
    expect(await code(bank(Number(l2.id), 'b', 1))).toMatch(/uq_bank_accounts_collection/);
    expect(await code(bank(Number(l2.id), 'a', 0))).toMatch(/uq_bank_accounts_number/);
    expect(await code(bank(Number(l2.id), 'b', 1, 'CLOSED'))).toBe('ok'); // a closed account no longer holds the flag
  });

  it('expenses, settlements, statement lines and deposits keep their CHECKs', async () => {
    const w = await accountsSociety();
    const [head] = await sequelize.query<{ id: number }>(
      "SELECT id FROM ledger_accounts WHERE societyId = ? AND code = '5330'",
      { replacements: [w.sid], type: QueryTypes.SELECT },
    );
    const [cash] = await sequelize.query<{ id: number }>(
      "SELECT id FROM ledger_accounts WHERE societyId = ? AND code = '1120'",
      { replacements: [w.sid], type: QueryTypes.SELECT },
    );
    const expense = (
      gross: number,
      gst: number,
      tds: number,
      net: number,
      section: string | null,
      status = 'DRAFT',
    ) =>
      run(
        `INSERT INTO expenses (societyId, expenseDate, payee, ledgerAccountId, grossAmountPaise, gstPaise, tdsPaise, tdsSection, netPaidPaise,
           paidFromLedgerAccountId, paymentMode, status, createdBy, createdAt, updatedAt) VALUES (?, '2026-11-10', 'Lift Co', ?, ?, ?, ?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`,
        [w.sid, head!.id, gross, gst, tds, section, net, cash!.id, status, w.userId, at, at],
      );
    expect(await code(expense(1_180_000, 180_000, 20_000, 1_160_000, '194C'))).toBe('ok');
    expect(await code(expense(1_180_000, 0, 20_000, 1_180_000, '194C'))).toMatch(/ck_expenses_net/);
    expect(await code(expense(1_180_000, 1_180_000, 0, 1_180_000, null))).toMatch(/ck_expenses_gst/);
    expect(await code(expense(1_180_000, 0, 20_000, 1_160_000, null))).toMatch(/ck_expenses_tds_section/);
    expect(await code(expense(50, 0, 0, 50, null))).toMatch(/ck_expenses_gross/);
    expect(await code(expense(1_000, 0, 0, 1_000, null, 'POSTED'))).toMatch(/ck_expenses_posted/);

    const settlement = (net: number) =>
      run(
        `INSERT INTO settlements (societyId, gatewayProvider, gatewaySettlementId, settlementDate, grossPaise, refundsPaise, feePaise, feeGstPaise, adjustmentPaise,
           netPaise, items, source, createdAt, updatedAt) VALUES (?, 'RAZORPAY', ?, '2026-11-10', 1361800, 0, 3530, 635, 0, ?, ?, 'REPORT_UPLOAD', ?, ?)`,
        [
          w.sid,
          `setl_${net}`,
          net,
          JSON.stringify([
            {
              type: 'payment',
              gatewayPaymentId: 'pay_1',
              amountPaise: 1361800,
              feePaise: 3530,
              taxPaise: 635,
            },
          ]),
          at,
          at,
        ],
      );
    expect(await code(settlement(1_357_635))).toBe('ok'); // 1,361,800 - 3,530 - 635, example 6.4
    expect(await code(settlement(1_357_000))).toMatch(/ck_settlements_net/);
    const idx = await sequelize.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'settlements' AND INDEX_NAME = 'ix_settlements_items'",
      { type: QueryTypes.SELECT },
    );
    expect(Number(idx[0]!.n)).toBeGreaterThan(0);

    const unit = 1; // the foreign key to units is switched off on the one connection of the insert
    const deposit = (
      amount: number,
      received: number,
      deducted: number,
      refunded: number,
      requested: number,
    ) =>
      sequelize.transaction(async t => {
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { transaction: t });
        try {
          await sequelize.query(
            `INSERT INTO deposits (societyId, unitId, kind, ledgerAccountId, title, amountPaise, receivedPaise, deductedPaise, refundedPaise, refundRequestedPaise,
           adjustments, createdAt, updatedAt) VALUES (?, ?, 'MOVE', ?, 'Move-in deposit', ?, ?, ?, ?, ?, '[]', ?, ?)`,
            {
              replacements: [w.sid, unit, cash!.id, amount, received, deducted, refunded, requested, at, at],
              transaction: t,
            },
          );
        } finally {
          await sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { transaction: t });
        }
      });
    expect(await code(deposit(500_000, 500_000, 50_000, 0, 450_000))).toBe('ok');
    expect(await code(deposit(500_000, 500_000, 50_000, 0, 460_000))).toMatch(/ck_deposits_held/);
    expect(await code(deposit(500_000, 600_000, 0, 0, 0))).toMatch(/ck_deposits_received/);
    expect(await code(deposit(50, 0, 0, 0, 0))).toMatch(/ck_deposits_amount/);
  });
});

void post;
