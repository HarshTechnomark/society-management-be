import { Role } from '../../models';
import { roles as roleApi } from '../access-control/access-control.public';
import { ValidationError, UnprocessableError } from '../../utils/errors';
import { type TypeMeta } from './approvals.catalogue';
import { ERR, LIMITS } from './approvals.constants';
import { slotsOf, stepCapacity } from './approvals.match';
import { approversOf, type MemberAccess } from './approvals.rules.assess';
import type { RuleStep } from './approvals.types';

/** The editable fields of a rule after merging a PATCH into the stored row (all values final). */
export interface RuleFields {
  name: string;
  description: string | null;
  priority: number;
  isActive: boolean;
  minAmountPaise: number;
  maxAmountPaise: number | null;
  categoryKeys: string[] | null;
  requesterRoleKeys: string[] | null;
  action: 'REQUIRE_APPROVAL' | 'AUTO_APPROVE';
  steps: RuleStep[];
  fallbackRoleKeys: string[];
  slaHours: number;
  reminderEveryHours: number;
  escalateAfterHours: number | null;
  escalationRoleKeys: string[];
  escalationCanApprove: boolean;
  stepUpAbovePaise: number | null;
}

const bad = (field: string, message: string) => new ValidationError([{ field, message }]);
const steps422 = (message: string, field = 'steps') =>
  new UnprocessableError(ERR.ruleSteps, message, [{ field, message }]);

/** Roles of a society by key (society scope for approvers, any scope for requester filters). */
async function societyRoles(societyId: number): Promise<Map<string, string>> {
  const rows = await Role.findAll({ where: { societyId }, attributes: ['key', 'scope'] });
  return new Map(rows.map(r => [r.key, r.scope]));
}

/**
 * BR-14-28 and 8.13: everything a rule must satisfy beyond the shapes Zod checks. Order: field rules (400), amount range,
 * steps, roles, named users, satisfiability (422).
 */
export async function validateRule(
  societyId: number,
  meta: TypeMeta,
  r: RuleFields,
  access: MemberAccess[],
): Promise<void> {
  if (r.escalateAfterHours !== null && r.escalateAfterHours < r.slaHours)
    throw bad('escalateAfterHours', 'Must be at least slaHours');
  if (r.stepUpAbovePaise !== null && !meta.isMoney)
    throw bad('stepUpAbovePaise', 'Only money types have a step-up amount');
  if (r.maxAmountPaise !== null && r.maxAmountPaise < r.minAmountPaise)
    throw new UnprocessableError(ERR.ruleAmountRange, 'The upper amount is below the lower amount', [
      { field: 'maxAmountPaise', message: 'Must be at least minAmountPaise' },
    ]);

  // ---- steps (RULE_STEPS_INVALID)
  if (r.action === 'AUTO_APPROVE') {
    if (r.steps.length) throw steps422('An automatic approval rule has no steps');
  } else {
    if (r.steps.length < 1 || r.steps.length > LIMITS.maxSteps)
      throw steps422(`An approval rule needs 1 to ${LIMITS.maxSteps} steps`);
    r.steps.forEach((s, i) => {
      const f = `steps[${i}]`;
      if (s.stepNo !== i + 1) throw steps422('Steps must be numbered 1, 2, 3 in order', `${f}.stepNo`);
      const slots = s.roleKeys.length + s.userIds.length;
      if (slots < 1) throw steps422('A step needs at least one role or member', f);
      if (slots > LIMITS.maxSlotsPerStep)
        throw steps422(`At most ${LIMITS.maxSlotsPerStep} roles and members`, f);
      if (s.mode === 'ALL_OF' && slots > LIMITS.maxAllOfSlots)
        throw steps422(`All-of steps take at most ${LIMITS.maxAllOfSlots} roles and members`, f);
      if (s.mode === 'N_OF') {
        if (s.requiredCount === null || s.requiredCount < 2 || s.requiredCount > 10)
          throw steps422('N-of steps need a required count of 2 to 10', `${f}.requiredCount`);
      } else if (s.requiredCount !== null)
        throw steps422('Only N-of steps take a required count', `${f}.requiredCount`);
    });
  }

  // ---- roles exist (society scope for approvers and escalation, any scope for requester filters)
  const known = await societyRoles(societyId);
  const society = (k: string) => known.get(k) === 'society';
  const unknown = (field: string, keys: string[], ok: (k: string) => boolean) => {
    const missing = keys.filter(k => !ok(k));
    if (missing.length)
      throw new UnprocessableError(ERR.stepRoleUnknown, `Unknown role: ${missing.join(', ')}`, [
        { field, message: 'Not a role of this society', roleKeys: missing },
      ]);
  };
  r.steps.forEach((s, i) => unknown(`steps[${i}].roleKeys`, s.roleKeys, society));
  unknown('fallbackRoleKeys', r.fallbackRoleKeys, society);
  unknown('escalationRoleKeys', r.escalationRoleKeys, society);
  unknown('requesterRoleKeys', r.requesterRoleKeys ?? [], k => known.has(k));

  // ---- roles hold the approve permission; named members are ACTIVE and hold it
  const perm = meta.approvePermission;
  const permCache = new Map<string, boolean>();
  for (const [i, s] of r.steps.entries()) {
    for (const k of s.roleKeys) {
      if (!permCache.has(k)) permCache.set(k, (await roleApi.getPermissionKeys(societyId, k)).includes(perm));
      if (!permCache.get(k))
        throw new UnprocessableError(
          ERR.stepRoleLacksPermission,
          `Role ${k} cannot approve ${meta.label} requests`,
          [{ field: `steps[${i}].roleKeys`, message: `Lacks ${perm}`, roleKey: k }],
        );
    }
    for (const u of s.userIds) {
      const m = access.find(a => a.userId === u);
      if (!m || !m.permissions.includes(perm))
        throw new UnprocessableError(ERR.stepUserNotEligible, 'A named member cannot approve this type', [
          {
            field: `steps[${i}].userIds`,
            message: 'Not an active member with approve permission',
            userId: u,
          },
        ]);
    }
  }

  // ---- N-of count above the people who can fill the pool today (before any exclusion)
  const approvers = approversOf(access, meta.type);
  for (const [i, s] of r.steps.entries()) {
    if (s.mode !== 'N_OF') continue;
    const c = stepCapacity(s, slotsOf(s), approvers, new Set(), r.fallbackRoleKeys);
    if (!c.ok)
      throw new UnprocessableError(
        ERR.stepCannotBeSatisfied,
        `Step ${s.stepNo} needs ${s.requiredCount} approvals but too few members can fill it`,
        [{ field: `steps[${i}].requiredCount`, message: 'Larger than the people who can approve' }],
      );
  }
}
