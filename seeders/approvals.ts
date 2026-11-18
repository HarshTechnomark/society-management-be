import { Op } from 'sequelize';
import { Society, sequelize } from '../src/models';
import { DEFAULT_RULES } from '../src/modules/approvals/approvals.catalogue';
import { seedDefaultRules } from '../src/modules/approvals/approvals.rules.seed';
import { systemCtx } from '../src/types/context';

export interface ApprovalsSeedReport {
  /** `slug: n rules` per society that got rules. */
  created: string[];
  skipped: number;
}

/**
 * Module 14 section 7.5: the default approval rules of every type, for every society that is not deleted (BR-14-6). Idempotent:
 * a society that already has any rule row of a type (deleted ones count) keeps its own rules, so a second run inserts nothing.
 * The engine would also seed a type lazily on its first request; seeding up front makes the rules page complete from day one.
 */
export async function seedApprovalRules(): Promise<ApprovalsSeedReport> {
  const report: ApprovalsSeedReport = { created: [], skipped: 0 };
  const societies = await Society.findAll({
    where: { status: { [Op.ne]: 'DELETED' } },
    order: [['id', 'ASC']],
  });
  for (const s of societies) {
    const ctx = {
      ...systemCtx('seed-approvals'),
      society: { id: s.id!, name: s.name, status: s.status, timezone: s.timezone, planKey: '' },
    };
    let n = 0;
    for (const type of Object.keys(DEFAULT_RULES))
      n += await sequelize.transaction(t => seedDefaultRules(ctx, s.id!, type, t));
    if (n) report.created.push(`${s.slug}: ${n} rules`);
    else report.skipped++;
  }
  return report;
}
