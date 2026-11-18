import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { ApprovalRule } from '../../models';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { DEFAULT_RULES } from './approvals.catalogue';
import { AUDIT, ENTITY } from './approvals.constants';
import type { MatchableRule } from './approvals.types';

/** `INSERT` payload of one default rule (7.5): the common columns are the model defaults. */
export function defaultRuleRows(societyId: number, type: string) {
  return (DEFAULT_RULES[type] ?? []).map(d => ({
    societyId,
    type,
    name: d.name,
    description: null,
    priority: d.priority,
    isActive: true,
    isDefault: true,
    minAmountPaise: d.minAmountPaise,
    maxAmountPaise: d.maxAmountPaise,
    categoryKeys: null,
    requesterRoleKeys: null,
    action: d.action,
    steps: d.steps,
    fallbackRoleKeys: ['chairman'],
    slaHours: 48,
    reminderEveryHours: 24,
    escalateAfterHours: 72,
    escalationRoleKeys: ['chairman'],
    escalationCanApprove: false,
    stepUpAbovePaise: null,
  }));
}

/**
 * BR-14-6: the first time a society touches a type and has no rule row of that type at all (deleted ones count), insert the
 * defaults. Idempotent: `INSERT IGNORE` over the unique key (society, type, name), so two racing callers insert once.
 * Returns the number of rules inserted.
 */
export async function seedDefaultRules(
  ctx: Ctx,
  societyId: number,
  type: string,
  t: Transaction,
): Promise<number> {
  const existing = await ApprovalRule.count({ where: { societyId, type }, paranoid: false, transaction: t });
  if (existing > 0) return 0;
  const rows = defaultRuleRows(societyId, type);
  if (!rows.length) return 0;
  await ApprovalRule.bulkCreate(rows, { ignoreDuplicates: true, transaction: t });
  const created = await ApprovalRule.count({ where: { societyId, type }, paranoid: false, transaction: t });
  if (created > existing)
    await audit(
      ctx,
      {
        action: AUDIT.ruleSeeded,
        entityType: ENTITY.rule,
        entityId: `${type}`,
        societyId,
        after: { type, count: created - existing },
      },
      t,
    );
  return created - existing;
}

/** Live rules of a type in matching order, as plain shapes for `matchRule` (numbers, not strings). */
export async function loadLiveRules(
  societyId: number,
  type: string,
  t?: Transaction,
): Promise<(MatchableRule & { row: ApprovalRule })[]> {
  const rows = await ApprovalRule.findAll({
    where: { societyId, type, isActive: { [Op.eq]: true } },
    order: [
      ['priority', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction: t,
  });
  return rows.map(row => ({
    row,
    id: Number(row.id),
    priority: Number(row.priority),
    isActive: Boolean(row.isActive),
    minAmountPaise: Number(row.minAmountPaise),
    maxAmountPaise: row.maxAmountPaise === null ? null : Number(row.maxAmountPaise),
    categoryKeys: row.categoryKeys,
    requesterRoleKeys: row.requesterRoleKeys,
  }));
}
