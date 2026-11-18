import { ApprovalRule, Society } from '../../models';
import { Op } from 'sequelize';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { addHours, now } from '../../lib/clock';
import { enqueue, registerProcessor, registerRepeatable, type JobData } from '../../lib/queue';
import { societyLifecycle } from '../societies/societies.public';
import { typeMeta } from './approvals.catalogue';
import { APPROVALS_QUEUE, JOB, NOTIFY } from './approvals.constants';
import { adminAudience, sendTo } from './approvals.notify';
import { loadMemberAccess, unsatisfiableWarning } from './approvals.rules.assess';

const DEDUPE_SECONDS = 7 * 86_400;
const localDate = (): string => addHours(now(), 5.5).toISOString().slice(0, 10);

export interface RuleHealthFinding {
  ruleId: number;
  ruleName: string;
  type: string;
  message: string;
  requesterRoleKeys: string[];
}

/** BR-14-32: `assessRule` on every active rule of one society; each finding is logged and sent once per rule per 7 days. */
export async function runRuleHealth(societyId: number): Promise<RuleHealthFinding[]> {
  const rules = await ApprovalRule.findAll({
    where: { societyId, isActive: true, action: 'REQUIRE_APPROVAL' },
    order: [['id', 'ASC']],
  });
  if (!rules.length) return [];
  const access = await loadMemberAccess(societyId);
  const findings: RuleHealthFinding[] = [];
  let audience: number[] | null = null;
  for (const rule of rules) {
    const w = unsatisfiableWarning(rule, access);
    if (!w) continue;
    const f: RuleHealthFinding = {
      ruleId: Number(rule.id),
      ruleName: rule.name,
      type: rule.type,
      message: w.message,
      requesterRoleKeys: (w.requesterRoleKeys as string[]) ?? [],
    };
    findings.push(f);
    logger.warn({ societyId, ...f }, 'approval rule may be unsatisfiable');
    const first = await kv().setIfAbsent(`approvals:rule-health:${f.ruleId}`, '1', DEDUPE_SECONDS);
    if (!first) continue;
    audience ??= await adminAudience(societyId);
    await sendTo(NOTIFY.ruleHealth, audience, {
      title: f.ruleName,
      typeLabel: typeMeta(f.type)?.label ?? f.type,
      ruleId: f.ruleId,
      message: f.message,
      requesterRoleKeys: f.requesterRoleKeys,
    });
  }
  return findings;
}

/** Processor of `approvals:rule-health` (9.1): one society when `societyId` is given, else every society that allows `support` jobs. */
export async function ruleHealthJob(data: JobData): Promise<void> {
  const only = data.societyId === undefined ? null : Number(data.societyId);
  const rows = await Society.findAll({
    where: only === null ? { id: { [Op.gt]: 0 } } : { id: only },
    attributes: ['id', 'status'],
    order: [['id', 'ASC']],
  });
  for (const s of rows) {
    if (!societyLifecycle.isJobAllowed(s.status, 'support')) continue;
    try {
      await runRuleHealth(Number(s.id));
    } catch (err) {
      logger.error({ err, societyId: Number(s.id) }, 'approvals rule-health failed');
    }
  }
}

/** One run for a society per local day (`jobId = rule-health:<societyId>:<localDate>`). */
export const enqueueRuleHealth = (societyId: number): Promise<unknown> =>
  enqueue(
    APPROVALS_QUEUE,
    JOB.ruleHealth,
    { societyId },
    { jobId: `rule-health:${societyId}:${localDate()}` },
  );

/** Called from `registerApprovalJobs()`: the processor and the daily 03:30 sweep over every society. */
export function registerRuleHealthJob(): void {
  registerProcessor(APPROVALS_QUEUE, JOB.ruleHealth, d => ruleHealthJob(d));
  registerRepeatable(APPROVALS_QUEUE, JOB.ruleHealth, { dailyAtIst: '03:30' });
}
