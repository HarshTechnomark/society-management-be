import { createHash } from 'node:crypto';
import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { FeatureFlag, FeatureFlagOverride, Society, sequelize } from '../../models';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { PLAN_RANK, type PlanCode } from './subscriptions.catalogue';
import { getEntitlements } from './entitlements.service';
import { addDaysYmd, localDate } from './pricing';

/**
 * Feature flags (section 8.7, BR-04-27). The evaluator reads one snapshot of every flag and override, cached as
 * `ff:v1:<gen>` for 60 s through `lib/kv`; any change bumps `ff:gen` after commit.
 */
const FF_GEN = 'ff:gen';
const FF_TTL = 60;

interface FlagSnap {
  id: number;
  flagKey: string;
  type: FeatureFlag['type'];
  isEnabled: boolean;
  minPlanCode: string | null;
  rolloutPercent: number;
  isClientVisible: boolean;
  overrides: Record<string, { value: boolean; expiresAt: string | null }>;
}

export const bucketOf = (flagKey: string, societyId: number): number =>
  parseInt(createHash('sha256').update(`${flagKey}:${societyId}`).digest('hex').slice(0, 8), 16) % 100;

async function loadSnapshot(): Promise<FlagSnap[]> {
  const [flags, overrides] = await Promise.all([FeatureFlag.findAll(), FeatureFlagOverride.findAll()]);
  return flags.map(f => ({
    id: f.id!,
    flagKey: f.flagKey,
    type: f.type,
    isEnabled: f.isEnabled,
    minPlanCode: f.minPlanCode,
    rolloutPercent: f.rolloutPercent,
    isClientVisible: f.isClientVisible,
    overrides: Object.fromEntries(
      overrides
        .filter(o => o.flagId === f.id)
        .map(o => [String(o.societyId), { value: o.value, expiresAt: o.expiresAt?.toISOString() ?? null }]),
    ),
  }));
}

async function snapshot(): Promise<FlagSnap[]> {
  try {
    const gen = await kv().counterGet(FF_GEN);
    const hit = await kv().cacheGet(`ff:v1:${gen}`);
    if (hit) return JSON.parse(hit) as FlagSnap[];
    const snap = await loadSnapshot();
    await kv().cacheSet(`ff:v1:${gen}`, JSON.stringify(snap), FF_TTL);
    return snap;
  } catch (err) {
    logger.warn({ err }, 'flag cache unavailable, reading MySQL');
    return loadSnapshot();
  }
}

/** `INCR ff:gen` after commit. */
export function invalidateFlags(t?: Transaction): void {
  const run = () =>
    kv()
      .counterIncr(FF_GEN)
      .then(() => undefined)
      .catch(err => logger.error({ err }, 'flag cache invalidation failed'));
  if (t) t.afterCommit(run);
  else void run();
}

export type FlagStep = 'OVERRIDE' | 'DISABLED' | 'KILL_SWITCH' | 'PLAN' | 'PERCENTAGE' | 'TENANT' | 'GLOBAL';
export interface FlagResult {
  on: boolean;
  step: FlagStep;
  why: string;
  bucket?: number;
}

/** BR-04-27, in prototype order. Without a society, PLAN, PERCENTAGE and TENANT flags are off. */
export function evaluate(
  f: Pick<FlagSnap, 'flagKey' | 'type' | 'isEnabled' | 'minPlanCode' | 'rolloutPercent' | 'overrides'>,
  scope?: { societyId: number; planCode: PlanCode | null },
  at: Date = now(),
): FlagResult {
  if (scope) {
    const o = f.overrides[String(scope.societyId)];
    if (o && (!o.expiresAt || Date.parse(o.expiresAt) > at.getTime()))
      return { on: o.value, step: 'OVERRIDE', why: `Society override: forced ${o.value ? 'on' : 'off'}` };
  }
  if (!f.isEnabled) return { on: false, step: 'DISABLED', why: 'The flag is off' };
  if (f.type === 'KILL_SWITCH') return { on: true, step: 'KILL_SWITCH', why: 'Kill switch engaged' };
  if (f.type === 'PLAN') {
    if (!scope?.planCode) return { on: false, step: 'PLAN', why: 'No plan to compare' };
    const on = PLAN_RANK[scope.planCode] >= PLAN_RANK[(f.minPlanCode ?? 'ENTERPRISE') as PlanCode];
    return { on, step: 'PLAN', why: `Plan ${scope.planCode} ${on ? 'meets' : 'is below'} ${f.minPlanCode}` };
  }
  if (f.type === 'PERCENTAGE') {
    if (!scope) return { on: false, step: 'PERCENTAGE', why: 'No society to bucket' };
    const bucket = bucketOf(f.flagKey, scope.societyId);
    const on = bucket < f.rolloutPercent;
    return {
      on,
      step: 'PERCENTAGE',
      why: `Rollout ${f.rolloutPercent} %: this society falls in bucket ${bucket} (${on ? 'inside' : 'outside'})`,
      bucket,
    };
  }
  if (f.type === 'TENANT')
    return { on: false, step: 'TENANT', why: 'Tenant flag: on only by society override' };
  return { on: true, step: 'GLOBAL', why: 'Global default: on' };
}

async function scopeOf(societyId: number): Promise<{ societyId: number; planCode: PlanCode | null }> {
  return { societyId, planCode: (await getEntitlements(societyId)).planCode };
}

export async function isFlagOn(flagKey: string, scope?: { societyId: number }): Promise<boolean> {
  const f = (await snapshot()).find(x => x.flagKey === flagKey);
  if (!f) return false;
  return evaluate(f, scope ? await scopeOf(scope.societyId) : undefined).on;
}

/** Client-visible flags for `GET /subscription/entitlements`. */
export async function clientFlags(societyId: number): Promise<Record<string, boolean>> {
  const scope = await scopeOf(societyId);
  const out: Record<string, boolean> = {};
  for (const f of (await snapshot()).filter(x => x.isClientVisible)) out[f.flagKey] = evaluate(f, scope).on;
  return out;
}

// ------------------------------------------------------------------ platform API (8.7)
const flagNotFound = () => new NotFoundError('FLAG_NOT_FOUND', 'Feature flag not found');
const stale = () =>
  new ConflictError('STALE_VERSION', 'Someone else changed this flag. Reload to see the change.');

export const flagView = (f: FeatureFlag, overrideCount?: number) => ({
  id: f.id!,
  flagKey: f.flagKey,
  description: f.description,
  type: f.type,
  isEnabled: f.isEnabled,
  minPlanCode: f.minPlanCode,
  rolloutPercent: f.rolloutPercent,
  isClientVisible: f.isClientVisible,
  ownerTeam: f.ownerTeam,
  expiresOn: f.expiresOn,
  ...(overrideCount === undefined ? {} : { overrideCount }),
  updatedAt: f.updatedAt!.toISOString(),
  archivedAt: f.deletedAt ? f.deletedAt.toISOString() : null,
  version: f.version,
});

export interface ListFlagsQuery {
  type?: FeatureFlag['type'];
  q?: string;
  includeArchived?: boolean;
  page: number;
  limit: number;
  sortBy: 'flagKey' | 'updatedAt' | 'type';
  sortOrder: 'asc' | 'desc';
}
export async function listFlags(q: ListFlagsQuery) {
  const where: WhereOptions = {};
  if (q.type) Object.assign(where, { type: q.type });
  if (q.q)
    Object.assign(where, {
      [Op.or]: [{ flagKey: { [Op.like]: `%${q.q}%` } }, { description: { [Op.like]: `%${q.q}%` } }],
    });
  const { rows, count } = await FeatureFlag.findAndCountAll({
    where,
    paranoid: !q.includeArchived,
    order: [[q.sortBy, q.sortOrder.toUpperCase()]],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const counts = await FeatureFlagOverride.count({
    where: { flagId: rows.map(r => r.id!) },
    group: ['flagId'],
  });
  const byFlag = new Map(
    (counts as unknown as { flagId: number; count: number }[]).map(c => [c.flagId, c.count]),
  );
  // segment counts for the filter chips (section 11.2)
  const typeCounts = await FeatureFlag.count({ group: ['type'] });
  return {
    data: rows.map(r => flagView(r, byFlag.get(r.id!) ?? 0)),
    pagination: pageMeta(q.page, q.limit, count),
    typeCounts: Object.fromEntries(
      (typeCounts as unknown as { type: string; count: number }[]).map(c => [c.type, c.count]),
    ),
  };
}

async function overrideRows(flagId: number) {
  const rows = await FeatureFlagOverride.findAll({
    where: { flagId },
    include: [{ model: Society, attributes: ['id', 'name'] }],
    order: [['createdAt', 'DESC']],
  });
  return rows.map(o => ({
    id: o.id!,
    society: { id: o.societyId, name: (o as unknown as { Society?: Society }).Society?.name ?? null },
    value: o.value,
    reason: o.reason,
    expiresAt: o.expiresAt?.toISOString() ?? null,
    createdAt: o.createdAt!.toISOString(),
    createdBy: o.createdBy,
  }));
}

export async function getFlag(flagId: number) {
  const f = await FeatureFlag.findByPk(flagId);
  if (!f) throw flagNotFound();
  const overrides = await overrideRows(f.id!);
  return { ...flagView(f, overrides.length), overrides };
}

export interface CreateFlagInput {
  flagKey: string;
  description: string;
  type: FeatureFlag['type'];
  isEnabled?: boolean;
  minPlanCode?: PlanCode;
  rolloutPercent?: number;
  isClientVisible?: boolean;
  ownerTeam?: string;
  expiresOn?: string;
  reason: string;
}

function checkExpiresOn(d: string | null | undefined): void {
  if (!d) return;
  const today = localDate(now());
  if (d < today || d > addDaysYmd(today, 730))
    throw new UnprocessableError('VALIDATION_FAILED', 'The expiry date must be within the next 730 days', [
      { field: 'expiresOn', message: 'Must be between today and today + 730 days' },
    ]);
}

export async function createFlag(ctx: Ctx, input: CreateFlagInput) {
  checkExpiresOn(input.expiresOn);
  return sequelize.transaction(async t => {
    if (await FeatureFlag.findOne({ where: { flagKey: input.flagKey }, paranoid: false, transaction: t }))
      throw new ConflictError('FLAG_KEY_TAKEN', 'A flag with this key exists (archived keys stay reserved)');
    const f = await FeatureFlag.create(
      {
        flagKey: input.flagKey,
        description: input.description,
        type: input.type,
        isEnabled: input.isEnabled ?? false,
        minPlanCode: input.minPlanCode ?? null,
        rolloutPercent: input.rolloutPercent ?? (input.type === 'PLAN' ? 100 : 0),
        isClientVisible: input.isClientVisible ?? false,
        ownerTeam: input.ownerTeam ?? null,
        expiresOn: input.expiresOn ?? null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        version: 1,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: 'subscriptions.feature_flag.created',
        entityType: 'feature_flag',
        entityId: f.id!,
        entityLabel: f.flagKey,
        after: flagView(f),
        reason: input.reason,
      },
      t,
    );
    invalidateFlags(t);
    return flagView(f, 0);
  });
}

async function lockFlag(flagId: number, version: number | undefined, t: Transaction): Promise<FeatureFlag> {
  const f = await FeatureFlag.findByPk(flagId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!f) throw flagNotFound();
  if (version !== undefined && f.version !== version) throw stale();
  return f;
}

export interface UpdateFlagInput {
  description?: string;
  minPlanCode?: PlanCode;
  rolloutPercent?: number;
  isClientVisible?: boolean;
  ownerTeam?: string | null;
  expiresOn?: string | null;
  reason: string;
  version: number;
}
export async function updateFlag(ctx: Ctx, flagId: number, input: UpdateFlagInput) {
  checkExpiresOn(input.expiresOn);
  return sequelize.transaction(async t => {
    const f = await lockFlag(flagId, input.version, t);
    if (input.minPlanCode !== undefined && f.type !== 'PLAN')
      throw new UnprocessableError('VALIDATION_FAILED', 'Only a PLAN flag has a minimum plan', [
        { field: 'minPlanCode', message: 'Only for PLAN flags' },
      ]);
    if (input.rolloutPercent !== undefined && f.type !== 'PERCENTAGE')
      throw new UnprocessableError('VALIDATION_FAILED', 'Only a PERCENTAGE flag has a rollout', [
        { field: 'rolloutPercent', message: 'Only for PERCENTAGE flags' },
      ]);
    if (input.isClientVisible && f.type === 'KILL_SWITCH')
      throw new UnprocessableError('VALIDATION_FAILED', 'A kill switch is never client visible', [
        { field: 'isClientVisible', message: 'Must be false for KILL_SWITCH' },
      ]);
    const before = flagView(f);
    const fields = [
      'description',
      'minPlanCode',
      'rolloutPercent',
      'isClientVisible',
      'ownerTeam',
      'expiresOn',
    ] as const;
    for (const k of fields)
      if (input[k] !== undefined) (f as unknown as Record<string, unknown>)[k] = input[k];
    f.updatedBy = ctx.user?.id ?? null;
    f.version += 1;
    await f.save({ transaction: t });
    const after = flagView(f);
    const diff = Object.fromEntries(
      fields.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(k => [k, after[k]]),
    );
    await audit(
      ctx,
      {
        action: 'subscriptions.feature_flag.updated',
        entityType: 'feature_flag',
        entityId: f.id!,
        entityLabel: f.flagKey,
        before: Object.fromEntries(Object.keys(diff).map(k => [k, before[k as keyof typeof before]])),
        after: diff,
        reason: input.reason,
      },
      t,
    );
    invalidateFlags(t);
    return flagView(f);
  });
}

export async function toggleFlag(
  ctx: Ctx,
  flagId: number,
  input: { isEnabled: boolean; reason: string; version: number },
) {
  return sequelize.transaction(async t => {
    const f = await lockFlag(flagId, input.version, t);
    if (f.isEnabled === input.isEnabled)
      throw new UnprocessableError(
        'FLAG_ALREADY_IN_STATE',
        `The flag is already ${input.isEnabled ? 'on' : 'off'}`,
      );
    const before = { isEnabled: f.isEnabled, rolloutPercent: f.rolloutPercent };
    f.isEnabled = input.isEnabled;
    if (input.isEnabled && f.type === 'PERCENTAGE' && f.rolloutPercent === 0) f.rolloutPercent = 10;
    f.updatedBy = ctx.user?.id ?? null;
    f.version += 1;
    await f.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'subscriptions.feature_flag.toggled',
        entityType: 'feature_flag',
        entityId: f.id!,
        entityLabel: f.flagKey,
        before,
        after: { isEnabled: f.isEnabled, rolloutPercent: f.rolloutPercent },
        reason: input.reason,
      },
      t,
    );
    if (f.type === 'KILL_SWITCH')
      t.afterCommit(() =>
        // module 07 `platform_notifications` is not built yet; the log line stands in for it
        logger.warn({ flagKey: f.flagKey, engaged: f.isEnabled }, 'kill switch toggled'),
      );
    invalidateFlags(t);
    return flagView(f);
  });
}

/** Needs the flag type before step-up (KILL_SWITCH toggles require step-up). */
export async function flagTypeOf(flagId: number): Promise<FeatureFlag['type'] | null> {
  return (await FeatureFlag.findByPk(flagId, { attributes: ['id', 'type'] }))?.type ?? null;
}

export async function archiveFlag(ctx: Ctx, flagId: number, input: { reason: string; version: number }) {
  await sequelize.transaction(async t => {
    const f = await lockFlag(flagId, input.version, t);
    await FeatureFlagOverride.destroy({ where: { flagId: f.id! }, transaction: t });
    await f.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: 'subscriptions.feature_flag.archived',
        entityType: 'feature_flag',
        entityId: f.id!,
        entityLabel: f.flagKey,
        before: flagView(f),
        reason: input.reason,
      },
      t,
    );
    invalidateFlags(t);
  });
}

async function societyOr404(societyId: number, t?: Transaction): Promise<Society> {
  const s = await Society.findByPk(societyId, { attributes: ['id', 'name'], transaction: t });
  if (!s) throw new AppError(404, 'SOCIETY_NOT_FOUND', 'Society not found');
  return s;
}

export async function evaluateFlag(flagId: number, societyId: number): Promise<FlagResult> {
  const f = await FeatureFlag.findByPk(flagId);
  if (!f) throw flagNotFound();
  await societyOr404(societyId);
  const o = await FeatureFlagOverride.findOne({ where: { flagId, societyId } });
  return evaluate(
    {
      ...f.get({ plain: true }),
      overrides: o
        ? { [String(societyId)]: { value: o.value, expiresAt: o.expiresAt?.toISOString() ?? null } }
        : {},
    },
    await scopeOf(societyId),
  );
}

export async function upsertFlagOverride(
  ctx: Ctx,
  flagId: number,
  input: { societyId: number; value: boolean; reason: string; expiresAt?: Date | null },
): Promise<{ created: boolean; override: Awaited<ReturnType<typeof overrideRows>>[number] }> {
  if (input.expiresAt) {
    const max = now().getTime() + 365 * 86_400_000;
    if (input.expiresAt.getTime() <= now().getTime() || input.expiresAt.getTime() > max)
      throw new UnprocessableError('VALIDATION_FAILED', 'The expiry must be in the next 365 days', [
        { field: 'expiresAt', message: 'Must be in the future and within 365 days' },
      ]);
  }
  const created = await sequelize.transaction(async t => {
    const f = await FeatureFlag.findByPk(flagId, { transaction: t, paranoid: false });
    if (!f) throw flagNotFound();
    if (f.deletedAt) throw new AppError(409, 'INVALID_STATE', 'This flag is archived');
    await societyOr404(input.societyId, t);
    const existing = await FeatureFlagOverride.findOne({
      where: { flagId, societyId: input.societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const before = existing
      ? { value: existing.value, reason: existing.reason, expiresAt: existing.expiresAt }
      : null;
    if (existing)
      await existing.update(
        {
          value: input.value,
          reason: input.reason,
          expiresAt: input.expiresAt ?? null,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
    else
      await FeatureFlagOverride.create(
        {
          flagId,
          societyId: input.societyId,
          value: input.value,
          reason: input.reason,
          expiresAt: input.expiresAt ?? null,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
    await audit(
      ctx,
      {
        action: 'subscriptions.feature_flag_override.added',
        entityType: 'feature_flag',
        entityId: flagId,
        entityLabel: f.flagKey,
        societyId: input.societyId,
        before,
        after: { value: input.value, expiresAt: input.expiresAt ?? null },
        reason: input.reason,
      },
      t,
    );
    invalidateFlags(t);
    return !existing;
  });
  const override = (await overrideRows(flagId)).find(o => o.society.id === input.societyId)!;
  return { created, override };
}

export async function removeFlagOverride(
  ctx: Ctx,
  flagId: number,
  overrideId: number,
  reason: string,
): Promise<void> {
  await sequelize.transaction(async t => {
    const f = await FeatureFlag.findByPk(flagId, { transaction: t });
    if (!f) throw flagNotFound();
    const o = await FeatureFlagOverride.findOne({ where: { id: overrideId, flagId }, transaction: t });
    if (!o) throw new NotFoundError('FLAG_OVERRIDE_NOT_FOUND', 'Flag override not found');
    await o.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: 'subscriptions.feature_flag_override.removed',
        entityType: 'feature_flag',
        entityId: flagId,
        entityLabel: f.flagKey,
        societyId: o.societyId,
        before: { value: o.value, reason: o.reason, expiresAt: o.expiresAt },
        reason,
      },
      t,
    );
    invalidateFlags(t);
  });
}

/** Job `subscriptions:flag-stale-reminder`: flags past `expiresOn` (module 07 platform notification stand-in: a log line). */
export async function staleFlags(): Promise<string[]> {
  const today = localDate(now());
  const rows = await FeatureFlag.findAll({ where: { expiresOn: { [Op.lt]: today } } });
  for (const f of rows)
    logger.warn({ flagKey: f.flagKey, expiresOn: f.expiresOn }, 'feature flag past its expiry date');
  return rows.map(r => r.flagKey);
}
