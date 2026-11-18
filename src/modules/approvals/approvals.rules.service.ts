import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { ApprovalRule, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { APPROVAL_TYPES, typeMeta } from './approvals.catalogue';
import { AUDIT, ENTITY, ERR, LIMITS } from './approvals.constants';
import { loadMemberAccess, ruleWarnings, type RuleWarning } from './approvals.rules.assess';
import { defaultRuleRows, seedDefaultRules } from './approvals.rules.seed';
import { validateRule, type RuleFields } from './approvals.rules.validate';
import { ruleView, ruleViews, type RuleView } from './approvals.rules.view';
import { requireSociety } from './approvals.shared';

const n = (v: unknown): number => Number(v);
const notFound = () => new NotFoundError(ERR.ruleNotFound, 'Approval rule not found');
const stale = () =>
  new ConflictError(ERR.stale, 'This rule was changed by someone else. Reload and try again.');
const nameTaken = () =>
  new ConflictError(ERR.ruleNameTaken, 'Another rule of this type already has this name');

const fieldsOf = (r: ApprovalRule): RuleFields => ({
  name: r.name,
  description: r.description,
  priority: n(r.priority),
  isActive: Boolean(r.isActive),
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
});

const lowerName = (s: string) => s.trim().toLowerCase();
const liveOfType = (societyId: number, type: string, t: Transaction) =>
  ApprovalRule.findAll({
    where: { societyId, type },
    order: [['id', 'ASC']],
    lock: t.LOCK.UPDATE,
    transaction: t,
  });

// ------------------------------------------------------------------ reads (8.12)
export async function listRules(
  ctx: Ctx,
  q: { type?: string; includeInactive: boolean },
): Promise<RuleView[]> {
  const societyId = requireSociety(ctx);
  await sequelize.transaction(async t => {
    if (q.type) await seedDefaultRules(ctx, societyId, q.type, t);
    else {
      const have = new Set(
        (
          await ApprovalRule.findAll({
            where: { societyId },
            attributes: ['type'],
            group: ['type'],
            paranoid: false,
            transaction: t,
          })
        ).map(r => r.type),
      );
      for (const type of APPROVAL_TYPES) if (!have.has(type)) await seedDefaultRules(ctx, societyId, type, t);
    }
  });
  const rows = await ApprovalRule.findAll({
    where: {
      societyId,
      ...(q.type ? { type: q.type } : {}),
      ...(q.includeInactive ? {} : { isActive: true }),
    },
    order: [
      ['type', 'ASC'],
      ['priority', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return ruleViews(societyId, rows);
}

export async function getRule(societyId: number, id: number): Promise<RuleView> {
  const row = await ApprovalRule.findOne({ where: { id, societyId } });
  if (!row) throw notFound();
  return (await ruleViews(societyId, [row]))[0]!;
}

// ------------------------------------------------------------------ create (8.13)
type CreateBody = {
  type: string;
  name: string;
  priority: number;
  action: 'REQUIRE_APPROVAL' | 'AUTO_APPROVE';
  steps: RuleFields['steps'];
} & Partial<Omit<RuleFields, 'name' | 'priority' | 'action' | 'steps'>>;

export async function createRule(
  ctx: Ctx,
  body: CreateBody,
): Promise<RuleView & { warnings: RuleWarning[] }> {
  const societyId = requireSociety(ctx);
  const meta = typeMeta(body.type)!;
  const fields: RuleFields = {
    name: body.name,
    description: body.description ?? null,
    priority: body.priority,
    isActive: body.isActive ?? true,
    minAmountPaise: body.minAmountPaise ?? 0,
    maxAmountPaise: body.maxAmountPaise ?? null,
    categoryKeys: body.categoryKeys ?? null,
    requesterRoleKeys: body.requesterRoleKeys ?? null,
    action: body.action,
    steps: body.steps,
    fallbackRoleKeys: body.fallbackRoleKeys ?? ['chairman'],
    slaHours: body.slaHours ?? 48,
    reminderEveryHours: body.reminderEveryHours ?? 24,
    escalateAfterHours: body.escalateAfterHours === undefined ? 72 : body.escalateAfterHours,
    escalationRoleKeys: body.escalationRoleKeys ?? ['chairman'],
    escalationCanApprove: body.escalationCanApprove ?? false,
    stepUpAbovePaise: body.stepUpAbovePaise ?? null,
  };
  const access = await loadMemberAccess(societyId);
  await validateRule(societyId, meta, fields, access);
  try {
    return await sequelize.transaction(async t => {
      const live = await liveOfType(societyId, body.type, t);
      if (live.length >= LIMITS.maxLiveRulesPerType)
        throw new UnprocessableError(
          ERR.ruleLimit,
          `A type can have at most ${LIMITS.maxLiveRulesPerType} rules`,
        );
      if (live.some(r => lowerName(r.name) === lowerName(fields.name))) throw nameTaken();
      const row = await ApprovalRule.create(
        {
          societyId,
          type: body.type,
          isDefault: false,
          ...fields,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.ruleCreated,
          entityType: ENTITY.rule,
          entityId: n(row.id),
          entityLabel: row.name,
          societyId,
          after: ruleView(row),
        },
        t,
      );
      const warnings = await ruleWarnings(societyId, body.type, [...live, row], [row], t);
      return { ...ruleView(row), warnings };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw nameTaken();
    throw err;
  }
}

// ------------------------------------------------------------------ edit (8.13)
export type PatchBody = Partial<RuleFields> & { version: number };

export async function updateRule(
  ctx: Ctx,
  id: number,
  body: PatchBody,
): Promise<RuleView & { warnings: RuleWarning[] }> {
  const societyId = requireSociety(ctx);
  const access = await loadMemberAccess(societyId);
  try {
    return await sequelize.transaction(async t => {
      const row = await ApprovalRule.findOne({
        where: { id, societyId },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });
      if (!row) throw notFound();
      if (n(row.version) !== body.version) throw stale();
      const { version: _v, ...changes } = body;
      void _v;
      const merged: RuleFields = { ...fieldsOf(row) };
      for (const [k, v] of Object.entries(changes))
        if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
      if (changes.action === 'AUTO_APPROVE' && changes.steps === undefined) merged.steps = [];
      await validateRule(societyId, typeMeta(row.type)!, merged, access);
      const live = await liveOfType(societyId, row.type, t);
      if (live.some(r => n(r.id) !== id && lowerName(r.name) === lowerName(merged.name))) throw nameTaken();
      const before = ruleView(row);
      await row.update(
        { ...merged, version: n(row.version) + 1, updatedBy: ctx.user?.id ?? null },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.ruleUpdated,
          entityType: ENTITY.rule,
          entityId: id,
          entityLabel: row.name,
          societyId,
          before,
          after: ruleView(row),
        },
        t,
      );
      const warnings = await ruleWarnings(societyId, row.type, live, [row], t);
      return { ...(await ruleViews(societyId, [row]))[0]!, warnings };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw nameTaken();
    throw err;
  }
}

// ------------------------------------------------------------------ delete (8.14)
export async function deleteRule(
  ctx: Ctx,
  id: number,
  body: { version: number; reason: string },
): Promise<{ id: number; warnings: RuleWarning[] }> {
  const societyId = requireSociety(ctx);
  return sequelize.transaction(async t => {
    const row = await ApprovalRule.findOne({ where: { id, societyId }, lock: t.LOCK.UPDATE, transaction: t });
    if (!row) throw notFound();
    if (n(row.version) !== body.version) throw stale();
    const before = ruleView(row);
    await row.update({ version: n(row.version) + 1, updatedBy: ctx.user?.id ?? null }, { transaction: t });
    await row.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.ruleDeleted,
        entityType: ENTITY.rule,
        entityId: id,
        entityLabel: row.name,
        societyId,
        before,
        reason: body.reason,
      },
      t,
    );
    const rest = await ApprovalRule.findAll({ where: { societyId, type: row.type }, transaction: t });
    return { id, warnings: await ruleWarnings(societyId, row.type, rest, [], t) };
  });
}

// ------------------------------------------------------------------ reset (8.15)
export async function resetDefaults(
  ctx: Ctx,
  body: { type: string; reason: string },
): Promise<{ rules: RuleView[]; warnings: RuleWarning[] }> {
  const societyId = requireSociety(ctx);
  return sequelize.transaction(async t => {
    const live = await liveOfType(societyId, body.type, t);
    const before = live.map(r => ({ id: n(r.id), name: r.name, version: n(r.version) }));
    if (live.length)
      await ApprovalRule.destroy({ where: { id: { [Op.in]: live.map(r => n(r.id)) } }, transaction: t });
    const rows = defaultRuleRows(societyId, body.type);
    if (rows.length)
      await ApprovalRule.bulkCreate(
        rows.map(r => ({ ...r, createdBy: ctx.user?.id ?? null, updatedBy: ctx.user?.id ?? null })),
        { transaction: t },
      );
    const fresh = await ApprovalRule.findAll({
      where: { societyId, type: body.type },
      order: [
        ['priority', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction: t,
    });
    await audit(
      ctx,
      {
        action: AUDIT.ruleReset,
        entityType: ENTITY.rule,
        entityId: body.type,
        societyId,
        before: { rules: before },
        after: { type: body.type, count: fresh.length },
        reason: body.reason,
      },
      t,
    );
    const warnings = await ruleWarnings(societyId, body.type, fresh, fresh, t);
    return { rules: await ruleViews(societyId, fresh), warnings };
  });
}
