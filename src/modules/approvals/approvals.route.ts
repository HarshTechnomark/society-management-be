import type { Transaction } from 'sequelize';
import { addHours } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { freshStepName, type TypeMeta } from './approvals.catalogue';
import {
  DEFAULT_BULK_BELOW_PAISE,
  DEFAULT_STEP_UP_ABOVE_PAISE,
  SETTING,
  type Routing,
} from './approvals.constants';
import { matchRule } from './approvals.match';
import { loadLiveRules, seedDefaultRules } from './approvals.rules.seed';
import type { ApproverMember, RuleSnapshot } from './approvals.types';
import { creationCapacity } from './approvals.match';
import { loadApprovers } from './approvals.shared';

/** BR-14-3 to BR-14-6 and BR-14-13: what a rule match decides for one (re)submission. */
export interface Routed {
  routing: Routing;
  ruleId: number | null;
  ruleVersion: number | null;
  snapshot: RuleSnapshot | null;
  totalSteps: number;
  stepUpRequired: boolean;
  stepUpAbovePaise: number | null;
  allowBulk: boolean;
  /** STEPS routing only: can every step still be completed (BR-14-11 a)? */
  routable: boolean;
}

export async function routeRequest(
  ctx: Ctx,
  societyId: number,
  meta: TypeMeta,
  q: {
    amountPaise: number;
    categoryKey: string | null;
    requesterRoleKey: string | null;
    requesterUserId: number | null;
  },
  t: Transaction,
  members?: ApproverMember[],
): Promise<Routed> {
  await seedDefaultRules(ctx, societyId, meta.type, t);
  const rules = await loadLiveRules(societyId, meta.type, t);
  const hit = matchRule(rules, q);
  const none = (routing: Routing, rule: (typeof rules)[number] | null): Routed => ({
    routing,
    ruleId: rule?.id ?? null,
    ruleVersion: rule ? Number(rule.row.version) : null,
    snapshot: rule ? snapshotOf(rule.row) : null,
    totalSteps: 0,
    stepUpRequired: false,
    stepUpAbovePaise: null,
    allowBulk: false,
    routable: true,
  });
  if (!hit) return none('AUTO_NO_RULE', null);
  if (hit.row.action === 'AUTO_APPROVE') return none('AUTO_RULE', hit);
  const snapshot = snapshotOf(hit.row);
  const threshold =
    snapshot.stepUpAbovePaise ??
    (await readSetting(societyId, SETTING.stepUpAbovePaise, DEFAULT_STEP_UP_ABOVE_PAISE));
  const bulkBelow = await readSetting(societyId, SETTING.bulkApproveBelowPaise, DEFAULT_BULK_BELOW_PAISE);
  const stepUpRequired = meta.alwaysStepUp || (meta.isMoney && q.amountPaise >= threshold);
  const approvers = members ?? (await loadApprovers(societyId, meta.type));
  const cap = creationCapacity(snapshot, approvers, q.requesterUserId);
  return {
    routing: 'STEPS',
    ruleId: hit.id,
    ruleVersion: Number(hit.row.version),
    snapshot,
    totalSteps: snapshot.steps.length,
    stepUpRequired,
    stepUpAbovePaise: meta.isMoney ? threshold : null,
    allowBulk: meta.allowBulk && !stepUpRequired && q.amountPaise < bulkBelow,
    routable: cap.ok,
  };
}

async function readSetting(societyId: number, key: string, fallback: number): Promise<number> {
  try {
    return Number(await settings.get(societyId, key)) || fallback;
  } catch {
    return fallback;
  }
}

export function snapshotOf(r: {
  id: number;
  version: number;
  name: string;
  action: 'REQUIRE_APPROVAL' | 'AUTO_APPROVE';
  minAmountPaise: number;
  maxAmountPaise: number | null;
  categoryKeys: string[] | null;
  requesterRoleKeys: string[] | null;
  steps: RuleSnapshot['steps'];
  fallbackRoleKeys: string[];
  slaHours: number;
  reminderEveryHours: number;
  escalateAfterHours: number | null;
  escalationRoleKeys: string[];
  escalationCanApprove: boolean;
  stepUpAbovePaise: number | null;
}): RuleSnapshot {
  return {
    ruleId: Number(r.id),
    ruleVersion: Number(r.version),
    name: r.name,
    action: r.action,
    minAmountPaise: Number(r.minAmountPaise),
    maxAmountPaise: r.maxAmountPaise === null ? null : Number(r.maxAmountPaise),
    categoryKeys: r.categoryKeys,
    requesterRoleKeys: r.requesterRoleKeys,
    steps: r.steps.map(st => ({ ...st, name: freshStepName(st) })),
    fallbackRoleKeys: r.fallbackRoleKeys,
    slaHours: Number(r.slaHours),
    reminderEveryHours: Number(r.reminderEveryHours),
    escalateAfterHours: r.escalateAfterHours === null ? null : Number(r.escalateAfterHours),
    escalationRoleKeys: r.escalationRoleKeys,
    escalationCanApprove: Boolean(r.escalationCanApprove),
    stepUpAbovePaise: r.stepUpAbovePaise === null ? null : Number(r.stepUpAbovePaise),
  };
}

/** BR-14-19: the SLA columns of a step that starts at `at`. */
export function stepStartFields(snap: RuleSnapshot | null, at: Date) {
  if (!snap)
    return {
      stepStartedAt: null,
      dueAt: null,
      nextReminderAt: null,
      reminderCount: 0,
      escalateAt: null,
      escalatedAt: null,
    };
  const due = addHours(at, snap.slaHours);
  return {
    stepStartedAt: at,
    dueAt: due,
    nextReminderAt: due,
    reminderCount: 0,
    escalateAt: snap.escalateAfterHours === null ? null : addHours(at, snap.escalateAfterHours),
    escalatedAt: null,
  };
}
