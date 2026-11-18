import { backfillHelpdesk } from '../src/modules/helpdesk/helpdesk.seed';

/**
 * Module 15 seed (the catalogue is also seeded lazily on the first helpdesk call of a society and on society creation). Each part adds ONE entry to
 * `HELPDESK_SEEDERS` calling its own function from `seeders/helpdesk-<part>.ts` (15.2 or 15.3: the nine prototype tickets of the demo society).
 * Every seeder is idempotent and returns what it created or skipped.
 */
export interface HelpdeskSeedReport {
  created: string[];
  skipped: string[];
}

async function seedCatalogue(): Promise<HelpdeskSeedReport> {
  const done = await backfillHelpdesk();
  return {
    created: done.map(id => `categories, SLA policy and escalation rules for society ${id}`),
    skipped: done.length ? [] : ['every society already has its helpdesk catalogue'],
  };
}

export const HELPDESK_SEEDERS: { name: string; run: () => Promise<HelpdeskSeedReport> }[] = [
  { name: 'catalogue', run: seedCatalogue },
  // parts add their demo seeders here, one line each
];

export async function seedHelpdesk(): Promise<HelpdeskSeedReport> {
  const report: HelpdeskSeedReport = { created: [], skipped: [] };
  for (const s of HELPDESK_SEEDERS) {
    const r = await s.run();
    report.created.push(...r.created.map(c => `${s.name}: ${c}`));
    report.skipped.push(...r.skipped.map(c => `${s.name}: ${c}`));
  }
  return report;
}
