import { Op, QueryTypes, type Transaction } from 'sequelize';
import {
  Addon,
  EntitlementOverride,
  PlanEntitlement,
  Society,
  SocietyMember,
  Subscription,
  SubscriptionAddon,
  UsageCounter,
  sequelize,
} from '../../models';
import type { AddonGrantRow } from '../../models/addon.model';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { addDays, now, nowMs } from '../../lib/clock';
import { enqueueAfterCommit } from '../../lib/queue';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { PaymentRequiredError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import {
  BYTES_PER_GB,
  FEATURES,
  FEATURE_BY_KEY,
  LIMITS,
  LIMIT_BY_KEY,
  PLAN_RANK,
  plansWithFeature,
  type FeatureKey,
  type LimitKey,
  type PlanCode,
} from './subscriptions.catalogue';
import { localDate, planLimitValue, usageMonth, zonedDayStart } from './pricing';
import type { ResolvedEntitlements, ResolvedFeature, ResolvedLimit } from './subscriptions.types';

/**
 * Entitlement resolution (BR-04-16), the generation cache (section 6.6, 9.4) and usage counters (BR-04-19 to BR-04-21).
 * The cache goes through `lib/kv` (Redis when REDIS_URL is set, memory otherwise). A cache failure resolves from MySQL;
 * nothing ever fails open (section 13).
 */
export const SUBSCRIPTIONS_QUEUE = 'subscriptions';
export const READ_GRACE_DAYS = 90;
const MAX_TTL = 300;
const MIN_TTL = 5;
const genKey = (societyId: number) => `ent:gen:${societyId}`;
const valKey = (societyId: number, gen: number) => `ent:v1:${societyId}:${gen}`;

// ------------------------------------------------------------------ plan version rows (immutable once published)
export interface VersionLimitRow {
  value: number | null;
  perFlats: number | null;
  overageUnitSize: number | null;
  overagePricePaise: number | null;
}
export interface VersionRows {
  features: Record<string, boolean>;
  limits: Record<string, VersionLimitRow>;
}
const versionRowsCache = new Map<number, VersionRows>();

/** Clears the in-process cache of plan version rows (seeder sync, draft edits, tests). */
export const clearVersionRowsCache = (versionId?: number): void => {
  if (versionId === undefined) versionRowsCache.clear();
  else versionRowsCache.delete(versionId);
};

export async function loadVersionRows(versionId: number, t?: Transaction): Promise<VersionRows> {
  const hit = versionRowsCache.get(versionId);
  if (hit) return hit;
  const rows = await PlanEntitlement.findAll({ where: { planVersionId: versionId }, transaction: t });
  const out: VersionRows = { features: {}, limits: {} };
  for (const r of rows) {
    if (r.kind === 'FEATURE') out.features[r.entitlementKey] = Boolean(r.isEnabled);
    else
      out.limits[r.entitlementKey] = {
        value: r.limitValue === null ? null : Number(r.limitValue),
        perFlats: r.limitPerFlats,
        overageUnitSize: r.overageUnitSize,
        overagePricePaise: r.overagePricePaise === null ? null : Number(r.overagePricePaise),
      };
  }
  versionRowsCache.set(versionId, out);
  return out;
}

/** Plan value of a limit for a number of flats (section 2.5 formula); null is unlimited. */
export const versionLimit = (rows: VersionRows, key: string, flats: number): number | null => {
  const r = rows.limits[key];
  if (!r) return 0;
  return planLimitValue(r.value, r.perFlats, flats);
};

// ------------------------------------------------------------------ resolver
const isActiveWindow = (startsAt: Date, expiresAt: Date | null, at: Date): boolean =>
  startsAt.getTime() <= at.getTime() && (expiresAt === null || expiresAt.getTime() > at.getTime());

const grantsOf = (a: { grants: AddonGrantRow[]; featureKey: string | null }): AddonGrantRow[] =>
  (Array.isArray(a.grants) ? a.grants : []).map(g =>
    g.type === 'FEATURE_CHOICE' && a.featureKey ? { type: 'FEATURE' as const, key: a.featureKey } : g,
  );

export async function flatsCount(societyId: number, t?: Transaction): Promise<number> {
  const c = await UsageCounter.findOne({
    where: { societyId, limitKey: 'limit.flats', periodKey: 'ALL' },
    attributes: ['used'],
    transaction: t,
  });
  return c ? Number(c.used) : 0;
}

/** Resolves a society's entitlements from MySQL (no cache). */
export async function resolveEntitlements(societyId: number, t?: Transaction): Promise<ResolvedEntitlements> {
  const at = now();
  const society = await Society.findByPk(societyId, { attributes: ['id', 'timezone'], transaction: t });
  const timezone = society?.timezone ?? 'Asia/Kolkata';
  const sub = await Subscription.findOne({
    where: { societyId, status: { [Op.ne]: 'CANCELLED' } },
    transaction: t,
  });
  const today = localDate(at, timezone);
  const features: Record<string, ResolvedFeature> = {};
  const limits: Record<string, ResolvedLimit> = {};
  if (!sub) {
    for (const f of FEATURES)
      features[f.key] = { on: f.isAlwaysOn, source: f.isAlwaysOn ? 'ALWAYS_ON' : 'PLAN' };
    for (const l of LIMITS)
      limits[l.key] = { limit: 0, planValue: 0, addonIncrement: 0, overrideApplied: false };
    return {
      societyId,
      subscriptionId: null,
      planCode: null,
      planVersionId: null,
      status: null,
      billingAnchorDay: 1,
      timezone,
      usageMonth: usageMonth(today, 1).periodStart,
      features,
      limits,
      readOnlyFeatures: [],
      readOnlyUntil: null,
      generation: 0,
      nextExpiryAt: null,
    };
  }
  const month = usageMonth(today, sub.billingAnchorDay);
  const [rows, overrides, addons, flats] = await Promise.all([
    loadVersionRows(sub.planVersionId, t),
    EntitlementOverride.findAll({ where: { societyId, revokedAt: null }, transaction: t }),
    SubscriptionAddon.findAll({
      where: { subscriptionId: sub.id!, status: ['ACTIVE', 'CANCEL_SCHEDULED'] },
      transaction: t,
    }),
    flatsCount(societyId, t),
  ]);
  const expiries: number[] = [];
  const future = (d: Date | null) => {
    if (d && d.getTime() > at.getTime()) expiries.push(d.getTime());
  };
  const liveOverrides = overrides.filter(o => {
    future(o.startsAt);
    future(o.expiresAt);
    return isActiveWindow(o.startsAt, o.expiresAt, at);
  });
  const liveAddons = addons.filter(a => {
    future(a.endsAt);
    if (a.endsAt && a.endsAt.getTime() <= at.getTime()) return false;
    return a.billingType === 'RECURRING' || (a.status === 'ACTIVE' && a.periodKey === month.periodStart);
  });
  const keyOverride = new Map(
    liveOverrides.filter(o => o.targetType === 'KEY').map(o => [o.entitlementKey!, o]),
  );
  const moduleOverride = new Map(
    liveOverrides.filter(o => o.targetType === 'MODULE').map(o => [o.moduleNo!, o]),
  );
  const addonFeatures = new Set<string>();
  const addonIncrements: Record<string, number> = {};
  for (const a of liveAddons)
    for (const g of grantsOf(a)) {
      if (g.type === 'FEATURE') addonFeatures.add(g.key);
      if (g.type === 'LIMIT_INCREMENT')
        addonIncrements[g.key] = (addonIncrements[g.key] ?? 0) + g.amount * a.quantity;
    }

  for (const f of FEATURES) {
    if (f.isAlwaysOn) features[f.key] = { on: true, source: 'ALWAYS_ON' };
    else if (f.catalogueStatus === 'PLANNED') features[f.key] = { on: false, source: 'PLAN' };
    else if (keyOverride.has(f.key))
      features[f.key] = { on: Boolean(keyOverride.get(f.key)!.isEnabled), source: 'OVERRIDE_KEY' };
    else if (moduleOverride.has(f.moduleNo))
      features[f.key] = { on: Boolean(moduleOverride.get(f.moduleNo)!.isEnabled), source: 'OVERRIDE_MODULE' };
    else if (addonFeatures.has(f.key)) features[f.key] = { on: true, source: 'ADDON' };
    else features[f.key] = { on: Boolean(rows.features[f.key]), source: 'PLAN' };
  }
  for (const l of LIMITS) {
    const planValue = versionLimit(rows, l.key, flats);
    const addonIncrement = addonIncrements[l.key] ?? 0;
    const o = keyOverride.get(l.key);
    if (o)
      limits[l.key] = {
        limit: o.isUnlimited ? null : Number(o.limitValue ?? 0),
        planValue,
        addonIncrement,
        overrideApplied: true,
      };
    else
      limits[l.key] = {
        limit: planValue === null ? null : planValue + addonIncrement,
        planValue,
        addonIncrement,
        overrideApplied: false,
      };
  }

  let readOnlyFeatures: string[] = [];
  let readOnlyUntil: string | null = null;
  if (sub.downgradedFromPlanVersionId && sub.downgradedAt) {
    const until = addDays(sub.downgradedAt, READ_GRACE_DAYS);
    if (until.getTime() > at.getTime()) {
      future(until);
      const from = await loadVersionRows(sub.downgradedFromPlanVersionId, t);
      readOnlyFeatures = FEATURES.filter(f => from.features[f.key] && !features[f.key]!.on).map(f => f.key);
      readOnlyUntil = readOnlyFeatures.length ? localDate(until, timezone) : null;
    }
  }
  // one-time packs stop at the end of the usage month
  future(addDays(zonedDayStart(month.periodEnd, timezone), 1));

  const planCode = await planCodeOfVersion(sub.planVersionId, t);
  return {
    societyId,
    subscriptionId: sub.id!,
    planCode,
    planVersionId: sub.planVersionId,
    status: sub.status,
    billingAnchorDay: sub.billingAnchorDay,
    timezone,
    usageMonth: month.periodStart,
    features,
    limits,
    readOnlyFeatures,
    readOnlyUntil,
    generation: 0,
    nextExpiryAt: expiries.length ? new Date(Math.min(...expiries)).toISOString() : null,
  };
}

const planCodeByVersion = new Map<number, PlanCode>();
export async function planCodeOfVersion(versionId: number, t?: Transaction): Promise<PlanCode> {
  const hit = planCodeByVersion.get(versionId);
  if (hit) return hit;
  const [row] = await sequelize.query<{ code: PlanCode }>(
    'SELECT p.code FROM plan_versions v JOIN plans p ON p.id = v.planId WHERE v.id = :id',
    { replacements: { id: versionId }, type: QueryTypes.SELECT, transaction: t },
  );
  if (!row) throw new Error(`plan version ${versionId} not found`);
  planCodeByVersion.set(versionId, row.code);
  return row.code;
}

// ------------------------------------------------------------------ cache
let lastCacheWarn = 0;
const warnCache = (err: unknown): void => {
  if (nowMs() - lastCacheWarn > 60_000) {
    lastCacheWarn = nowMs();
    logger.warn({ err }, 'entitlement cache unavailable, resolving from MySQL');
  }
};

/** Cached resolution (section 6.6): `ent:gen:<sid>` then `ent:v1:<sid>:<gen>`; a miss resolves and stores. */
/** `t`: on a cache miss, resolve inside the caller's transaction (no second pool connection). */
export async function getEntitlements(societyId: number, t?: Transaction): Promise<ResolvedEntitlements> {
  let gen = 0;
  let cacheOk = true;
  try {
    gen = await kv().counterGet(genKey(societyId));
    const hit = await kv().cacheGet(valKey(societyId, gen));
    if (hit) return JSON.parse(hit) as ResolvedEntitlements;
  } catch (err) {
    cacheOk = false;
    warnCache(err);
  }
  const r = await resolveEntitlements(societyId, t);
  r.generation = gen;
  // a value read inside an uncommitted transaction is not shared through the cache
  if (cacheOk && !t) {
    const toNext = r.nextExpiryAt ? Math.ceil((Date.parse(r.nextExpiryAt) - nowMs()) / 1000) : MAX_TTL;
    const ttl = Math.max(MIN_TTL, Math.min(MAX_TTL, toNext));
    try {
      await kv().cacheSet(valKey(societyId, gen), JSON.stringify(r), ttl);
    } catch (err) {
      warnCache(err);
    }
  }
  return r;
}

export async function currentGeneration(societyId: number): Promise<number> {
  try {
    return await kv().counterGet(genKey(societyId));
  } catch {
    return 0;
  }
}

type SocietyHook = (societyId: number) => Promise<void>;
const invalidationHooks: SocietyHook[] = [];
/** Other caches that depend on the plan (module 03 society info with `planKey`) register here. */
export const onEntitlementsInvalidated = (fn: SocietyHook): void => {
  invalidationHooks.push(fn);
};

async function bump(societyId: number): Promise<void> {
  let generation: number | null = null;
  try {
    generation = await kv().counterIncr(genKey(societyId));
  } catch (err) {
    warnCache(err);
  }
  for (const h of invalidationHooks)
    await h(societyId).catch(err => logger.error({ err }, 'entitlement invalidation hook failed'));
  emitToRoom(`society:${societyId}:admin`, 'entitlements.changed', { generation });
  const members = await SocietyMember.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['userId'],
  }).catch(() => []);
  for (const m of members) emitToUser(m.userId, 'entitlements.changed', { generation });
}

/** `INCR ent:gen:<sid>` after the transaction commits (or now without one); old values expire on their own. */
export function invalidate(societyId: number, t?: Transaction): void | Promise<void> {
  if (!t) return bump(societyId);
  t.afterCommit(() => bump(societyId).catch(err => logger.error({ err }, 'entitlement invalidation failed')));
}

// ------------------------------------------------------------------ feature checks
export type FeatureMode = 'write' | 'read';

export function featureAllowed(ent: ResolvedEntitlements, key: string, mode: FeatureMode = 'write'): boolean {
  const f = ent.features[key];
  if (f?.on) return true;
  return mode === 'read' && ent.readOnlyFeatures.includes(key);
}

/** The `402 FEATURE_NOT_IN_PLAN` body of section 8.1. */
export async function featureNotInPlan(
  ent: ResolvedEntitlements,
  key: string,
): Promise<PaymentRequiredError> {
  const def = FEATURE_BY_KEY.get(key);
  const detail: Record<string, unknown> = {
    field: 'entitlementKey',
    message: key,
    currentPlan: ent.planCode,
    availableIn: def ? plansWithFeature(def) : [],
  };
  if (def && ent.planCode && (await canUnlock(ent.planCode, key))) detail.unlockAddon = 'FEATURE_UNLOCK';
  const title = def?.title ?? key;
  return new PaymentRequiredError('FEATURE_NOT_IN_PLAN', `${title} is not included in your plan.`, [
    detail as { field: string; message: string },
  ]);
}

/** FEATURE_UNLOCK eligibility (section 2.6): LIVE, not always-on, above the plan, not Enterprise, add-on on sale for the plan. */
export async function canUnlock(planCode: PlanCode, key: string): Promise<boolean> {
  const f = FEATURE_BY_KEY.get(key);
  if (!f || f.isAlwaysOn || f.catalogueStatus !== 'LIVE' || f.minPlan === 'ENTERPRISE') return false;
  const rank = PLAN_RANK[planCode];
  if (PLAN_RANK[f.minPlan] <= rank) return false;
  const addon = await Addon.findOne({
    where: { code: 'FEATURE_UNLOCK' },
    attributes: ['minTierRank', 'maxTierRank', 'isOnSale'],
  });
  return Boolean(addon?.isOnSale && rank >= addon.minTierRank && rank <= addon.maxTierRank);
}

export async function isFeatureOn(
  societyId: number,
  key: FeatureKey,
  mode: FeatureMode = 'write',
): Promise<boolean> {
  return featureAllowed(await getEntitlements(societyId), key, mode);
}

/** Throws `402 FEATURE_NOT_IN_PLAN` (service-level counterpart of `requireFeature`). */
export async function assertFeature(ctx: Ctx, key: FeatureKey, mode: FeatureMode = 'write'): Promise<void> {
  const societyId = ctx.society?.id;
  if (!societyId) throw new Error('assertFeature needs ctx.society');
  const ent = await getEntitlements(societyId);
  if (!featureAllowed(ent, key, mode)) throw await featureNotInPlan(ent, key);
}

/** Enabled LIVE feature keys (module 02 `/auth/me`, `GET /subscription/entitlements`). */
export async function getFeatures(societyId: number): Promise<string[]> {
  const ent = await getEntitlements(societyId);
  return Object.entries(ent.features)
    .filter(([, v]) => v.on)
    .map(([k]) => k);
}

// ------------------------------------------------------------------ limits and usage counters
/** Effective limit in plan units (GB for storage); null is unlimited. */
export async function getLimit(societyId: number, key: LimitKey): Promise<number | null> {
  return (await getEntitlements(societyId)).limits[key]?.limit ?? 0;
}

/** Limit in counter units (bytes for storage). */
export const counterLimit = (key: string, limit: number | null): number | null =>
  limit === null ? null : key === 'limit.storage_gb' ? limit * BYTES_PER_GB : limit;

export const periodKeyFor = (ent: ResolvedEntitlements, key: string): string =>
  LIMIT_BY_KEY.get(key)?.period === 'MONTHLY' ? ent.usageMonth : 'ALL';

export async function usedOf(
  societyId: number,
  key: string,
  periodKey: string,
  t?: Transaction,
): Promise<number> {
  const c = await UsageCounter.findOne({
    where: { societyId, limitKey: key, periodKey },
    attributes: ['used'],
    transaction: t,
    ...(t ? { lock: t.LOCK.UPDATE } : {}),
  });
  return c ? Number(c.used) : 0;
}

/** Current consumption and limit of a key for a society (counter units). */
export async function getUsage(
  societyId: number,
  key: LimitKey,
): Promise<{ limit: number | null; used: number }> {
  const ent = await getEntitlements(societyId);
  return {
    limit: counterLimit(key, ent.limits[key]?.limit ?? 0),
    used: await usedOf(societyId, key, periodKeyFor(ent, key)),
  };
}

/** Creates the zero row outside the caller's transaction, so concurrent first uses never deadlock on the insert. */
async function ensureCounter(societyId: number, key: string, periodKey: string): Promise<void> {
  const exists = await UsageCounter.findOne({
    where: { societyId, limitKey: key, periodKey },
    attributes: ['id'],
  });
  if (exists) return;
  await sequelize.query(
    `INSERT INTO usage_counters (societyId, limitKey, periodKey, used, lastWarnedPct, overageUnits, createdAt, updatedAt)
     VALUES (:sid, :key, :period, 0, 0, 0, :at, :at) ON DUPLICATE KEY UPDATE id = id`,
    { replacements: { sid: societyId, key, period: periodKey, at: now() } },
  );
}

type LimitOpts = { transaction: Transaction; societyId?: number };
const societyOf = (ctx: Ctx, opts: LimitOpts): number => {
  const id = opts.societyId ?? ctx.society?.id;
  if (!id) throw new Error('consumeLimit/releaseLimit need a society (ctx.society or opts.societyId)');
  return id;
};
const checkN = (n: number): void => {
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000)
    throw new Error(`usage amount must be 1..1000000, got ${n}`);
};

/**
 * BR-04-19: atomic consumption inside the caller's transaction. HARD: `used + n <= limit`; SOFT: `used + n <= 2 × limit`
 * (a SOFT limit of 0 behaves as hard); unlimited: no condition. Throws `402 USAGE_LIMIT_EXCEEDED`.
 */
export async function consumeLimit(
  ctx: Ctx,
  key: LimitKey,
  n: number,
  opts: LimitOpts,
): Promise<{ used: number; limit: number | null; overLimit: boolean }> {
  if (!opts?.transaction) throw new Error('consumeLimit must run inside a transaction');
  checkN(n);
  const def = LIMIT_BY_KEY.get(key);
  if (!def) throw new Error(`unknown limit key ${key}`);
  const societyId = societyOf(ctx, opts);
  const ent = await getEntitlements(societyId, opts.transaction);
  const limit = counterLimit(key, ent.limits[key]?.limit ?? 0);
  const periodKey = periodKeyFor(ent, key);
  // ABSOLUTE rows are created with the subscription; a MONTHLY row is created (outside the transaction) on first use
  const exists = await UsageCounter.findOne({
    where: { societyId, limitKey: key, periodKey },
    attributes: ['id'],
    transaction: opts.transaction,
  });
  if (!exists) await ensureCounter(societyId, key, periodKey);
  const ceiling = limit === null ? null : def.enforcement === 'SOFT' && limit > 0 ? limit * 2 : limit;
  const [, affected] = (await sequelize.query(
    `UPDATE usage_counters SET used = used + :n, updatedAt = :at
      WHERE societyId = :sid AND limitKey = :key AND periodKey = :period${ceiling === null ? '' : ' AND used + :n <= :ceiling'}`,
    {
      replacements: { n, at: now(), sid: societyId, key, period: periodKey, ceiling },
      type: QueryTypes.UPDATE,
      transaction: opts.transaction,
    },
  )) as unknown as [unknown, number];
  const used = await usedOf(societyId, key, periodKey, opts.transaction);
  if (affected === 0)
    throw new PaymentRequiredError('USAGE_LIMIT_EXCEEDED', `Plan limit reached (${def.title}).`, [
      { field: 'limitKey', message: key, limit, used, requested: n },
    ]);
  if (limit !== null && limit > 0 && used * 100 >= 80 * limit) {
    const pct = used >= limit ? 100 : 80;
    const [, warned] = (await sequelize.query(
      `UPDATE usage_counters SET lastWarnedPct = :pct WHERE societyId = :sid AND limitKey = :key AND periodKey = :period AND lastWarnedPct < :pct`,
      {
        replacements: { pct, sid: societyId, key, period: periodKey },
        type: QueryTypes.UPDATE,
        transaction: opts.transaction,
      },
    )) as unknown as [unknown, number];
    if (warned > 0)
      enqueueAfterCommit(
        opts.transaction,
        SUBSCRIPTIONS_QUEUE,
        'subscriptions:usage-threshold',
        { societyId, limitKey: key, periodKey, pct },
        { jobId: `usage:${societyId}:${key}:${periodKey}:${pct}` },
      );
  }
  return { used, limit, overLimit: limit !== null && used > limit };
}

/** ABSOLUTE keys only (a MONTHLY key is a programmer error). Never goes below 0. */
export async function releaseLimit(ctx: Ctx, key: LimitKey, n: number, opts: LimitOpts): Promise<void> {
  if (!opts?.transaction) throw new Error('releaseLimit must run inside a transaction');
  checkN(n);
  const def = LIMIT_BY_KEY.get(key);
  if (!def) throw new Error(`unknown limit key ${key}`);
  if (def.period !== 'ABSOLUTE') throw new Error(`releaseLimit on a MONTHLY key (${key})`);
  const societyId = societyOf(ctx, opts);
  await sequelize.query(
    `UPDATE usage_counters SET used = IF(used >= :n, used - :n, 0), updatedAt = :at
      WHERE societyId = :sid AND limitKey = :key AND periodKey = 'ALL'`,
    { replacements: { n, at: now(), sid: societyId, key }, transaction: opts.transaction },
  );
}

/** Zero rows for every ABSOLUTE limit (called when a subscription row is created). */
export async function ensureAbsoluteCounters(societyId: number, t?: Transaction): Promise<void> {
  const at = now();
  for (const l of LIMITS.filter(x => x.period === 'ABSOLUTE'))
    await sequelize.query(
      `INSERT INTO usage_counters (societyId, limitKey, periodKey, used, lastWarnedPct, overageUnits, createdAt, updatedAt)
       VALUES (:sid, :key, 'ALL', 0, 0, 0, :at, :at) ON DUPLICATE KEY UPDATE id = id`,
      { replacements: { sid: societyId, key: l.key, at }, transaction: t },
    );
}

/** Sets an ABSOLUTE counter (reconciliation, seeders). */
export async function setAbsoluteUsage(
  societyId: number,
  key: LimitKey,
  used: number,
  t?: Transaction,
): Promise<void> {
  await ensureCounter(societyId, key, 'ALL');
  await sequelize.query(
    `UPDATE usage_counters SET used = :used, lastReconciledAt = :at, updatedAt = :at
      WHERE societyId = :sid AND limitKey = :key AND periodKey = 'ALL'`,
    { replacements: { used, at: now(), sid: societyId, key }, transaction: t },
  );
}

// ------------------------------------------------------------------ providers
type Counter = (societyId: number) => Promise<number>;
export const usageProviders = new Map<LimitKey, Counter>();
export const featureUsageProviders = new Map<FeatureKey, Counter>();

/** ABSOLUTE reconciliation source (job `subscriptions:usage-reconcile`). */
export function registerUsageProvider(key: LimitKey, count: Counter): void {
  usageProviders.set(key, count);
}
/** Records in use for the downgrade preview (`recordsInUse`). */
export function registerFeatureUsageProvider(key: FeatureKey, count: Counter): void {
  featureUsageProviders.set(key, count);
}
