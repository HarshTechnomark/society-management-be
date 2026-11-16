import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import type { ExportProvider } from '../societies/societies.exports';

/**
 * Module 05 export provider of module 13: all 12 tables as stored, in `id` order, 200 rows at a time. `bank_accounts` leaves out
 * the encrypted account number (the export never carries a full account number; the last 4 digits stay).
 */
const BATCH = 200;

export const ACCOUNTS_TABLES = [
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
] as const;

const COLUMNS: Partial<Record<(typeof ACCOUNTS_TABLES)[number], string>> = {
  bank_accounts: `id, societyId, ledgerAccountId, displayName, bankName, branchName, ifsc, accountKind, accountHolderName,
    accountNumberLast4, isCollectionAccount, statementFormat, openingBalancePaise, openingBalanceDate, verificationStatus,
    verifiedBy, verifiedAt, lastReconciledDate, lastReconciledBalancePaise, status, closedAt, version, createdBy, updatedBy,
    createdAt, updatedAt`,
};

function streamTable(table: (typeof ACCOUNTS_TABLES)[number]) {
  return async function* (societyId: number): AsyncGenerator<Record<string, unknown>> {
    let last = 0;
    for (;;) {
      const rows = await sequelize.query<Record<string, unknown> & { id: number }>(
        `SELECT ${COLUMNS[table] ?? '*'} FROM ${table} WHERE societyId = :societyId AND id > :last ORDER BY id ASC LIMIT ${BATCH}`,
        { replacements: { societyId, last }, type: QueryTypes.SELECT },
      );
      if (!rows.length) return;
      for (const r of rows) yield r;
      last = rows[rows.length - 1]!.id;
    }
  };
}

export const accountsExportProvider: ExportProvider = {
  module: 'accounts',
  tables: ACCOUNTS_TABLES.map(name => ({ name, file: `${name}.csv`, stream: streamTable(name) })),
};
