import { seedTemplates } from '../src/modules/communication/communication.seed';

/**
 * Module 16 seed: `templates:sync` (every module's template keys in `notification_templates`, section 10.2). Each part adds ONE entry to
 * `COMMUNICATION_SEEDERS` calling its own function from `seeders/communication-<part>.ts` (16.1: demo notices, 16.3: a drill and a survey).
 * Every seeder is idempotent and returns what it created or skipped.
 */
export interface CommunicationSeedReport {
  created: string[];
  skipped: string[];
}

async function syncTemplates(): Promise<CommunicationSeedReport> {
  const r = await seedTemplates();
  return {
    created: r.written ? [`${r.written} template rows written for ${r.keys} keys`] : [],
    skipped: r.written ? [] : [`all ${r.keys} template keys already in sync`],
  };
}

export const COMMUNICATION_SEEDERS: { name: string; run: () => Promise<CommunicationSeedReport> }[] = [
  { name: 'templates', run: syncTemplates },
  // parts add their demo seeders here, one line each
];

export async function seedCommunication(): Promise<CommunicationSeedReport> {
  const report: CommunicationSeedReport = { created: [], skipped: [] };
  for (const s of COMMUNICATION_SEEDERS) {
    const r = await s.run();
    report.created.push(...r.created.map(c => `${s.name}: ${c}`));
    report.skipped.push(...r.skipped.map(c => `${s.name}: ${c}`));
  }
  return report;
}
