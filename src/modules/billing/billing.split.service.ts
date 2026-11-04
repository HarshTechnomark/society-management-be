import { Op, type Transaction } from 'sequelize';
import { BillSplitRule, BillingRuleVersion, Unit, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { AppError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, FEATURES } from './billing.constants';
import { assertScopeValues } from './billing.setup.scope';
import {
  actorId,
  assertFeatureFor,
  invalidState,
  isUniqueViolation,
  societyToday,
  splitRuleNotFound,
  staleVersion,
} from './billing.setup.shared';
import {
  checkSplitShape,
  type SplitCreateInput,
  type SplitListQuery,
  type SplitPatchInput,
  type SplitShape,
} from './billing.split.validation';

/** Bill split rules (section 5.4, 8.3): validation and storage. The exact-paise split itself is `splitPaise` in `billing.split.ts`. */
const ENTITY = 'bill_split_rule';
const nameTaken = () =>
  new AppError(409, 'SPLIT_RULE_NAME_TAKEN', 'A split rule with this name already exists');

export interface SplitRuleDto {
  id: number;
  societyId: number;
  name: string;
  description: string | null;
  basis: string;
  amountSource: string;
  fixedAmountPaise: number | null;
  scopeType: string;
  scopeValues: (number | string)[] | null;
  weights: Record<string, number> | null;
  status: string;
  createdBy: number | null;
  updatedBy: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const splitDto = (r: BillSplitRule): SplitRuleDto => ({
  id: Number(r.id),
  societyId: Number(r.societyId),
  name: r.name,
  description: r.description,
  basis: r.basis,
  amountSource: r.amountSource,
  fixedAmountPaise: num(r.fixedAmountPaise),
  scopeType: r.scopeType,
  scopeValues: r.scopeValues,
  weights: r.weights,
  status: r.status,
  createdBy: num(r.createdBy),
  updatedBy: num(r.updatedBy),
  version: Number(r.version),
  createdAt: r.createdAt!.toISOString(),
  updatedAt: r.updatedAt!.toISOString(),
});
const auditView = (r: BillSplitRule) => ({
  name: r.name,
  basis: r.basis,
  amountSource: r.amountSource,
  fixedAmountPaise: num(r.fixedAmountPaise),
  scopeType: r.scopeType,
  scopeValues: r.scopeValues,
  weights: r.weights,
  status: r.status,
});

export async function getSplitRule(
  societyId: number,
  id: number,
  t?: Transaction,
  lock = false,
): Promise<BillSplitRule> {
  const r = await BillSplitRule.findOne({
    where: { id, societyId },
    transaction: t,
    ...(lock && t ? { lock: t.LOCK.UPDATE } : {}),
  });
  if (!r) throw splitRuleNotFound();
  return r;
}

export async function listSplitRules(societyId: number, q: SplitListQuery) {
  const where: Record<string, unknown> = { societyId };
  if (q.status !== 'ALL') where.status = q.status;
  const total = await BillSplitRule.count({ where });
  const rows = await BillSplitRule.findAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(splitDto), pagination: pageMeta(q.page, q.limit, total) };
}

/** UNITS scope needs `billing.unit_overrides_and_exemptions`; CUSTOM_WEIGHT keys must be ACTIVE units of the society. */
async function assertSplitReferences(societyId: number, s: SplitShape): Promise<void> {
  if (s.scopeType === 'UNITS') await assertFeatureFor(societyId, FEATURES.unitOverrides);
  await assertScopeValues(societyId, s);
  if (s.basis === 'CUSTOM_WEIGHT' && s.weights) {
    const wanted = Object.keys(s.weights).map(Number);
    const found = await Unit.findAll({
      where: { societyId, status: 'ACTIVE', id: { [Op.in]: wanted } },
      attributes: ['id'],
    });
    const have = new Set(found.map(u => Number(u.id)));
    const unknown = wanted.filter(id => !have.has(id));
    if (unknown.length)
      throw new ValidationError([
        { field: 'weights', message: `Unknown or archived units: ${unknown.slice(0, 20).join(', ')}` },
      ]);
  }
}

export async function createSplitRule(
  ctx: Ctx,
  societyId: number,
  input: SplitCreateInput,
): Promise<SplitRuleDto> {
  await assertSplitReferences(societyId, input as SplitShape);
  try {
    return await sequelize.transaction(async t => {
      if (
        await BillSplitRule.findOne({
          where: { societyId, name: input.name },
          attributes: ['id'],
          transaction: t,
        })
      )
        throw nameTaken();
      const row = await BillSplitRule.create(
        {
          societyId,
          name: input.name,
          description: input.description ?? null,
          basis: input.basis,
          amountSource: input.amountSource,
          fixedAmountPaise: input.fixedAmountPaise ?? null,
          scopeType: input.scopeType,
          scopeValues: input.scopeType === 'ALL_UNITS' ? null : (input.scopeValues ?? null),
          weights: input.weights ?? null,
          status: 'ACTIVE',
          createdBy: actorId(ctx),
          updatedBy: actorId(ctx),
          version: 1,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.splitRuleCreated,
          entityType: ENTITY,
          entityId: row.id!,
          entityLabel: row.name,
          societyId,
          after: auditView(row),
        },
        t,
      );
      return splitDto(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function updateSplitRule(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: SplitPatchInput,
): Promise<SplitRuleDto> {
  try {
    return await sequelize.transaction(async t => {
      const r = await getSplitRule(societyId, id, t, true);
      if (r.status === 'ARCHIVED') throw invalidState('An archived split rule cannot be edited');
      if (Number(r.version) !== input.version) throw staleVersion('split rule');
      const { version: _v, ...patch } = input;
      void _v;
      const merged: SplitShape = {
        basis: patch.basis ?? r.basis,
        amountSource: patch.amountSource ?? r.amountSource,
        fixedAmountPaise:
          patch.fixedAmountPaise === undefined ? num(r.fixedAmountPaise) : patch.fixedAmountPaise,
        scopeType: patch.scopeType ?? r.scopeType,
        scopeValues: patch.scopeValues === undefined ? r.scopeValues : patch.scopeValues,
        weights: patch.weights === undefined ? r.weights : patch.weights,
      };
      // A change of basis or amount source drops what no longer applies, so the merged shape stays valid.
      if (patch.amountSource === 'RUN_INPUT' && patch.fixedAmountPaise === undefined)
        merged.fixedAmountPaise = null;
      if ((merged.basis === 'EQUAL' || merged.basis === 'AREA') && patch.weights === undefined)
        merged.weights = null;
      if (merged.scopeType === 'ALL_UNITS' && patch.scopeValues === undefined) merged.scopeValues = null;
      const errors: { field: string; message: string }[] = [];
      checkSplitShape(merged, (field, message) => errors.push({ field, message }));
      if (errors.length) throw new ValidationError(errors);
      await assertSplitReferences(societyId, merged);
      if (patch.name !== undefined && patch.name !== r.name) {
        if (
          await BillSplitRule.findOne({
            where: { societyId, name: patch.name },
            attributes: ['id'],
            transaction: t,
          })
        )
          throw nameTaken();
      }
      const before = auditView(r);
      if (patch.name !== undefined) r.name = patch.name;
      if (patch.description !== undefined) r.description = patch.description;
      r.basis = merged.basis;
      r.amountSource = merged.amountSource;
      r.fixedAmountPaise = merged.fixedAmountPaise ?? null;
      r.scopeType = merged.scopeType;
      r.scopeValues = merged.scopeType === 'ALL_UNITS' ? null : (merged.scopeValues ?? null);
      r.weights = merged.weights ?? null;
      r.version = Number(r.version) + 1;
      r.updatedBy = actorId(ctx);
      await r.save({ transaction: t });
      await audit(
        ctx,
        {
          action: AUDIT.splitRuleUpdated,
          entityType: ENTITY,
          entityId: r.id!,
          entityLabel: r.name,
          societyId,
          before,
          after: auditView(r),
        },
        t,
      );
      return splitDto(r);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

/** True when an approved version with `effectiveTo` NULL or in the future references the split rule (BR 8.3). */
export async function splitRuleInUse(
  societyId: number,
  id: number,
  today: string,
  t: Transaction,
): Promise<boolean> {
  const n = await BillingRuleVersion.count({
    where: {
      societyId,
      billSplitRuleId: id,
      status: 'APPROVED',
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: today } }],
    },
    transaction: t,
  });
  return n > 0;
}

export async function archiveSplitRule(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
): Promise<SplitRuleDto> {
  const today = await societyToday(societyId);
  return sequelize.transaction(async t => {
    const r = await getSplitRule(societyId, id, t, true);
    if (Number(r.version) !== input.version) throw staleVersion('split rule');
    if (r.status === 'ARCHIVED') throw invalidState('This split rule is already archived');
    if (await splitRuleInUse(societyId, Number(r.id), today, t))
      throw new AppError(409, 'SPLIT_RULE_IN_USE', 'A billing rule version still uses this split rule');
    const before = auditView(r);
    r.status = 'ARCHIVED';
    r.version = Number(r.version) + 1;
    r.updatedBy = actorId(ctx);
    await r.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.splitRuleArchived,
        entityType: ENTITY,
        entityId: r.id!,
        entityLabel: r.name,
        societyId,
        before,
        after: auditView(r),
        reason: input.reason,
      },
      t,
    );
    return splitDto(r);
  });
}
