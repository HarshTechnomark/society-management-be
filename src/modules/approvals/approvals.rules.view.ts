import { ApprovalRequest, type ApprovalRule } from '../../models';
import { Op, fn, col } from 'sequelize';
import { OPEN_STATUSES } from './approvals.constants';

const n = (v: unknown): number => Number(v);

/** The 8.12 shape of a rule. */
export function ruleView(r: ApprovalRule, openRequests = 0) {
  return {
    id: n(r.id),
    type: r.type,
    name: r.name,
    description: r.description,
    priority: n(r.priority),
    isActive: Boolean(r.isActive),
    isDefault: Boolean(r.isDefault),
    minAmountPaise: n(r.minAmountPaise),
    maxAmountPaise: r.maxAmountPaise === null ? null : n(r.maxAmountPaise),
    categoryKeys: r.categoryKeys,
    requesterRoleKeys: r.requesterRoleKeys,
    action: r.action,
    steps: r.steps,
    fallbackRoleKeys: r.fallbackRoleKeys,
    slaHours: n(r.slaHours),
    reminderEveryHours: n(r.reminderEveryHours),
    escalateAfterHours: r.escalateAfterHours === null ? null : n(r.escalateAfterHours),
    escalationRoleKeys: r.escalationRoleKeys,
    escalationCanApprove: Boolean(r.escalationCanApprove),
    stepUpAbovePaise: r.stepUpAbovePaise === null ? null : n(r.stepUpAbovePaise),
    openRequests,
    version: n(r.version),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}
export type RuleView = ReturnType<typeof ruleView>;

/** Open requests (PENDING or CHANGES_REQUESTED) routed by each rule id. */
export async function openCounts(societyId: number, ruleIds: number[]): Promise<Map<number, number>> {
  if (!ruleIds.length) return new Map();
  const rows = (await ApprovalRequest.findAll({
    attributes: ['ruleId', [fn('COUNT', col('id')), 'c']],
    where: { societyId, ruleId: { [Op.in]: ruleIds }, status: { [Op.in]: [...OPEN_STATUSES] } },
    group: ['ruleId'],
    raw: true,
  })) as unknown as { ruleId: number; c: number | string }[];
  return new Map(rows.map(r => [n(r.ruleId), n(r.c)]));
}

export async function ruleViews(societyId: number, rows: ApprovalRule[]): Promise<RuleView[]> {
  const counts = await openCounts(
    societyId,
    rows.map(r => n(r.id)),
  );
  return rows.map(r => ruleView(r, counts.get(n(r.id)) ?? 0));
}
