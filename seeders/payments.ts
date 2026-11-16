import { seedPaymentsAdmin } from './payments-admin';
/**
 * Module 12 demo seed (section 7.10, not run in production). The foundation seeds nothing; each part adds ONE entry to
 * `PAYMENT_SEEDERS` that calls its own function from `seeders/payments-<part>.ts` (12.3: 120 payments with receipts and the
 * 99,100 paise advance of A-1203; 12.2: two `DEPOSITED` cheques; 12.4: one `PENDING_APPROVAL` refund; 12.5: the three
 * collections). Every seeder is idempotent and returns what it created or skipped.
 */
export interface PaymentsSeedReport {
  created: string[];
  skipped: string[];
}

export const PAYMENT_SEEDERS: { name: string; run: () => Promise<PaymentsSeedReport> }[] = [
  { name: 'admin', run: seedPaymentsAdmin },
];

export async function seedPayments(): Promise<PaymentsSeedReport> {
  if (process.env.NODE_ENV === 'production') throw new Error('payments demo seed must not run in production');
  const report: PaymentsSeedReport = { created: [], skipped: [] };
  for (const s of PAYMENT_SEEDERS) {
    const r = await s.run();
    report.created.push(...r.created.map(c => `${s.name}: ${c}`));
    report.skipped.push(...r.skipped.map(c => `${s.name}: ${c}`));
  }
  return report;
}
