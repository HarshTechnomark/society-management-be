import { Op, type Transaction } from 'sequelize';
import {
  Addon,
  Plan,
  PlanEntitlement,
  PlanVersion,
  Society,
  Subscription,
  SubscriptionAddon,
  sequelize,
} from '../../models';
import type { AddonGrantRow } from '../../models/addon.model';
import { now } from '../../lib/clock';
import { enqueue } from '../../lib/queue';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import type { Ctx } from '../../types/context';
import {
  FEATURES,
  FEATURE_BY_KEY,
  LIMITS,
  LIMIT_BY_KEY,
  PLAN_CODES,
  type PlanCode,
} from './subscriptions.catalogue';
import {
  SUBSCRIPTIONS_QUEUE,
  clearVersionRowsCache,
  invalidate,
  loadVersionRows,
} from './entitlements.service';
import { ALL_KEYS } from './subscriptions.seed';
import { integrations } from './subscriptions.integrations';
import { addDaysYmd, monthsOf, periodFrom } from './pricing';
import { mrrOf } from './subscriptions.service';
import {
  checkVersion,
  monthlyEquivalent,
  notifyViewers,
  periodValueOf,
  planById,
  todayOf,
  versionById,
} from './subscriptions.util';

const notDraft = () =>
  new ConflictError('PLAN_VERSION_NOT_DRAFT', 'Only a draft plan version can be changed');
const auditPlan = (
  ctx: Ctx,
  action: string,
  entityType: string,
  entityId: number,
  o: { label?: string; before?: unknown; after?: unknown; reason?: string | null },
  t: Transaction,
) =>
  audit(
    ctx,
    {
      action,
      entityType,
      entityId,
      entityLabel: o.label,
      before: o.before,
      after: o.after,
      reason: o.reason ?? null,
    },
    t,
  );

// ------------------------------------------------------------------ views
const MODULE_TOTAL = new Set(FEATURES.map(f => f.moduleNo)).size;

async function versionHighlights(versionId: number) {
  const rows = await loadVersionRows(versionId);
  const live = FEATURES.filter(f => f.catalogueStatus === 'LIVE');
  const enabled = live.filter(f => rows.features[f.key]);
  return {
    featureCount: enabled.length,
    moduleCount: new Set(enabled.filter(f => !f.isAlwaysOn).map(f => f.moduleNo)).size,
    moduleTotal: MODULE_TOTAL,
    limits: Object.fromEntries(
      LIMITS.map(l => [
        l.key,
        { value: rows.limits[l.key]?.value ?? null, perFlats: rows.limits[l.key]?.perFlats ?? null },
      ]),
    ),
  };
}

const versionSummary = (v: PlanVersion) => ({
  id: v.id!,
  versionNo: v.versionNo,
  status: v.status,
  pricePerFlatPaise: Number(v.pricePerFlatPaise),
  minBillableFlats: v.minBillableFlats,
  annualFreeMonths: v.annualFreeMonths,
  notes: v.notes,
  publishedAt: v.publishedAt?.toISOString() ?? null,
  retiredAt: v.retiredAt?.toISOString() ?? null,
  version: v.version,
});

async function planStats(plan: Plan) {
  const subs = await Subscription.findAll({
    where: { planId: plan.id!, status: { [Op.ne]: 'CANCELLED' } },
    include: [{ model: PlanVersion, as: 'planVersion' }],
  });
  return {
    activeSubscriptions: subs.length,
    onOlderVersions: subs.filter(s => s.planVersionId !== plan.currentVersionId).length,
    mrrPaise: subs.reduce(
      (a, s) => a + mrrOf(s, (s as unknown as { planVersion: PlanVersion }).planVersion),
      0,
    ),
  };
}

async function planView(plan: Plan) {
  const current = plan.currentVersionId ? await versionById(plan.currentVersionId) : null;
  const draft = await PlanVersion.findOne({ where: { planId: plan.id!, status: 'DRAFT' } });
  return {
    id: plan.id!,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    tierRank: plan.tierRank,
    isPublic: plan.isPublic,
    isActive: plan.isActive,
    version: plan.version,
    currentVersion: current ? versionSummary(current) : null,
    draftVersionId: draft?.id ?? null,
    ...(await planStats(plan)),
    highlights: current ? await versionHighlights(current.id!) : null,
  };
}

export async function listPlans() {
  const plans = await Plan.findAll({ order: [['tierRank', 'ASC']] });
  return Promise.all(plans.map(planView));
}

export async function getPlan(planId: number) {
  const plan = await planById(planId);
  const versions = await PlanVersion.findAll({ where: { planId }, order: [['versionNo', 'DESC']] });
  const counts = await Subscription.count({
    where: { planId, status: { [Op.ne]: 'CANCELLED' } },
    group: ['planVersionId'],
  });
  const byVersion = new Map(
    (counts as unknown as { planVersionId: number; count: number }[]).map(c => [c.planVersionId, c.count]),
  );
  return {
    ...(await planView(plan)),
    versions: versions.map(v => ({ ...versionSummary(v), subscriptions: byVersion.get(v.id!) ?? 0 })),
  };
}

export async function getVersion(versionId: number) {
  const v = await versionById(versionId);
  const plan = await planById(v.planId);
  const rows = await PlanEntitlement.findAll({ where: { planVersionId: versionId }, order: [['id', 'ASC']] });
  return {
    ...versionSummary(v),
    plan: { id: plan.id!, code: plan.code, name: plan.name },
    entitlements: rows.map(r => {
      const f = FEATURE_BY_KEY.get(r.entitlementKey);
      const l = LIMIT_BY_KEY.get(r.entitlementKey);
      return {
        entitlementKey: r.entitlementKey,
        kind: r.kind,
        title: f?.title ?? l?.title ?? r.entitlementKey,
        isEnabled: r.isEnabled === null ? null : Boolean(r.isEnabled),
        limitValue: r.limitValue === null ? null : Number(r.limitValue),
        limitPerFlats: r.limitPerFlats,
        overageUnitSize: r.overageUnitSize,
        overagePricePaise: r.overagePricePaise === null ? null : Number(r.overagePricePaise),
        moduleNo: f?.moduleNo ?? null,
        catalogueMinPlan: f ? (f.isAlwaysOn ? 'ALWAYS' : f.minPlan) : null,
        isAlwaysOn: f?.isAlwaysOn ?? false,
        catalogueStatus: f?.catalogueStatus ?? 'LIVE',
      };
    }),
  };
}

// ------------------------------------------------------------------ plan and version edits
export async function patchPlan(
  ctx: Ctx,
  planId: number,
  input: {
    name?: string;
    description?: string | null;
    isPublic?: boolean;
    isActive?: boolean;
    reason: string;
    version: number;
  },
) {
  await sequelize.transaction(async t => {
    const plan = await Plan.findByPk(planId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!plan) throw new NotFoundError('PLAN_NOT_FOUND', 'Plan not found');
    checkVersion(plan, input.version, 'plan');
    const before = {
      name: plan.name,
      description: plan.description,
      isPublic: plan.isPublic,
      isActive: plan.isActive,
    };
    for (const k of ['name', 'description', 'isPublic', 'isActive'] as const)
      if (input[k] !== undefined) (plan as unknown as Record<string, unknown>)[k] = input[k];
    plan.updatedBy = ctx.user?.id ?? null;
    plan.version += 1;
    await plan.save({ transaction: t });
    await auditPlan(
      ctx,
      'subscriptions.plan.updated',
      'plan',
      plan.id!,
      {
        label: plan.code,
        before,
        after: {
          name: plan.name,
          description: plan.description,
          isPublic: plan.isPublic,
          isActive: plan.isActive,
        },
        reason: input.reason,
      },
      t,
    );
  });
  return planView(await planById(planId));
}

export async function createDraft(ctx: Ctx, planId: number, input: { reason: string }) {
  const id = await sequelize.transaction(async t => {
    const plan = await Plan.findByPk(planId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!plan) throw new NotFoundError('PLAN_NOT_FOUND', 'Plan not found');
    const draft = await PlanVersion.findOne({ where: { planId, status: 'DRAFT' }, transaction: t });
    if (draft)
      throw new AppError(409, 'DRAFT_ALREADY_EXISTS', 'This plan already has a draft version', [
        { field: 'draftVersionId', message: String(draft.id), draftVersionId: draft.id },
      ]);
    const current = await versionById(plan.currentVersionId!, t);
    const maxNo = (await PlanVersion.max('versionNo', { where: { planId }, transaction: t })) as number;
    const v = await PlanVersion.create(
      {
        planId,
        versionNo: (maxNo ?? 0) + 1,
        status: 'DRAFT',
        pricePerFlatPaise: current.pricePerFlatPaise,
        minBillableFlats: current.minBillableFlats,
        annualFreeMonths: current.annualFreeMonths,
        notes: null,
        publishedAt: null,
        publishedBy: null,
        retiredAt: null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        version: 1,
      },
      { transaction: t },
    );
    const rows = await PlanEntitlement.findAll({ where: { planVersionId: current.id! }, transaction: t });
    const at = now();
    await PlanEntitlement.bulkCreate(
      rows.map(r => ({
        planVersionId: v.id!,
        entitlementKey: r.entitlementKey,
        kind: r.kind,
        isEnabled: r.isEnabled,
        limitValue: r.limitValue,
        limitPerFlats: r.limitPerFlats,
        overageUnitSize: r.overageUnitSize,
        overagePricePaise: r.overagePricePaise,
        createdAt: at,
        updatedAt: at,
      })),
      { transaction: t },
    );
    await auditPlan(
      ctx,
      'subscriptions.plan_version.created',
      'plan_version',
      v.id!,
      {
        label: `${plan.code} v${v.versionNo}`,
        after: { versionNo: v.versionNo, copiedFrom: current.id },
        reason: input.reason,
      },
      t,
    );
    return v.id!;
  });
  return getVersion(id);
}

async function lockDraft(
  versionId: number,
  version: number | undefined,
  t: Transaction,
): Promise<PlanVersion> {
  const v = await PlanVersion.findByPk(versionId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!v) throw new NotFoundError('PLAN_VERSION_NOT_FOUND', 'Plan version not found');
  if (v.status !== 'DRAFT') throw notDraft();
  if (version !== undefined) checkVersion(v, version, 'plan version');
  return v;
}

export async function patchVersion(
  ctx: Ctx,
  versionId: number,
  input: {
    pricePerFlatPaise?: number;
    minBillableFlats?: number;
    annualFreeMonths?: number;
    notes?: string | null;
    version: number;
  },
) {
  await sequelize.transaction(async t => {
    const v = await lockDraft(versionId, input.version, t);
    const plan = await planById(v.planId, t);
    if (input.pricePerFlatPaise !== undefined && plan.code !== 'ENTERPRISE' && input.pricePerFlatPaise < 100)
      throw new ValidationError([
        { field: 'pricePerFlatPaise', message: 'Must be 100–50000 (0 is allowed for Enterprise only)' },
      ]);
    const before = versionSummary(v);
    for (const k of ['pricePerFlatPaise', 'minBillableFlats', 'annualFreeMonths', 'notes'] as const)
      if (input[k] !== undefined) (v as unknown as Record<string, unknown>)[k] = input[k];
    v.updatedBy = ctx.user?.id ?? null;
    v.version += 1;
    await v.save({ transaction: t });
    await auditPlan(
      ctx,
      'subscriptions.plan_version.updated',
      'plan_version',
      v.id!,
      {
        label: `${plan.code} v${v.versionNo}`,
        before,
        after: versionSummary(v),
      },
      t,
    );
  });
  return getVersion(versionId);
}

export interface EntitlementItem {
  entitlementKey: string;
  isEnabled?: boolean;
  limitValue?: number | null;
  limitPerFlats?: number | null;
  overageUnitSize?: number | null;
  overagePricePaise?: number | null;
}

function checkItem(i: EntitlementItem): void {
  const f = FEATURE_BY_KEY.get(i.entitlementKey);
  const l = LIMIT_BY_KEY.get(i.entitlementKey);
  if (!f && !l)
    throw new UnprocessableError('UNKNOWN_ENTITLEMENT_KEY', `Unknown entitlement key ${i.entitlementKey}`, [
      { field: 'entitlementKey', message: i.entitlementKey },
    ]);
  const limitFields = ['limitValue', 'limitPerFlats', 'overageUnitSize', 'overagePricePaise'] as const;
  if (f) {
    if (limitFields.some(k => i[k] !== undefined) || i.isEnabled === undefined)
      throw new UnprocessableError(
        'ENTITLEMENT_KIND_MISMATCH',
        `${i.entitlementKey} is a feature: send isEnabled only`,
        [{ field: 'entitlementKey', message: i.entitlementKey }],
      );
    if (f.isAlwaysOn && !i.isEnabled)
      throw new UnprocessableError('ALWAYS_ON_FEATURE', `${i.entitlementKey} is always on`, [
        { field: 'entitlementKey', message: i.entitlementKey },
      ]);
    if (f.catalogueStatus === 'PLANNED' && i.isEnabled)
      throw new UnprocessableError('PLANNED_FEATURE', `${i.entitlementKey} is planned and not built yet`, [
        { field: 'entitlementKey', message: i.entitlementKey },
      ]);
    return;
  }
  if (i.isEnabled !== undefined || i.limitValue === undefined)
    throw new UnprocessableError(
      'ENTITLEMENT_KIND_MISMATCH',
      `${i.entitlementKey} is a limit: send limitValue`,
      [{ field: 'entitlementKey', message: i.entitlementKey }],
    );
  if (
    l!.enforcement === 'HARD' &&
    ((i.overageUnitSize ?? null) !== null || (i.overagePricePaise ?? null) !== null)
  )
    throw new UnprocessableError(
      'ENTITLEMENT_KIND_MISMATCH',
      `${i.entitlementKey} is a hard limit: no overage`,
      [{ field: 'entitlementKey', message: i.entitlementKey }],
    );
}

export async function putEntitlements(
  ctx: Ctx,
  versionId: number,
  input: { items: EntitlementItem[]; version: number },
) {
  return sequelize.transaction(async t => {
    const v = await lockDraft(versionId, input.version, t);
    for (const i of input.items) checkItem(i);
    const existing = new Map(
      (await PlanEntitlement.findAll({ where: { planVersionId: versionId }, transaction: t })).map(r => [
        r.entitlementKey,
        r,
      ]),
    );
    const changed: Record<string, unknown> = {};
    let updated = 0;
    for (const i of input.items) {
      const kind = FEATURE_BY_KEY.has(i.entitlementKey) ? 'FEATURE' : 'LIMIT';
      const values =
        kind === 'FEATURE'
          ? { isEnabled: Boolean(i.isEnabled) }
          : {
              limitValue: i.limitValue ?? null,
              ...(i.limitPerFlats !== undefined ? { limitPerFlats: i.limitPerFlats } : {}),
              ...(i.overageUnitSize !== undefined ? { overageUnitSize: i.overageUnitSize } : {}),
              ...(i.overagePricePaise !== undefined ? { overagePricePaise: i.overagePricePaise } : {}),
            };
      const row = existing.get(i.entitlementKey);
      if (row) {
        const diff = Object.entries(values).some(
          ([k, val]) =>
            JSON.stringify((row as unknown as Record<string, unknown>)[k] ?? null) !== JSON.stringify(val),
        );
        if (!diff && !(kind === 'FEATURE' && Boolean(row.isEnabled) !== Boolean(i.isEnabled))) continue;
        await row.update(values, { transaction: t });
      } else
        await PlanEntitlement.create(
          {
            planVersionId: versionId,
            entitlementKey: i.entitlementKey,
            kind,
            isEnabled: null,
            limitValue: null,
            limitPerFlats: null,
            overageUnitSize: null,
            overagePricePaise: null,
            ...values,
          },
          { transaction: t },
        );
      changed[i.entitlementKey] = values;
      updated += 1;
    }
    v.updatedBy = ctx.user?.id ?? null;
    v.version += 1;
    await v.save({ transaction: t });
    await auditPlan(
      ctx,
      'subscriptions.plan_version.entitlements_updated',
      'plan_version',
      v.id!,
      { after: changed },
      t,
    );
    clearVersionRowsCache(versionId);
    return { updated, version: v.version };
  });
}

export async function publishVersion(
  ctx: Ctx,
  versionId: number,
  input: { reason: string; version: number },
) {
  const out = await sequelize.transaction(async t => {
    const pre = await PlanVersion.findByPk(versionId, { transaction: t });
    if (!pre) throw new NotFoundError('PLAN_VERSION_NOT_FOUND', 'Plan version not found');
    const plan = await Plan.findByPk(pre.planId, { transaction: t, lock: t.LOCK.UPDATE });
    const v = await lockDraft(versionId, input.version, t);
    const rows = await PlanEntitlement.findAll({ where: { planVersionId: versionId }, transaction: t });
    const have = new Set(rows.map(r => r.entitlementKey));
    const missing = ALL_KEYS().filter(k => !have.has(k));
    if (missing.length)
      throw new UnprocessableError(
        'CATALOGUE_INCOMPLETE',
        `The draft misses ${missing.length} catalogue keys`,
        missing.slice(0, 50).map(k => ({ field: 'entitlementKey', message: k })),
      );
    const offAlwaysOn = rows.filter(r => FEATURE_BY_KEY.get(r.entitlementKey)?.isAlwaysOn && !r.isEnabled);
    if (offAlwaysOn.length)
      throw new UnprocessableError(
        'ALWAYS_ON_FEATURE',
        'Always-on features must stay enabled',
        offAlwaysOn.map(r => ({ field: 'entitlementKey', message: r.entitlementKey })),
      );
    const plannedOn = rows.filter(
      r => FEATURE_BY_KEY.get(r.entitlementKey)?.catalogueStatus === 'PLANNED' && r.isEnabled,
    );
    if (plannedOn.length)
      throw new UnprocessableError(
        'PLANNED_FEATURE',
        'Planned features cannot be enabled',
        plannedOn.map(r => ({ field: 'entitlementKey', message: r.entitlementKey })),
      );
    if (plan!.code !== 'ENTERPRISE' && Number(v.pricePerFlatPaise) < 100)
      throw new UnprocessableError('PRICE_REQUIRED', 'Set a price of at least 100 paise per flat');
    const old = plan!.currentVersionId
      ? await PlanVersion.findByPk(plan!.currentVersionId, { transaction: t })
      : null;
    if (old) {
      old.status = 'RETIRED';
      old.retiredAt = now();
      await old.save({ transaction: t });
    }
    v.status = 'PUBLISHED';
    v.publishedAt = now();
    v.publishedBy = ctx.user?.id ?? null;
    v.updatedBy = ctx.user?.id ?? null;
    v.version += 1;
    await v.save({ transaction: t });
    plan!.currentVersionId = v.id!;
    plan!.version += 1;
    await plan!.save({ transaction: t });
    await auditPlan(
      ctx,
      'subscriptions.plan_version.published',
      'plan_version',
      v.id!,
      {
        label: `${plan!.code} v${v.versionNo}`,
        before: { previousVersionId: old?.id ?? null },
        after: { status: 'PUBLISHED' },
        reason: input.reason,
      },
      t,
    );
    return { planId: plan!.id! };
  });
  const older = await Subscription.count({
    where: { planId: out.planId, status: { [Op.ne]: 'CANCELLED' }, planVersionId: { [Op.ne]: versionId } },
  });
  return { ...(await getVersion(versionId)), subscriptionsOnOlderVersions: older };
}

export async function deleteDraft(ctx: Ctx, versionId: number, version: number): Promise<void> {
  await sequelize.transaction(async t => {
    const v = await lockDraft(versionId, version, t);
    await PlanEntitlement.destroy({ where: { planVersionId: versionId }, transaction: t });
    await v.destroy({ transaction: t });
    await auditPlan(
      ctx,
      'subscriptions.plan_version.deleted',
      'plan_version',
      versionId,
      {
        before: versionSummary(v),
      },
      t,
    );
  });
  clearVersionRowsCache(versionId);
}

// ------------------------------------------------------------------ migration (8.2.9, BR-04-4)
export interface MigrationInput {
  fromVersionIds?: number[];
  noticeDays: number;
  dryRun: boolean;
  reason: string;
}
const MIGRATION_BATCH = 200;

/** First period start on or after `today + noticeDays`. */
export function migrationDate(sub: Subscription, today: string, noticeDays: number): string {
  const threshold = addDaysYmd(today, noticeDays);
  let start = addDaysYmd(sub.currentPeriodEnd!, 1);
  for (let i = 0; i < 400 && start < threshold; i++)
    start = addDaysYmd(periodFrom(start, sub.billingAnchorDay, monthsOf(sub.billingCycle)).periodEnd, 1);
  return start;
}

export async function migratePlan(ctx: Ctx, planId: number, input: MigrationInput) {
  const plan = await planById(planId);
  if (!plan.currentVersionId)
    throw new UnprocessableError('MIGRATION_NOTHING_TO_DO', 'The plan has no published version');
  const versions = await PlanVersion.findAll({ where: { planId } });
  let from = versions.filter(v => v.id !== plan.currentVersionId).map(v => v.id!);
  if (input.fromVersionIds?.length) {
    const bad = input.fromVersionIds.filter(id => !from.includes(id));
    if (bad.length)
      throw new UnprocessableError(
        'VALIDATION_FAILED',
        'Each version must be an older version of this plan',
        bad.map(id => ({ field: 'fromVersionIds', message: String(id) })),
      );
    from = input.fromVersionIds;
  }
  const subs = from.length
    ? await Subscription.findAll({
        where: { planId, planVersionId: from, status: { [Op.ne]: 'CANCELLED' } },
        include: [{ model: PlanVersion, as: 'planVersion' }],
      })
    : [];
  if (!subs.length)
    throw new UnprocessableError('MIGRATION_NOTHING_TO_DO', 'No subscription is on an older version');
  const target = await versionById(plan.currentVersionId);
  const today = todayOf(null);
  const pendingDowngrade = subs.filter(s => s.pendingChangeType === 'DOWNGRADE');
  const trials = subs.filter(s => s.status === 'TRIALING' && s.pendingChangeType !== 'DOWNGRADE');
  const active = subs.filter(s => s.status === 'ACTIVE' && s.pendingChangeType !== 'DOWNGRADE');
  const dates = active.map(s => migrationDate(s, today, input.noticeDays));
  const mrrBefore = subs.reduce(
    (a, s) => a + mrrOf(s, (s as unknown as { planVersion: PlanVersion }).planVersion),
    0,
  );
  const mrrAfter = subs.reduce(
    (a, s) =>
      a +
      (s.status === 'ACTIVE'
        ? monthlyEquivalent(periodValueOf(s, target, s.billableFlats, s.billingCycle), s.billingCycle)
        : 0),
    0,
  );
  const result = {
    status: 'DONE' as 'DONE' | 'QUEUED',
    matched: subs.length,
    scheduled: active.length,
    skippedPendingDowngrade: pendingDowngrade.length,
    trialsSwitched: trials.length,
    mrrBeforePaise: mrrBefore,
    mrrAfterPaise: mrrAfter,
    earliestChangeAt: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    societies: subs.slice(0, 50).map(s => s.societyId),
  };
  if (input.dryRun) return result;
  const ids = subs.filter(s => s.pendingChangeType !== 'DOWNGRADE').map(s => s.id!);
  await sequelize.transaction(t =>
    auditPlan(
      ctx,
      'subscriptions.plan.migration_scheduled',
      'plan',
      planId,
      {
        label: plan.code,
        after: { ...result, societies: undefined, targetVersionId: target.id, noticeDays: input.noticeDays },
        reason: input.reason,
      },
      t,
    ),
  );
  if (ids.length > MIGRATION_BATCH) {
    for (let i = 0; i < ids.length; i += MIGRATION_BATCH)
      await enqueue(SUBSCRIPTIONS_QUEUE, 'subscriptions:apply-migration', {
        subscriptionIds: ids.slice(i, i + MIGRATION_BATCH),
        targetVersionId: target.id!,
        noticeDays: input.noticeDays,
        actorUserId: ctx.user?.id ?? null,
        reason: input.reason,
      });
    return { ...result, status: 'QUEUED' as const };
  }
  await applyMigration(ctx, ids, target.id!, input.noticeDays, input.reason);
  return result;
}

/** Schedules (or for trials applies) the move to `targetVersionId`; skips rows with a pending DOWNGRADE or already pending. */
export async function applyMigration(
  ctx: Ctx,
  subscriptionIds: number[],
  targetVersionId: number,
  noticeDays: number,
  reason: string,
): Promise<number> {
  let n = 0;
  const target = await versionById(targetVersionId);
  const plan = await planById(target.planId);
  for (const id of subscriptionIds)
    await sequelize.transaction(async t => {
      const pre = await Subscription.findByPk(id, { transaction: t });
      if (!pre || pre.status === 'CANCELLED') return;
      const society = await Society.findByPk(pre.societyId, { transaction: t, lock: t.LOCK.UPDATE });
      const sub = await Subscription.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!sub || sub.status === 'CANCELLED' || sub.pendingChangeType === 'DOWNGRADE') return;
      if (sub.planVersionId === targetVersionId || sub.pendingPlanVersionId === targetVersionId) return;
      const before = { planVersionId: sub.planVersionId };
      let at: string;
      if (sub.status === 'TRIALING') {
        sub.planVersionId = targetVersionId;
        at = todayOf(society);
      } else {
        at = migrationDate(sub, todayOf(society), noticeDays);
        sub.pendingPlanVersionId = targetVersionId;
        sub.pendingChangeType = 'VERSION_MIGRATION';
        sub.pendingChangeAt = at;
        sub.pendingPostponements = 0;
      }
      sub.version += 1;
      await sub.save({ transaction: t });
      await audit(
        ctx,
        {
          action: `subscriptions.subscription.${sub.status === 'TRIALING' ? 'migrated' : 'migration_scheduled'}`,
          entityType: 'subscription',
          entityId: sub.id!,
          societyId: sub.societyId,
          before,
          after: { targetVersionId, at },
          reason,
        },
        t,
      );
      if (sub.status !== 'TRIALING')
        notifyViewers(t, sub.societyId, 'subscription.price_migration_notice', {
          planName: plan.name,
          effectiveDate: at,
        });
      invalidate(sub.societyId, t);
      n += 1;
    });
  return n;
}

// ------------------------------------------------------------------ catalogue (8.2.10)
export function catalogue(q: {
  moduleNo?: number;
  kind?: 'FEATURE' | 'LIMIT';
  minPlan?: PlanCode | 'ALWAYS';
  q?: string;
  status?: 'LIVE' | 'PLANNED';
}) {
  const text = q.q?.toLowerCase();
  const features = FEATURES.map(f => ({
    key: f.key as string,
    kind: 'FEATURE' as const,
    title: f.title,
    moduleNo: f.moduleNo as number | null,
    minPlan: (f.isAlwaysOn ? 'ALWAYS' : f.minPlan) as string,
    isAlwaysOn: f.isAlwaysOn,
    catalogueStatus: f.catalogueStatus as string,
  }));
  const limits = LIMITS.map(l => ({
    key: l.key as string,
    kind: 'LIMIT' as const,
    title: l.title,
    moduleNo: null,
    minPlan: 'STARTER',
    isAlwaysOn: false,
    catalogueStatus: 'LIVE',
    unit: l.unit,
    period: l.period,
    enforcement: l.enforcement,
    defaults: Object.fromEntries(PLAN_CODES.map(c => [c, l.defaults[c]])),
  }));
  return [...features, ...limits].filter(
    i =>
      (!q.kind || i.kind === q.kind) &&
      (q.moduleNo === undefined || i.moduleNo === q.moduleNo) &&
      (!q.minPlan || i.minPlan === q.minPlan) &&
      (!q.status || i.catalogueStatus === q.status) &&
      (!text || i.key.includes(text) || i.title.toLowerCase().includes(text)),
  );
}

// ------------------------------------------------------------------ add-ons (8.3)
export const addonView = (a: Addon) => ({
  id: a.id!,
  code: a.code,
  name: a.name,
  description: a.description,
  billingType: a.billingType,
  grants: a.grants,
  pricePaise: Number(a.pricePaise),
  minTierRank: a.minTierRank,
  maxTierRank: a.maxTierRank,
  availableToPlans: PLAN_CODES.filter((_c, i) => i + 1 >= a.minTierRank && i + 1 <= a.maxTierRank),
  maxQuantity: a.maxQuantity,
  isOnSale: a.isOnSale,
  sortOrder: a.sortOrder,
  version: a.version,
});

export async function listAddons() {
  const rows = await Addon.findAll({
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const counts = await SubscriptionAddon.count({
    where: { status: { [Op.ne]: 'ENDED' } },
    group: ['addonId'],
  });
  const byAddon = new Map(
    (counts as unknown as { addonId: number; count: number }[]).map(c => [c.addonId, c.count]),
  );
  return Promise.all(
    rows.map(async a => ({
      ...addonView(a),
      activeCount: byAddon.get(a.id!) ?? 0,
      revenueThisMonthPaise: await integrations().billing.addonRevenueThisMonth(a.code),
    })),
  );
}

/** Grant rules of 8.3.2. */
export function checkGrants(
  billingType: 'ONE_TIME' | 'RECURRING',
  grants: AddonGrantRow[],
  maxQuantity: number,
): void {
  const bad = (code: string, message: string) =>
    new UnprocessableError(code, message, [{ field: 'grants', message }]);
  if (grants.some(g => g.type === 'FEATURE_CHOICE')) {
    if (grants.length !== 1) throw bad('VALIDATION_FAILED', 'FEATURE_CHOICE must be the only grant');
    if (billingType !== 'RECURRING') throw bad('VALIDATION_FAILED', 'FEATURE_CHOICE is RECURRING only');
  }
  for (const g of grants) {
    if (g.type === 'FEATURE') {
      const f = FEATURE_BY_KEY.get(g.key);
      if (!f) throw bad('UNKNOWN_ENTITLEMENT_KEY', `Unknown feature key ${g.key}`);
      if (f.catalogueStatus === 'PLANNED')
        throw bad('PLANNED_FEATURE', `${g.key} is planned and not built yet`);
      if (f.isAlwaysOn) throw bad('ALWAYS_ON_FEATURE', `${g.key} is always on`);
    }
    if (g.type === 'LIMIT_INCREMENT') {
      const l = LIMIT_BY_KEY.get(g.key);
      if (!l) throw bad('UNKNOWN_ENTITLEMENT_KEY', `Unknown limit key ${g.key}`);
      if (billingType === 'ONE_TIME' && l.period !== 'MONTHLY')
        throw bad('VALIDATION_FAILED', 'A one-time pack can only add to a monthly limit');
    }
  }
  if (grants.some(g => g.type !== 'LIMIT_INCREMENT') && maxQuantity !== 1)
    throw bad('VALIDATION_FAILED', 'maxQuantity must be 1 when a feature is granted');
}

export interface AddonInput {
  code: string;
  name: string;
  description?: string | null;
  billingType: 'ONE_TIME' | 'RECURRING';
  grants: AddonGrantRow[];
  pricePaise: number;
  minTierRank: number;
  maxTierRank: number;
  maxQuantity: number;
  isOnSale?: boolean;
  reason: string;
}

export async function createAddon(ctx: Ctx, input: AddonInput) {
  checkGrants(input.billingType, input.grants, input.maxQuantity);
  return sequelize.transaction(async t => {
    if (await Addon.findOne({ where: { code: input.code }, transaction: t }))
      throw new ConflictError('ADDON_CODE_TAKEN', 'An add-on with this code exists');
    const max = ((await Addon.max('sortOrder', { transaction: t })) as number) ?? 0;
    const a = await Addon.create(
      {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        billingType: input.billingType,
        grants: input.grants,
        pricePaise: input.pricePaise,
        minTierRank: input.minTierRank,
        maxTierRank: input.maxTierRank,
        maxQuantity: input.maxQuantity,
        isOnSale: input.isOnSale ?? true,
        sortOrder: Math.min(1000, max + 10),
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        version: 1,
      },
      { transaction: t },
    );
    await auditPlan(
      ctx,
      'subscriptions.addon.created',
      'addon',
      a.id!,
      { label: a.code, after: addonView(a), reason: input.reason },
      t,
    );
    return addonView(a);
  });
}

export async function patchAddon(
  ctx: Ctx,
  addonId: number,
  input: Partial<Omit<AddonInput, 'code' | 'reason'>> & {
    sortOrder?: number;
    reason: string;
    version: number;
  },
) {
  return sequelize.transaction(async t => {
    const a = await Addon.findByPk(addonId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw new NotFoundError('ADDON_NOT_FOUND', 'Add-on not found');
    checkVersion(a, input.version, 'add-on');
    const changesShape =
      (input.billingType !== undefined && input.billingType !== a.billingType) ||
      (input.grants !== undefined && JSON.stringify(input.grants) !== JSON.stringify(a.grants));
    if (changesShape && (await SubscriptionAddon.count({ where: { addonId }, transaction: t })) > 0)
      throw new ConflictError(
        'ADDON_IN_USE',
        'Billing type and grants cannot change after the first purchase',
      );
    const next = {
      billingType: input.billingType ?? a.billingType,
      grants: input.grants ?? a.grants,
      maxQuantity: input.maxQuantity ?? a.maxQuantity,
      minTierRank: input.minTierRank ?? a.minTierRank,
      maxTierRank: input.maxTierRank ?? a.maxTierRank,
    };
    if (next.minTierRank > next.maxTierRank)
      throw new ValidationError([{ field: 'maxTierRank', message: 'Must be at least minTierRank' }]);
    checkGrants(next.billingType, next.grants, next.maxQuantity);
    const before = addonView(a);
    for (const k of [
      'name',
      'description',
      'pricePaise',
      'minTierRank',
      'maxTierRank',
      'maxQuantity',
      'isOnSale',
      'sortOrder',
      'billingType',
      'grants',
    ] as const)
      if (input[k] !== undefined) (a as unknown as Record<string, unknown>)[k] = input[k];
    a.updatedBy = ctx.user?.id ?? null;
    a.version += 1;
    await a.save({ transaction: t });
    await auditPlan(
      ctx,
      'subscriptions.addon.updated',
      'addon',
      a.id!,
      { label: a.code, before, after: addonView(a), reason: input.reason },
      t,
    );
    return addonView(a);
  });
}
