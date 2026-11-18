import type { Transaction } from 'sequelize';
import { ApprovalRule, SocietyMember } from '../../models';
import { formatRupees } from '../../lib/money';
import { computeAccess } from '../access-control/access-control.public';
import { roleLabel, typeMeta } from './approvals.catalogue';
import { WARN } from './approvals.constants';
import { assessRule, creationCapacity } from './approvals.match';
import { snapshotOf } from './approvals.route';
import type { ApproverMember } from './approvals.types';

const n = (v: unknown): number => Number(v);

/** One warning of 8.13 (inside a 200 or 201). */
export interface RuleWarning {
  code: string;
  message: string;
  [detail: string]: unknown;
}

export interface MemberAccess {
  userId: number;
  roleKey: string;
  permissions: string[];
}
/** Every ACTIVE member of the society with role and permissions (one pass; `computeAccess` caches). */
export async function loadMemberAccess(societyId: number): Promise<MemberAccess[]> {
  const rows = await SocietyMember.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['userId'],
  });
  const out: MemberAccess[] = [];
  for (const r of rows) {
    const a = await computeAccess(societyId, n(r.userId));
    if (a.status === 'ACTIVE' && a.roleKey)
      out.push({ userId: n(r.userId), roleKey: a.roleKey, permissions: a.permissions });
  }
  return out;
}

export const approversOf = (access: MemberAccess[], type: string): ApproverMember[] => {
  const perm = typeMeta(type)?.approvePermission;
  return perm
    ? access.filter(m => m.permissions.includes(perm)).map(m => ({ userId: m.userId, roleKey: m.roleKey }))
    : [];
};
/** BR-14-32: every ACTIVE member holding the type's request permission. */
export const requestersOf = (access: MemberAccess[], type: string) => {
  const perm = typeMeta(type)?.requestPermission;
  return perm
    ? access.filter(m => m.permissions.includes(perm)).map(m => ({ userId: m.userId, roleKey: m.roleKey }))
    : [];
};

type Cond = Pick<ApprovalRule, 'minAmountPaise' | 'maxAmountPaise' | 'categoryKeys' | 'requesterRoleKeys'>;
const subset = (inner: string[] | null, outer: string[] | null): boolean =>
  outer === null || (inner !== null && inner.every(k => outer.includes(k)));
/** `a` matches every request `b` matches. */
export function covers(a: Cond, b: Cond): boolean {
  if (n(a.minAmountPaise) > n(b.minAmountPaise)) return false;
  if (a.maxAmountPaise !== null && (b.maxAmountPaise === null || n(b.maxAmountPaise) > n(a.maxAmountPaise)))
    return false;
  return subset(b.categoryKeys, a.categoryKeys) && subset(b.requesterRoleKeys, a.requesterRoleKeys);
}

/** First live active rule that runs before `rule` and already matches everything it matches (BR-14-28). */
export function shadowWarning(rule: ApprovalRule, others: ApprovalRule[]): RuleWarning | null {
  if (!rule.isActive) return null;
  const before = others
    .filter(o => o.isActive && n(o.id) !== n(rule.id))
    .filter(
      o => n(o.priority) < n(rule.priority) || (n(o.priority) === n(rule.priority) && n(o.id) < n(rule.id)),
    )
    .sort((a, b) => n(a.priority) - n(b.priority) || n(a.id) - n(b.id));
  const hit = before.find(o => covers(o, rule));
  return hit
    ? {
        code: WARN.shadowed,
        message: `Rule '${hit.name}' (priority ${n(hit.priority)}) already matches every request this rule matches`,
        shadowedByRuleId: n(hit.id),
      }
    : null;
}

/** Amount ranges (paise, inclusive; `toPaise` null = no upper bound) that no active unconditional rule covers. */
export function coverageGaps(rules: ApprovalRule[]): { fromPaise: number; toPaise: number | null }[] {
  const base = rules
    .filter(r => r.isActive && r.categoryKeys === null && r.requesterRoleKeys === null)
    .sort((a, b) => n(a.minAmountPaise) - n(b.minAmountPaise));
  const gaps: { fromPaise: number; toPaise: number | null }[] = [];
  let cursor = 0;
  for (const r of base) {
    if (n(r.minAmountPaise) > cursor) gaps.push({ fromPaise: cursor, toPaise: n(r.minAmountPaise) - 1 });
    if (r.maxAmountPaise === null) return gaps;
    cursor = Math.max(cursor, n(r.maxAmountPaise) + 1);
  }
  gaps.push({ fromPaise: cursor, toPaise: null });
  return gaps;
}
export function coverageWarnings(type: string, rules: ApprovalRule[]): RuleWarning[] {
  const meta = typeMeta(type);
  if (!meta?.isMoney) return [];
  return coverageGaps(rules).map(g => ({
    code: WARN.coverageGap,
    message:
      g.toPaise === null
        ? `No active ${meta.label} rule covers ${formatRupees(g.fromPaise)} and above; such requests auto-approve`
        : `No active ${meta.label} rule covers ${formatRupees(g.fromPaise)} to ${formatRupees(g.toPaise)}; such requests auto-approve`,
    fromPaise: g.fromPaise,
    toPaise: g.toPaise,
  }));
}

/** BR-14-32 for one rule: requester roles (and an outside requester) for which a step cannot be satisfied. */
export function unsatisfiableWarning(rule: ApprovalRule, access: MemberAccess[]): RuleWarning | null {
  if (!rule.isActive || rule.action !== 'REQUIRE_APPROVAL' || !rule.steps.length) return null;
  const snap = snapshotOf(rule);
  const approvers = approversOf(access, rule.type);
  let requesters = requestersOf(access, rule.type);
  if (rule.requesterRoleKeys !== null) {
    const only = rule.requesterRoleKeys;
    requesters = requesters.filter(r => only.includes(r.roleKey));
  }
  let bad = assessRule(snap, approvers, requesters);
  if (rule.requesterRoleKeys !== null) bad = bad.filter(b => b !== null);
  if (!bad.length) return null;
  const roles = bad.filter((b): b is string => b !== null);
  const outside = bad.includes(null);
  const probe = roles[0] === undefined ? null : requesters.find(r => r.roleKey === roles[0]);
  const blocked = creationCapacity(snap, approvers, probe ? probe.userId : null).blockedStep;
  const step = blocked === null ? null : snap.steps[blocked - 1];
  const who = [...roles.map(roleLabel), ...(outside ? ['an outside requester'] : [])].join(', ');
  return {
    code: WARN.unsatisfiable,
    message: step
      ? `Step ${step.stepNo} (${step.name}) may have too few approvers left if ${who} raises the request (fallback included)`
      : `Some steps may have too few approvers left if ${who} raises the request (fallback included)`,
    requesterRoleKeys: roles,
    ...(outside ? { outsideRequester: true } : {}),
    ...(blocked === null ? {} : { stepNo: blocked }),
  };
}

/** Every warning for a saved `rule` (null after a delete or reset: coverage only) among the live rules of its type. */
export async function ruleWarnings(
  societyId: number,
  type: string,
  rules: ApprovalRule[] | null,
  subjects: ApprovalRule[],
  t?: Transaction,
): Promise<RuleWarning[]> {
  const live = rules ?? (await ApprovalRule.findAll({ where: { societyId, type }, transaction: t }));
  const out: RuleWarning[] = [];
  const access = subjects.length ? await loadMemberAccess(societyId) : [];
  for (const s of subjects) {
    const a = shadowWarning(s, live);
    if (a) out.push(a);
    const u = unsatisfiableWarning(s, access);
    if (u) out.push(u);
  }
  out.push(...coverageWarnings(type, live));
  return out;
}
