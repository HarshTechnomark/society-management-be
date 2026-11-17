import { backfillBooks } from '../src/modules/accounts/accounts.public';
import { seedAccountsOpening } from './accounts-opening';

/**
 * Module 13 demo seed (not run in production, except the chart which is also the backfill for existing societies). The foundation
 * seeds the chart of accounts and the three standard funds for every society (idempotent: societies already seeded are skipped).
 * Each part adds ONE entry to `ACCOUNTS_SEEDERS` that calls its own function from `seeders/accounts-<part>.ts`
 * (13.1 opening balances, 13.2 bank accounts and expenses, 13.3 a settlement and a statement, 13.4 deposits and a period lock).
 * Every seeder is idempotent and returns what it created or skipped.
 */
export interface AccountsSeedReport {
  created: string[];
  skipped: string[];
}

async function seedChart(): Promise<AccountsSeedReport> {
  const done = await backfillBooks();
  return {
    created: done.map(id => `chart for society ${id}`),
    skipped: done.length ? [] : ['every society already has its chart'],
  };
}

export const ACCOUNTS_SEEDERS: { name: string; run: () => Promise<AccountsSeedReport> }[] = [
  { name: 'chart', run: seedChart },
  { name: 'opening', run: seedAccountsOpening },
];

export async function seedAccounts(): Promise<AccountsSeedReport> {
  const report: AccountsSeedReport = { created: [], skipped: [] };
  for (const s of ACCOUNTS_SEEDERS) {
    const r = await s.run();
    report.created.push(...r.created.map(c => `${s.name}: ${c}`));
    report.skipped.push(...r.skipped.map(c => `${s.name}: ${c}`));
  }
  return report;
}
