import { BillingRule, ChargeHead, Society } from '../src/models';
import { chargeHeads } from '../src/modules/billing/billing.public';
import { createRule } from '../src/modules/billing/billing.rules.service';
import type { RuleCreateInput } from '../src/modules/billing/billing.rules.validation';
import { systemCtx } from '../src/types/context';

/**
 * Module 11.1 demo seed (section 7.13), not run in production. The 30 charge heads for every demo society
 * (`chargeHeads.ensureSeeded`, idempotent by key). Demo rules (setup mode, so they are approved at once and the first late fee
 * policy comes from the module 08 defaults): Sky Heights CHS and Green Park CHS get MAINTENANCE per sq ft 320 paise,
 * SINKING_FUND 60,000 paise and WATER 35,000 paise per flat per month (the prototype's 3.2, 600 and 350 rupees) from 1 April 2026.
 * Tulip Gardens CHS gets heads only. The run of Sky Heights belongs to 11.3. Idempotent by rule name.
 */
const RULES: { head: string; name: string; version: RuleCreateInput['firstVersion'] }[] = [
  {
    head: 'MAINTENANCE',
    name: 'Maintenance – all flats',
    version: {
      rateType: 'PER_SQFT',
      ratePerSqftPaise: 320,
      effectiveFrom: '2026-04-01',
      reason: 'Demo data: AGM rate',
    },
  },
  {
    head: 'SINKING_FUND',
    name: 'Sinking fund – all flats',
    version: {
      rateType: 'FLAT_PER_UNIT',
      amountPaise: 60_000,
      effectiveFrom: '2026-04-01',
      reason: 'Demo data: AGM rate',
    },
  },
  {
    head: 'WATER',
    name: 'Water – all flats',
    version: {
      rateType: 'FLAT_PER_UNIT',
      amountPaise: 35_000,
      effectiveFrom: '2026-04-01',
      reason: 'Demo data: AGM rate',
    },
  },
];
const WITH_RULES = ['sky-heights', 'green-park'];

export interface BillingSetupSeedReport {
  heads: string[];
  rules: string[];
  skipped: string[];
}

export async function seedBillingSetup(): Promise<BillingSetupSeedReport> {
  if (process.env.NODE_ENV === 'production') throw new Error('billing demo seed must not run in production');
  const report: BillingSetupSeedReport = { heads: [], rules: [], skipped: [] };
  const ctx = systemCtx('seed');
  for (const slug of ['sky-heights', 'green-park', 'tulip-gardens']) {
    const society = await Society.findOne({ where: { slug } });
    if (!society) continue;
    const societyId = society.id!;
    const { created } = await chargeHeads.ensureSeeded(societyId);
    if (created) report.heads.push(`${slug} (${created})`);
    if (!WITH_RULES.includes(slug)) continue;
    for (const r of RULES) {
      const head = await ChargeHead.findOne({ where: { societyId, key: r.head } });
      if (!head) continue;
      if (await BillingRule.count({ where: { societyId, chargeHeadId: head.id!, name: r.name } })) {
        report.skipped.push(`${slug}: ${r.name}`);
        continue;
      }
      await createRule(ctx, societyId, {
        chargeHeadId: head.id!,
        name: r.name,
        scopeType: 'ALL_UNITS',
        firstVersion: r.version,
      });
      report.rules.push(`${slug}: ${r.name}`);
    }
  }
  return report;
}
