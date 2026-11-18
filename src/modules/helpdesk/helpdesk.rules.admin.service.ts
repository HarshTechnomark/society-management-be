import { Op, type Transaction } from 'sequelize';
import { EscalationRule, Role, TicketCategory, User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { members } from '../access-control/access-control.public';
import {
  AUDIT,
  ENTITY,
  ERR,
  LIMITS,
  type Designation,
  type Priority,
  type RuleStatus,
  type TargetType,
  type TriggerType,
} from './helpdesk.constants';
import { ensureSeededOnce } from './helpdesk.seed';
import { societyIdOf } from './helpdesk.shared';

/** Escalation rules (spec 8.5, BR-15-64). Rule edits affect future firings only; deletes are soft (fired timeline entries keep pointing at the row). */
export interface RuleDto {
  id: number;
  name: string;
  triggerType: TriggerType;
  thresholdPercent: number | null;
  level: number;
  categoryId: number | null;
  categoryName: string | null;
  priority: Priority | null;
  targetType: TargetType;
  targetRoleKey: string | null;
  targetDesignation: Designation | null;
  targetUserId: number | null;
  targetUserName: string | null;
  notifyAssignee: boolean;
  status: RuleStatus;
  version: number;
}

const dto = (r: EscalationRule, cats: Map<number, string>, users: Map<number, string>): RuleDto => ({
  id: r.id,
  name: r.name,
  triggerType: r.triggerType,
  thresholdPercent: r.thresholdPercent,
  level: r.level,
  categoryId: r.categoryId,
  categoryName: r.categoryId ? (cats.get(r.categoryId) ?? null) : null,
  priority: r.priority,
  targetType: r.targetType,
  targetRoleKey: r.targetRoleKey,
  targetDesignation: r.targetDesignation,
  targetUserId: r.targetUserId,
  targetUserName: r.targetUserId ? (users.get(r.targetUserId) ?? null) : null,
  notifyAssignee: r.notifyAssignee,
  status: r.status,
  version: r.version,
});

async function toDtos(societyId: number, rows: EscalationRule[], t?: Transaction): Promise<RuleDto[]> {
  const catIds = [...new Set(rows.map(r => r.categoryId).filter((x): x is number => !!x))];
  const userIds = [...new Set(rows.map(r => r.targetUserId).filter((x): x is number => !!x))];
  const cats = new Map(
    (catIds.length
      ? await TicketCategory.findAll({
          where: { societyId, id: { [Op.in]: catIds } },
          attributes: ['id', 'name'],
          transaction: t,
        })
      : []
    ).map(c => [c.id, c.name]),
  );
  const users = new Map(
    (userIds.length
      ? await User.findAll({
          where: { id: { [Op.in]: userIds } },
          attributes: ['id', 'name'],
          transaction: t,
        })
      : []
    ).map(u => [u.id!, u.name as string]),
  );
  return rows.map(r => dto(r, cats, users));
}

export async function listRules(ctx: Ctx, status: RuleStatus | 'ALL'): Promise<RuleDto[]> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  const rows = await EscalationRule.findAll({
    where: { societyId, ...(status === 'ALL' ? {} : { status }) },
    order: [
      ['level', 'ASC'],
      ['triggerType', 'ASC'],
      ['thresholdPercent', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return toDtos(societyId, rows);
}

interface Draft {
  name: string;
  triggerType: TriggerType;
  thresholdPercent: number | null;
  level: number;
  categoryId: number | null;
  priority: Priority | null;
  targetType: TargetType;
  targetRoleKey: string | null;
  targetDesignation: Designation | null;
  targetUserId: number | null;
  notifyAssignee: boolean;
  status: RuleStatus;
}

const isSla = (t: TriggerType) => t === 'RESPONSE_SLA' || t === 'RESOLUTION_SLA';
const targetErr = (field: string, message: string) =>
  new UnprocessableError(ERR.escalationTargetInvalid, message, [{ field, message }]);

/** BR-15-64: the threshold belongs to SLA triggers only; exactly the target field of the target type is set. */
function checkShape(d: Draft): void {
  const errors: FieldError[] = [];
  if (isSla(d.triggerType) && d.thresholdPercent == null)
    errors.push({ field: 'thresholdPercent', message: 'Required for SLA triggers (25 to 1000)' });
  if (!isSla(d.triggerType) && d.thresholdPercent != null)
    errors.push({ field: 'thresholdPercent', message: 'Only for SLA triggers' });
  if (errors.length) throw new ValidationError(errors);
  const want: Record<TargetType, keyof Draft> = {
    ROLE: 'targetRoleKey',
    DESIGNATION: 'targetDesignation',
    MEMBER: 'targetUserId',
  };
  for (const f of ['targetRoleKey', 'targetDesignation', 'targetUserId'] as const) {
    const on = want[d.targetType] === f;
    if (on && d[f] == null)
      errors.push({ field: f, message: `Required for the target type ${d.targetType}` });
    if (!on && d[f] != null)
      errors.push({ field: f, message: `Not allowed for the target type ${d.targetType}` });
  }
  if (errors.length)
    throw new UnprocessableError(
      ERR.escalationTargetInvalid,
      'The escalation target does not match its type',
      errors,
    );
}

async function checkTarget(societyId: number, d: Draft, t: Transaction): Promise<void> {
  if (d.targetType === 'ROLE') {
    const role = await Role.findOne({
      where: { societyId, key: d.targetRoleKey!, scope: { [Op.in]: ['society', 'work'] } },
      transaction: t,
    });
    if (!role) throw targetErr('targetRoleKey', 'Unknown role for this society');
  } else if (d.targetType === 'MEMBER') {
    const rows = await members.listForSociety(societyId, {
      userIds: [d.targetUserId!],
      statuses: ['ACTIVE'],
    });
    if (!rows.length) throw targetErr('targetUserId', 'The person is not an active member');
  }
}

async function checkCategory(societyId: number, id: number | null, t: Transaction): Promise<void> {
  if (id == null) return;
  const c = await TicketCategory.findOne({ where: { id, societyId }, transaction: t });
  if (!c) throw new NotFoundError(ERR.categoryNotFound, 'Category not found');
  if (c.parentId)
    throw new UnprocessableError(ERR.categoryDepthExceeded, 'Rules point to a top-level category', [
      { field: 'categoryId', message: 'Choose a top-level category' },
    ]);
  if (c.status !== 'ACTIVE')
    throw new UnprocessableError(ERR.categoryArchived, 'The category is archived', [
      { field: 'categoryId', message: 'The category is archived' },
    ]);
}

async function checkLimit(societyId: number, t: Transaction): Promise<void> {
  const n = (
    await EscalationRule.findAll({
      where: { societyId, status: 'ACTIVE' },
      attributes: ['id'],
      transaction: t,
      lock: t.LOCK.UPDATE,
    })
  ).length;
  if (n >= LIMITS.maxActiveRules)
    throw new UnprocessableError(
      ERR.escalationRuleLimitReached,
      `At most ${LIMITS.maxActiveRules} active rules`,
    );
}

const stale = () =>
  new ConflictError(ERR.staleVersion, 'The rule was changed by someone else. Reload and try again.');
const find = async (societyId: number, id: number, t: Transaction) => {
  const r = await EscalationRule.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!r) throw new NotFoundError(ERR.escalationRuleNotFound, 'Escalation rule not found');
  return r;
};
const snapshot = (r: EscalationRule): Draft => ({
  name: r.name,
  triggerType: r.triggerType,
  thresholdPercent: r.thresholdPercent,
  level: r.level,
  categoryId: r.categoryId,
  priority: r.priority,
  targetType: r.targetType,
  targetRoleKey: r.targetRoleKey,
  targetDesignation: r.targetDesignation,
  targetUserId: r.targetUserId,
  notifyAssignee: r.notifyAssignee,
  status: r.status,
});

export type RuleCreateInput = Partial<Draft> & Pick<Draft, 'name' | 'triggerType' | 'level' | 'targetType'>;

export async function createRule(ctx: Ctx, input: RuleCreateInput): Promise<RuleDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return sequelize.transaction(async t => {
    const d: Draft = {
      name: input.name,
      triggerType: input.triggerType,
      thresholdPercent: input.thresholdPercent ?? null,
      level: input.level,
      categoryId: input.categoryId ?? null,
      priority: input.priority ?? null,
      targetType: input.targetType,
      targetRoleKey: input.targetRoleKey ?? null,
      targetDesignation: input.targetDesignation ?? null,
      targetUserId: input.targetUserId ?? null,
      notifyAssignee: input.notifyAssignee ?? false,
      status: input.status ?? 'ACTIVE',
    };
    checkShape(d);
    await checkCategory(societyId, d.categoryId, t);
    await checkTarget(societyId, d, t);
    if (d.status === 'ACTIVE') await checkLimit(societyId, t);
    const row = await EscalationRule.create(
      { societyId, ...d, createdBy: ctx.user?.id ?? null, updatedBy: ctx.user?.id ?? null },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.ruleCreated,
        entityType: ENTITY.escalationRule,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        after: snapshot(row),
      },
      t,
    );
    return (await toDtos(societyId, [row], t))[0]!;
  });
}

export async function updateRule(
  ctx: Ctx,
  id: number,
  input: Partial<Draft> & { version: number },
): Promise<RuleDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return sequelize.transaction(async t => {
    const row = await find(societyId, id, t);
    if (row.version !== input.version) throw stale();
    const before = snapshot(row);
    const d: Draft = { ...before };
    for (const k of Object.keys(before) as (keyof Draft)[]) {
      if (input[k] !== undefined) (d as unknown as Record<string, unknown>)[k] = input[k];
    }
    // a new target type replaces the other target fields unless the request sets them
    if (input.targetType && input.targetType !== before.targetType) {
      for (const f of ['targetRoleKey', 'targetDesignation', 'targetUserId'] as const)
        if (input[f] === undefined) (d as unknown as Record<string, unknown>)[f] = null;
    }
    // the threshold follows the trigger: the trigger itself never changes
    checkShape(d);
    if (d.categoryId !== row.categoryId) await checkCategory(societyId, d.categoryId, t);
    const targetChanged =
      d.targetType !== row.targetType ||
      d.targetRoleKey !== row.targetRoleKey ||
      d.targetUserId !== row.targetUserId;
    if (targetChanged) await checkTarget(societyId, d, t);
    if (d.status === 'ACTIVE' && row.status !== 'ACTIVE') await checkLimit(societyId, t);
    row.set(d);
    if (!row.changed()) return (await toDtos(societyId, [row], t))[0]!;
    row.updatedBy = ctx.user?.id ?? null;
    row.version += 1;
    await row.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.ruleUpdated,
        entityType: ENTITY.escalationRule,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        before,
        after: snapshot(row),
      },
      t,
    );
    return (await toDtos(societyId, [row], t))[0]!;
  });
}

export async function deleteRule(ctx: Ctx, id: number, version: number): Promise<void> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  await sequelize.transaction(async t => {
    const row = await find(societyId, id, t);
    if (row.version !== version) throw stale();
    const before = snapshot(row);
    row.updatedBy = ctx.user?.id ?? null;
    row.version += 1;
    await row.save({ transaction: t });
    await row.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.ruleDeleted,
        entityType: ENTITY.escalationRule,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        before,
        after: { deletedAt: now().toISOString() },
      },
      t,
    );
  });
}
