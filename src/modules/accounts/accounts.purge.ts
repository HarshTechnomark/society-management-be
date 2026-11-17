import { sequelize } from '../../models';
import type { ACCOUNTS_TABLES } from './accounts.exports';

/**
 * Module 05 purge handler of module 13 (order 130: it runs before modules 12 and 11, because expenses and deposits reference their collections and invoices). BR-05-21 forbids purge handlers to touch financial tables;
 * all 12 tables are financial records (or financial evidence, like bank statements), so `purgeAccounts` deletes and anonymises
 * nothing. The books stay until the end of financial retention, when
 * `deleteRetainedAccounts` removes all 12 tables (children first). Posted journals are protected by triggers and hooks, so the delete
 * runs on one connection with `@accounts_purge = 1`, which the delete triggers accept.
 */
export const PURGE_TABLES: string[] = [];

export async function purgeAccounts(_societyId: number): Promise<{ deleted: number; anonymised: number }> {
  return { deleted: 0, anonymised: 0 };
}

/** Children first (BR-05-38). */
const DELETE_ORDER: readonly (typeof ACCOUNTS_TABLES)[number][] = [
  'bank_statement_lines',
  'bank_statement_imports',
  'settlements',
  'expenses',
  'deposits',
  'balance_history',
  'society_balances',
  'journal_lines',
  'journal_entries',
  'bank_accounts',
  'funds',
  'ledger_accounts',
];
const BATCH = 1000;

export async function deleteRetainedAccounts(societyId: number): Promise<{ deleted: number }> {
  return sequelize.transaction(async t => {
    await sequelize.query('SET @accounts_purge = 1', { transaction: t });
    let deleted = 0;
    try {
      for (const table of DELETE_ORDER)
        for (;;) {
          // `id DESC` keeps self references (reversal pairs, parent accounts) valid inside a batch
          const [, meta] = await sequelize.query(
            `DELETE FROM ${table} WHERE societyId = :societyId ORDER BY id DESC LIMIT ${BATCH}`,
            { replacements: { societyId }, transaction: t },
          );
          const n = Number((meta as { affectedRows?: number })?.affectedRows ?? 0);
          deleted += n;
          if (n < BATCH) break;
        }
    } finally {
      await sequelize.query('SET @accounts_purge = 0', { transaction: t });
    }
    return { deleted };
  });
}
