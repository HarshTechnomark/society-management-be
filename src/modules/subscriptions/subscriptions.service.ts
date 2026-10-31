import { Op, type Transaction } from 'sequelize';
import {
  Addon,
  EntitlementOverride,
  Plan,
  PlanVersion,
  Society,
  Subscription,
  SubscriptionAddon,
  UsageCounter,
  sequelize,
} from '../../models';
import type { FlatSegment, PreviousPeriod } from '../../models/subscription.model';
import { addDays, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { FEATURE_BY_KEY, LIMITS, LIMIT_BY_KEY, PLAN_RANK, type PlanCode } from './subscriptions.catalogue';
import {
  READ_GRACE_DAYS,
  ensureAbsoluteCounters,
  flatsCount,
  getEntitlements,
  invalidate,
  loadVersionRows,
  planCodeOfVersion,
  versionLimit,
} from './entitlements.service';
import { isFlagOn } from './flags.service';
import { closeUsageMonths } from './subscriptions.usage';
import { integrations, type PlatformInvoiceDto } from './subscriptions.integrations';
import {
  addDaysYmd,
  freeMonthsFor,
  localDate,
  monthsOf,
  parseYmd,
  periodFrom,
  proration,
  usageMonth,
  zonedDayStart,
  type Proration,
} from './pricing';
import {
  checkVersion,
  chargedOf,
  currentVersion,
  emitSubscriptionUpdated,
  invalidState,
  liveSub,
  lockSocietyAndSub,
  monthlyEquivalent,
  notifyViewers,
  periodValueOf,
  planByCode,
  priceOf,
  subscriptionNotFound,
  todayOf,
  versionById,
} from './subscriptions.util';
import type { AutopayStatus, BillingCycle, SubscriptionStatus } from './subscriptions.types';

const SYSTEM: Ctx = { requestId: 'job', ip: '', userAgent: '' };
const actorId = (ctx: Ctx): number | null => ctx.user?.id ?? null;

function auditSub(
  ctx: Ctx,
  sub: Subscription,
  action: string,
  o: { before?: unknown; after?: unknown; reason?: string | null } = {},
  t?: Transaction,
): Promise<void> {
  return audit(
    ctx,
    {
      action: `subscriptions.subscription.${action}`,
      entityType: 'subscription',
      entityId: sub.id!,
      societyId: sub.societyId,
      ...o,
    },
    t,
  );
}

// ------------------------------------------------------------------ limit conflicts (BR-04-9)
export interface LimitConflict {
  limitKey: string;
  used: number;
  targetLimit: number;
}

/** HARD limits whose current usage exceeds the target version's effective limit (current flats, CONTRACT overrides kept). */
export async function limitConflicts(
  societyId: number,
  target: PlanVersion,
  t?: Transaction,
): Promise<LimitConflict[]> {
  const [rows, flats, overrides, targetCode] = await Promise.all([
    loadVersionRows(target.id!, t),
    flatsCount(societyId, t),
    EntitlementOverride.findAll({
      where: { societyId, targetType: 'KEY', revokedAt: null, source: { [Op.ne]: 'PREMIUM_TRIAL' } },
      transaction: t,
    }),
    planCodeOfVersion(target.id!, t),
  ]);
  const sub = await liveSub(societyId, t);
  const increments: Record<string, number> = {};
  if (sub) {
    const addons = await SubscriptionAddon.findAll({
      where: { subscriptionId: sub.id!, billingType: 'RECURRING', status: ['ACTIVE', 'CANCEL_SCHEDULED'] },
      include: [{ model: Addon, attributes: ['minTierRank', 'maxTierRank'] }],
      transaction: t,
    });
    const rank = PLAN_RANK[targetCode];
    for (const a of addons) {
      const def = (a as unknown as { Addon: Addon }).Addon;
      if (rank < def.minTierRank || rank > def.maxTierRank) continue;
      for (const g of a.grants)
        if (g.type === 'LIMIT_INCREMENT')
          increments[g.key] = (increments[g.key] ?? 0) + g.amount * a.quantity;
    }
  }
  const at = now();
  const counters = await UsageCounter.findAll({ where: { societyId, periodKey: 'ALL' }, transaction: t });
  const out: LimitConflict[] = [];
  for (const l of LIMITS.filter(x => x.enforcement === 'HARD')) {
    const o = overrides.find(
      x =>
        x.entitlementKey === l.key &&
        x.startsAt.getTime() <= at.getTime() &&
        (!x.expiresAt || x.expiresAt.getTime() > at.getTime()),
    );
    let limit: number | null;
    if (o) limit = o.isUnlimited ? null : Number(o.limitValue ?? 0);
    else {
      const base = versionLimit(rows, l.key, flats);
      limit = base === null ? null : base + (increments[l.key] ?? 0);
    }
    const used = Number(counters.find(c => c.limitKey === l.key)?.used ?? 0);
    if (limit !== null && used > limit) out.push({ limitKey: l.key, used, targetLimit: limit });
  }
  return out;
}

export function conflictError(conflicts: LimitConflict[], planName: string): AppError {
  return new AppError(
    409,
    'DOWNGRADE_LIMIT_CONFLICT',
    `Usage is above the ${planName} plan limits. Reduce it first.`,
    conflicts.map(c => ({
      field: c.limitKey,
      message: `${c.limitKey}: ${c.used} in use, ${planName} allows ${c.targetLimit}`,
      used: c.used,
      targetLimit: c.targetLimit,
    })),
  );
}

// ------------------------------------------------------------------ add-on endings
/** BR-04-23: end add-ons the plan no longer allows, and (upgrade) add-ons whose features the plan now includes. */
async function endAddonsForPlan(
  ctx: Ctx,
  sub: Subscription,
  target: PlanVersion,
  opts: { upgrade: boolean },
  t: Transaction,
): Promise<string[]> {
  const code = await planCodeOfVersion(target.id!, t);
  const rank = PLAN_RANK[code];
  const rows = await loadVersionRows(target.id!, t);
  const open = await SubscriptionAddon.findAll({
    where: { subscriptionId: sub.id!, status: { [Op.ne]: 'ENDED' } },
    include: [{ model: Addon, attributes: ['minTierRank', 'maxTierRank'] }],
    transaction: t,
    lock: { level: t.LOCK.UPDATE, of: SubscriptionAddon },
  });
  const ended: string[] = [];
  for (const a of open) {
    const def = (a as unknown as { Addon: Addon }).Addon;
    let reason: 'PLAN_CHANGED' | 'INCLUDED_IN_PLAN' | null = null;
    if (rank < def.minTierRank || rank > def.maxTierRank) reason = 'PLAN_CHANGED';
    else if (opts.upgrade) {
      const featureKeys = a.grants
        .map(g => (g.type === 'FEATURE' ? g.key : g.type === 'FEATURE_CHOICE' ? a.featureKey : null))
        .filter((k): k is string => Boolean(k));
      const hasLimit = a.grants.some(g => g.type === 'LIMIT_INCREMENT');
      if (featureKeys.length && !hasLimit && featureKeys.every(k => rows.features[k]))
        reason = 'INCLUDED_IN_PLAN';
    }
    if (!reason) continue;
    await endAddon(ctx, a, reason, t);
    ended.push(a.addonCode);
  }
  return ended;
}

export async function endAddon(
  ctx: Ctx,
  a: SubscriptionAddon,
  reason: NonNullable<SubscriptionAddon['endedReason']>,
  t: Transaction,
): Promise<void> {
  const before = { status: a.status };
  a.status = 'ENDED';
  a.endedReason = reason;
  if (!a.endsAt || a.endsAt.getTime() > now().getTime()) a.endsAt = now();
  a.updatedBy = actorId(ctx);
  a.version += 1;
  await a.save({ transaction: t });
  await audit(
    ctx,
    {
      action: 'subscriptions.subscription_addon.ended',
      entityType: 'subscription_addon',
      entityId: a.id!,
      entityLabel: a.addonCode,
      societyId: a.societyId,
      before,
      after: { status: 'ENDED', endedReason: reason },
    },
    t,
  );
  if (a.billingType === 'RECURRING')
    notifyViewers(t, a.societyId, 'subscription.addon_ended', { addonCode: a.addonCode });
}

// ------------------------------------------------------------------ flat segments (BR-04-12)
function recordSegment(sub: Subscription, today: string, charged: number): void {
  const segs: FlatSegment[] = [...(sub.flatSegments ?? [])];
  const open = segs[segs.length - 1];
  if (open && open.toDate === null && open.fromDate === today) {
    open.billableFlats = Math.max(open.billableFlats, charged);
  } else if (open && open.toDate === null) {
    if (open.billableFlats === charged) return;
    open.toDate = addDaysYmd(today, -1);
    segs.push({ fromDate: today, toDate: null, billableFlats: charged });
  } else segs.push({ fromDate: today, toDate: null, billableFlats: charged });
  sub.flatSegments = segs.slice(-400);
  sub.changed('flatSegments', true);
}

// ------------------------------------------------------------------ module 05: create, start, extend, cancel
async function assertSelectable(plan: Plan): Promise<void> {
  if (!plan.isActive) throw new UnprocessableError('PLAN_INACTIVE', 'This plan is not available');
}

/** Self-serve sign-up: TRIALING row on the plan's current version. Idempotent (an existing live row is returned). */
export async function createTrial(
  societyId: number,
  planKey: PlanCode,
  trialEndsAt: Date,
  t: Transaction,
  ctx: Ctx = SYSTEM,
): Promise<{ subscriptionId: number }> {
  if (planKey === 'ENTERPRISE')
    throw new UnprocessableError('PLAN_NOT_SELF_SERVE', 'Enterprise is set up by the SocietyApp team');
  const { society, sub: existing } = await lockSocietyAndSub(societyId, t);
  if (existing) return { subscriptionId: existing.id! };
  const plan = await planByCode(planKey, t);
  await assertSelectable(plan);
  const v = await currentVersion(plan, t);
  const today = todayOf(society);
  const sub = await Subscription.create(
    {
      societyId,
      planId: plan.id!,
      planVersionId: v.id!,
      status: 'TRIALING',
      statusReason: 'SIGNED_UP',
      statusChangedAt: now(),
      billingCycle: 'MONTHLY',
      trialEndsAt,
      paidStartedAt: null,
      billingAnchorDay: parseYmd(today).d,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      lastInvoicedPeriodStart: null,
      billableFlats: await flatsCount(societyId, t),
      flatSegments: null,
      previousPeriod: null,
      customPricePerFlatPaise: null,
      customMinFlats: null,
      pendingPlanVersionId: null,
      pendingChangeType: null,
      pendingChangeAt: null,
      pendingPostponements: 0,
      pendingBillingCycle: null,
      downgradedFromPlanVersionId: null,
      downgradedAt: null,
      cancelAtPeriodEnd: false,
      cancelRequestedBy: null,
      cancelReason: null,
      cancelledAt: null,
      autopayStatus: 'NONE',
      autopayMethod: null,
      autopayMandateRef: null,
      autopayMaxAmountPaise: null,
      createdBy: actorId(ctx),
      updatedBy: actorId(ctx),
      version: 1,
    },
    { transaction: t },
  );
  await ensureAbsoluteCounters(societyId, t);
  await auditSub(ctx, sub, 'created', { after: { status: 'TRIALING', planCode: planKey, trialEndsAt } }, t);
  invalidate(societyId, t);
  return { subscriptionId: sub.id! };
}

export interface StartPaidInput {
  societyId: number;
  planKey?: PlanCode;
  billingCycle: BillingCycle;
  customPricePerFlatPaise?: number;
  /** Society self-serve (`POST /subscription/activate`) checks the subscription version. */
  version?: number;
}

/**
 * Paid start (BR-04-14): converts a TRIALING subscription, or (no live subscription) opens a new ACTIVE row for a reopened
 * society. First period starts today; module 06 `issuePeriodInvoice` runs in the same transaction.
 */
export async function startPaid(
  ctx: Ctx,
  input: StartPaidInput,
  t: Transaction,
): Promise<{ subscriptionId: number; invoice: PlatformInvoiceDto | null }> {
  const { society, sub: live } = await lockSocietyAndSub(input.societyId, t);
  if (live && live.status !== 'TRIALING') throw invalidState('The subscription is already paid');
  if (live && input.version !== undefined) checkVersion(live, input.version);
  const planKey =
    input.planKey ?? (live ? await planCodeOfVersion(live.planVersionId, t) : undefined) ?? 'STANDARD';
  const plan = await planByCode(planKey, t);
  await assertSelectable(plan);
  const v = await currentVersion(plan, t);
  if (planKey === 'ENTERPRISE' && !input.customPricePerFlatPaise && !live?.customPricePerFlatPaise)
    throw new UnprocessableError('CUSTOM_PRICE_REQUIRED', 'Enterprise needs a custom price per flat');
  const conflicts = await limitConflicts(input.societyId, v, t);
  if (conflicts.length) throw conflictError(conflicts, plan.name);

  const today = todayOf(society);
  const anchor = parseYmd(today).d;
  const period = periodFrom(today, anchor, monthsOf(input.billingCycle));
  const flats = await flatsCount(input.societyId, t);
  const sub =
    live ??
    Subscription.build({
      societyId: input.societyId,
      planId: plan.id!,
      planVersionId: v.id!,
      status: 'ACTIVE',
      statusReason: 'PAID_START',
      statusChangedAt: now(),
      billingCycle: input.billingCycle,
      trialEndsAt: null,
      paidStartedAt: null,
      billingAnchorDay: anchor,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      lastInvoicedPeriodStart: null,
      billableFlats: flats,
      flatSegments: null,
      previousPeriod: null,
      customPricePerFlatPaise: null,
      customMinFlats: null,
      pendingPlanVersionId: null,
      pendingChangeType: null,
      pendingChangeAt: null,
      pendingPostponements: 0,
      pendingBillingCycle: null,
      downgradedFromPlanVersionId: null,
      downgradedAt: null,
      cancelAtPeriodEnd: false,
      cancelRequestedBy: null,
      cancelReason: null,
      cancelledAt: null,
      autopayStatus: 'NONE',
      autopayMethod: null,
      autopayMandateRef: null,
      autopayMaxAmountPaise: null,
      createdBy: actorId(ctx),
      updatedBy: actorId(ctx),
      version: 0,
    });
  if (!live) await ensureAbsoluteCounters(input.societyId, t);
  const before = live ? { status: live.status, planVersionId: live.planVersionId } : null;
  sub.planId = plan.id!;
  sub.planVersionId = v.id!;
  sub.status = 'ACTIVE';
  sub.statusReason = 'PAID_START';
  sub.statusChangedAt = now();
  sub.paidStartedAt = now();
  sub.billingCycle = input.billingCycle;
  sub.billingAnchorDay = anchor;
  sub.currentPeriodStart = period.periodStart;
  sub.currentPeriodEnd = period.periodEnd;
  sub.billableFlats = flats;
  if (input.customPricePerFlatPaise) sub.customPricePerFlatPaise = input.customPricePerFlatPaise;
  sub.flatSegments = [{ fromDate: today, toDate: null, billableFlats: chargedOf(sub, v, flats) }];
  sub.pendingPlanVersionId = null;
  sub.pendingChangeType = null;
  sub.pendingChangeAt = null;
  sub.pendingBillingCycle = null;
  sub.updatedBy = actorId(ctx);
  sub.version += 1;
  await sub.save({ transaction: t });
  const invoice = await integrations().billing.issuePeriodInvoice(
    ctx,
    { subscriptionId: sub.id!, periodStart: period.periodStart },
    t,
  );
  if (invoice) {
    sub.lastInvoicedPeriodStart = period.periodStart;
    await sub.save({ transaction: t });
  }
  await auditSub(
    ctx,
    sub,
    'paid_started',
    {
      before,
      after: { planCode: planKey, billingCycle: input.billingCycle, periodStart: period.periodStart },
    },
    t,
  );
  notifyViewers(t, sub.societyId, 'subscription.paid_started', {
    societyName: society.name,
    planName: plan.name,
    billingCycle: input.billingCycle,
  });
  emitSubscriptionUpdated(t, sub, planKey);
  invalidate(sub.societyId, t);
  return { subscriptionId: sub.id!, invoice };
}

/** Assisted create (module 05): TRIAL as `createTrial`, ACTIVE as a paid start. */
export async function createInitial(
  ctx: Ctx,
  input: {
    societyId: number;
    planKey: PlanCode;
    billingCycle: BillingCycle;
    startAs: 'TRIAL' | 'ACTIVE';
    trialEndsAt?: Date;
    customPricePerFlatPaise?: number;
  },
  t: Transaction,
): Promise<{ subscriptionId: number; invoice: PlatformInvoiceDto | null }> {
  if (input.startAs === 'TRIAL') {
    const r = await createTrial(
      input.societyId,
      input.planKey,
      input.trialEndsAt ?? addDays(now(), 14),
      t,
      ctx,
    );
    return { ...r, invoice: null };
  }
  return startPaid(ctx, input, t);
}

/** Mirror of module 05's trial end; no-op unless TRIALING. */
export async function extendTrial(societyId: number, trialEndsAt: Date, t: Transaction): Promise<void> {
  const { sub } = await lockSocietyAndSub(societyId, t);
  if (!sub || sub.status !== 'TRIALING') return;
  const before = { trialEndsAt: sub.trialEndsAt };
  sub.trialEndsAt = trialEndsAt;
  sub.version += 1;
  await sub.save({ transaction: t });
  await auditSub(SYSTEM, sub, 'trial_extended', { before, after: { trialEndsAt } }, t);
  invalidate(societyId, t);
}

async function cancelNow(
  ctx: Ctx,
  sub: Subscription,
  reason: 'CANCELLED_AT_PERIOD_END' | 'TRIAL_CANCELLED' | 'SOCIETY_CLOSED',
  t: Transaction,
): Promise<void> {
  for (const a of await SubscriptionAddon.findAll({
    where: { subscriptionId: sub.id!, status: { [Op.ne]: 'ENDED' } },
    transaction: t,
    lock: t.LOCK.UPDATE,
  }))
    await endAddon(ctx, a, 'SUBSCRIPTION_CANCELLED', t);
  const before = { status: sub.status, statusReason: sub.statusReason };
  sub.status = 'CANCELLED';
  sub.statusReason = reason;
  sub.statusChangedAt = now();
  sub.cancelledAt = now();
  sub.cancelAtPeriodEnd = false;
  if (sub.autopayStatus !== 'NONE') sub.autopayStatus = 'CANCELLED';
  sub.pendingPlanVersionId = null;
  sub.pendingChangeType = null;
  sub.pendingChangeAt = null;
  sub.pendingBillingCycle = null;
  sub.version += 1;
  await sub.save({ transaction: t });
  await auditSub(ctx, sub, 'cancelled', { before, after: { status: 'CANCELLED', statusReason: reason } }, t);
  notifyViewers(t, sub.societyId, 'subscription.cancelled');
  emitSubscriptionUpdated(t, sub, await planCodeOfVersion(sub.planVersionId, t));
  invalidate(sub.societyId, t);
}

/** Module 05 closes a society: live subscription → CANCELLED (SOCIETY_CLOSED). No-op without one. */
export async function cancelForClosure(ctx: Ctx, societyId: number, t: Transaction): Promise<void> {
  const { sub } = await lockSocietyAndSub(societyId, t);
  if (!sub) return;
  await cancelNow(ctx, sub, 'SOCIETY_CLOSED', t);
}

/** Module 14 calls this when a `SUBSCRIPTION_CANCEL` request is approved (BR-04-25). */
export async function applyCancellation(
  ctx: Ctx,
  input: { subscriptionId: number; requestedBy: number; reason: string },
  t: Transaction,
): Promise<void> {
  const pre = await Subscription.findByPk(input.subscriptionId, { transaction: t });
  if (!pre) throw subscriptionNotFound();
  const { sub } = await lockSocietyAndSub(pre.societyId, t);
  if (!sub || sub.id !== pre.id) throw invalidState('The subscription is already cancelled');
  if (sub.status === 'TRIALING') {
    sub.cancelRequestedBy = input.requestedBy;
    sub.cancelReason = input.reason;
    await cancelNow(ctx, sub, 'TRIAL_CANCELLED', t);
    await integrations().lifecycle.closeForSubscriptionCancellation(sub.societyId, sub.id!, t);
    return;
  }
  if (sub.cancelAtPeriodEnd)
    throw new ConflictError('CANCEL_ALREADY_SCHEDULED', 'Cancellation is already scheduled');
  sub.cancelAtPeriodEnd = true;
  sub.cancelRequestedBy = input.requestedBy;
  sub.cancelReason = input.reason;
  sub.version += 1;
  await sub.save({ transaction: t });
  await auditSub(
    ctx,
    sub,
    'cancel_scheduled',
    { after: { cancelAtPeriodEnd: true }, reason: input.reason },
    t,
  );
  notifyViewers(
    t,
    sub.societyId,
    'subscription.cancel_scheduled',
    { periodEnd: sub.currentPeriodEnd },
    'dashboard.today.view',
  );
  emitSubscriptionUpdated(t, sub, await planCodeOfVersion(sub.planVersionId, t));
}

// ------------------------------------------------------------------ module 05 / 07 reads
export async function summaryForSocieties(societyIds: number[]): Promise<
  Map<
    number,
    {
      planKey: PlanCode;
      planName: string;
      status: SubscriptionStatus;
      billingCycle: BillingCycle;
      mrrPaise: number;
      currentPeriodEnd: string | null;
    }
  >
> {
  const out = new Map();
  if (!societyIds.length) return out;
  const subs = await Subscription.findAll({
    where: { societyId: societyIds, status: { [Op.ne]: 'CANCELLED' } },
    include: [{ model: Plan }, { model: PlanVersion, as: 'planVersion' }],
  });
  for (const s of subs) {
    const plan = (s as unknown as { Plan: Plan }).Plan;
    const v = (s as unknown as { planVersion: PlanVersion }).planVersion;
    out.set(s.societyId, {
      planKey: plan.code,
      planName: plan.name,
      status: s.status,
      billingCycle: s.billingCycle,
      mrrPaise: mrrOf(s, v),
      currentPeriodEnd: s.currentPeriodEnd,
    });
  }
  return out;
}

/** Monthly-equivalent revenue of a live, non-trial subscription (section 8.2.1). */
export function mrrOf(s: Subscription, v: PlanVersion): number {
  if (s.status !== 'ACTIVE') return 0;
  return monthlyEquivalent(periodValueOf(s, v, s.billableFlats, s.billingCycle), s.billingCycle);
}

export async function societyIdsByPlan(planKey: PlanCode): Promise<number[]> {
  const plan = await planByCode(planKey);
  const rows = await Subscription.findAll({
    where: { planId: plan.id!, status: { [Op.ne]: 'CANCELLED' } },
    attributes: ['societyId'],
  });
  return rows.map(r => r.societyId);
}

export async function hasPaidSubscription(societyId: number, t?: Transaction): Promise<boolean> {
  return (await Subscription.count({ where: { societyId, status: 'ACTIVE' }, transaction: t })) > 0;
}

// ------------------------------------------------------------------ change plan (6.4, BR-04-8 to BR-04-10)
export interface ChangePlanInput {
  planCode: PlanCode;
  version: number;
  /** Platform only. */
  timing?: 'IMMEDIATE' | 'PERIOD_END';
  customPricePerFlatPaise?: number;
  customMinFlats?: number;
  skipLimitCheck?: boolean;
  reason?: string;
}
export interface ChangePlanResult {
  effect: 'IMMEDIATE' | 'SCHEDULED';
  planCode: PlanCode;
  effectiveDate: string;
  proration: Proration | null;
  invoiceId: number | null;
  version: number;
}

export async function changePlan(
  ctx: Ctx,
  societyId: number,
  input: ChangePlanInput,
  actor: 'SOCIETY' | 'PLATFORM',
  expectSubscriptionId?: number,
): Promise<ChangePlanResult> {
  return sequelize.transaction(async t => {
    const { society, sub } = await lockSocietyAndSub(societyId, t);
    if (!sub || (expectSubscriptionId && sub.id !== expectSubscriptionId)) throw subscriptionNotFound();
    checkVersion(sub, input.version);
    if (sub.cancelAtPeriodEnd) throw invalidState('Cancellation is scheduled; withdraw it first');
    const target = await planByCode(input.planCode, t);
    if (actor === 'SOCIETY' && input.planCode === 'ENTERPRISE')
      throw new UnprocessableError('PLAN_NOT_SELF_SERVE', 'Enterprise is set up by the SocietyApp team');
    await assertSelectable(target);
    const fromCode = await planCodeOfVersion(sub.planVersionId, t);
    const fromVersion = await versionById(sub.planVersionId, t);
    const fromPlan = await planByCode(fromCode, t);
    if (input.planCode === fromCode) throw new UnprocessableError('SAME_PLAN', 'This is already your plan');
    if (input.customMinFlats !== undefined && input.planCode !== 'ENTERPRISE')
      throw new UnprocessableError('CUSTOM_PRICE_NOT_ALLOWED', 'A custom minimum applies to Enterprise only');
    if (input.planCode === 'ENTERPRISE' && !input.customPricePerFlatPaise && !sub.customPricePerFlatPaise)
      throw new UnprocessableError('CUSTOM_PRICE_REQUIRED', 'Enterprise needs a custom price per flat');
    if (input.customPricePerFlatPaise !== undefined && input.planCode !== 'ENTERPRISE')
      throw new UnprocessableError('CUSTOM_PRICE_NOT_ALLOWED', 'A custom price applies to Enterprise only');
    const v = await currentVersion(target, t);
    const upgrade = PLAN_RANK[input.planCode] > PLAN_RANK[fromCode];
    const today = todayOf(society);
    const before = { planCode: fromCode, planVersionId: sub.planVersionId, version: sub.version };

    const applyCustom = (): void => {
      if (input.planCode === 'ENTERPRISE') {
        if (input.customPricePerFlatPaise) sub.customPricePerFlatPaise = input.customPricePerFlatPaise;
        if (input.customMinFlats) sub.customMinFlats = input.customMinFlats;
      } else if (fromCode === 'ENTERPRISE') {
        sub.customPricePerFlatPaise = null;
        sub.customMinFlats = null;
      }
    };

    // trial: switch the trial plan now, any direction, no charge (hard-limit conflicts still block a lower plan)
    if (sub.status === 'TRIALING') {
      if (!upgrade) {
        const c = await limitConflicts(societyId, v, t);
        if (c.length) throw conflictError(c, target.name);
      }
      sub.planId = target.id!;
      sub.planVersionId = v.id!;
      sub.pendingPlanVersionId = null;
      sub.pendingChangeType = null;
      sub.pendingChangeAt = null;
      applyCustom();
      sub.updatedBy = actorId(ctx);
      sub.version += 1;
      await sub.save({ transaction: t });
      await endAddonsForPlan(ctx, sub, v, { upgrade }, t);
      await auditSub(
        ctx,
        sub,
        upgrade ? 'upgraded' : 'downgrade_applied',
        {
          before,
          after: { planCode: input.planCode, trial: true },
          reason: input.reason ?? null,
        },
        t,
      );
      emitSubscriptionUpdated(t, sub, input.planCode);
      invalidate(societyId, t);
      return {
        effect: 'IMMEDIATE',
        planCode: input.planCode,
        effectiveDate: today,
        proration: null,
        invoiceId: null,
        version: sub.version,
      };
    }
    if (sub.status !== 'ACTIVE') throw invalidState();

    const immediate = upgrade
      ? input.timing !== 'PERIOD_END'
      : actor === 'PLATFORM' && input.timing === 'IMMEDIATE';
    if (!upgrade && !(input.skipLimitCheck && input.timing !== 'IMMEDIATE' && actor === 'PLATFORM')) {
      const c = await limitConflicts(societyId, v, t);
      if (c.length) throw conflictError(c, target.name);
    }

    if (!immediate) {
      // downgrade (or platform upgrade at period end): scheduled for the next period start (BR-04-9, BR-04-10)
      const at = addDaysYmd(sub.currentPeriodEnd!, 1);
      sub.pendingPlanVersionId = v.id!;
      sub.pendingChangeType = 'DOWNGRADE';
      sub.pendingChangeAt = at;
      sub.pendingPostponements = 0;
      if (input.planCode === 'ENTERPRISE') applyCustom();
      sub.updatedBy = actorId(ctx);
      sub.version += 1;
      await sub.save({ transaction: t });
      const conflictsSkipped = input.skipLimitCheck ? await limitConflicts(societyId, v, t) : [];
      await auditSub(
        ctx,
        sub,
        'downgrade_scheduled',
        {
          before,
          after: {
            planCode: input.planCode,
            at,
            ...(conflictsSkipped.length ? { limitConflicts: conflictsSkipped } : {}),
          },
          reason: input.reason ?? null,
        },
        t,
      );
      notifyViewers(t, societyId, 'subscription.downgrade_scheduled', {
        planName: target.name,
        effectiveDate: at,
      });
      emitSubscriptionUpdated(t, sub, fromCode);
      invalidate(societyId, t);
      return {
        effect: 'SCHEDULED',
        planCode: input.planCode,
        effectiveDate: at,
        proration: null,
        invoiceId: null,
        version: sub.version,
      };
    }

    // immediate change (upgrade, or platform immediate downgrade with no refund)
    const flats = await flatsCount(societyId, t);
    const oldValue = periodValueOf(sub, fromVersion, flats, sub.billingCycle);
    sub.planId = target.id!;
    sub.planVersionId = v.id!;
    sub.pendingPlanVersionId = null;
    sub.pendingChangeType = null;
    sub.pendingChangeAt = null;
    sub.pendingPostponements = 0;
    applyCustom();
    if (!upgrade) {
      sub.downgradedFromPlanVersionId = fromVersion.id!;
      sub.downgradedAt = now();
    } else {
      sub.downgradedFromPlanVersionId = null;
      sub.downgradedAt = null;
    }
    const newValue = periodValueOf(sub, v, flats, sub.billingCycle);
    recordSegment(sub, today, chargedOf(sub, v, flats));
    sub.billableFlats = flats;
    sub.updatedBy = actorId(ctx);
    sub.version += 1;
    await sub.save({ transaction: t });
    const ended = await endAddonsForPlan(ctx, sub, v, { upgrade }, t);
    let pr: Proration | null = null;
    let invoiceId: number | null = null;
    if (upgrade) {
      pr = proration(today, sub.currentPeriodStart!, sub.currentPeriodEnd!, oldValue, newValue);
      const inv = await integrations().billing.issueProrationInvoice(
        ctx,
        {
          subscriptionId: sub.id!,
          changeRef: `UPGRADE:${sub.id}:${sub.version}`,
          effectiveDate: today,
          items: [
            {
              label: `${fromPlan.name} to ${target.name}`,
              planVersionId: v.id!,
              fromPeriodValuePaise: oldValue,
              toPeriodValuePaise: newValue,
            },
          ],
        },
        t,
      );
      invoiceId = inv?.id ?? null;
    }
    await auditSub(
      ctx,
      sub,
      upgrade ? 'upgraded' : 'downgrade_applied',
      {
        before,
        after: { planCode: input.planCode, proration: pr, invoiceId, addonsEnded: ended },
        reason: input.reason ?? null,
      },
      t,
    );
    if (upgrade) notifyViewers(t, societyId, 'subscription.plan_upgraded', { planName: target.name });
    else
      notifyViewers(t, societyId, 'subscription.downgrade_applied', {
        planName: target.name,
        readOnlyUntil: localDate(addDays(now(), READ_GRACE_DAYS), society.timezone),
      });
    emitSubscriptionUpdated(t, sub, input.planCode);
    invalidate(societyId, t);
    return {
      effect: 'IMMEDIATE',
      planCode: input.planCode,
      effectiveDate: today,
      proration: pr,
      invoiceId,
      version: sub.version,
    };
  });
}

// ------------------------------------------------------------------ cycle, pending change, cancellation (society)
export async function scheduleCycle(
  ctx: Ctx,
  societyId: number,
  input: { billingCycle: BillingCycle | null; version: number; reason?: string },
  expectSubscriptionId?: number,
): Promise<{ pendingBillingCycle: BillingCycle | null; effectiveDate: string | null; version: number }> {
  return sequelize.transaction(async t => {
    const { sub } = await lockSocietyAndSub(societyId, t);
    if (!sub || (expectSubscriptionId && sub.id !== expectSubscriptionId)) throw subscriptionNotFound();
    checkVersion(sub, input.version);
    if (sub.status !== 'ACTIVE') throw invalidState('The billing cycle is chosen when the paid plan starts');
    const target = input.billingCycle === sub.billingCycle ? null : input.billingCycle;
    if (target === sub.pendingBillingCycle)
      throw new UnprocessableError('SAME_BILLING_CYCLE', 'This is already the billing cycle');
    const before = { pendingBillingCycle: sub.pendingBillingCycle };
    sub.pendingBillingCycle = target;
    sub.updatedBy = actorId(ctx);
    sub.version += 1;
    await sub.save({ transaction: t });
    await auditSub(
      ctx,
      sub,
      'cycle_change_scheduled',
      { before, after: { pendingBillingCycle: target }, reason: input.reason ?? null },
      t,
    );
    emitSubscriptionUpdated(t, sub, await planCodeOfVersion(sub.planVersionId, t));
    return {
      pendingBillingCycle: target,
      effectiveDate: target ? addDaysYmd(sub.currentPeriodEnd!, 1) : null,
      version: sub.version,
    };
  });
}

export async function cancelPendingChange(
  ctx: Ctx,
  societyId: number,
  input: { type: 'PLAN' | 'CYCLE'; version: number },
): Promise<void> {
  await sequelize.transaction(async t => {
    const { sub } = await lockSocietyAndSub(societyId, t);
    if (!sub) throw subscriptionNotFound();
    checkVersion(sub, input.version);
    const before = {
      pendingPlanVersionId: sub.pendingPlanVersionId,
      pendingChangeType: sub.pendingChangeType,
      pendingBillingCycle: sub.pendingBillingCycle,
    };
    if (input.type === 'PLAN') {
      if (!sub.pendingPlanVersionId)
        throw new ConflictError('NO_PENDING_CHANGE', 'No plan change is scheduled');
      if (sub.pendingChangeType === 'VERSION_MIGRATION')
        throw new ConflictError(
          'MIGRATION_NOT_CANCELLABLE',
          'A platform price migration cannot be cancelled here',
        );
      sub.pendingPlanVersionId = null;
      sub.pendingChangeType = null;
      sub.pendingChangeAt = null;
      sub.pendingPostponements = 0;
    } else {
      if (!sub.pendingBillingCycle)
        throw new ConflictError('NO_PENDING_CHANGE', 'No billing cycle change is scheduled');
      sub.pendingBillingCycle = null;
    }
    sub.updatedBy = actorId(ctx);
    sub.version += 1;
    await sub.save({ transaction: t });
    await auditSub(ctx, sub, 'pending_change_cancelled', { before, after: { type: input.type } }, t);
    emitSubscriptionUpdated(t, sub, await planCodeOfVersion(sub.planVersionId, t));
  });
}

/** `POST /subscription/cancel`: a module 14 approval request (BR-04-25). */
export async function requestCancellation(
  ctx: Ctx,
  societyId: number,
  input: { reason: string; version: number },
): Promise<{ approvalRequestId: number }> {
  return sequelize.transaction(async t => {
    const { sub } = await lockSocietyAndSub(societyId, t);
    if (!sub) throw subscriptionNotFound();
    checkVersion(sub, input.version);
    if (sub.cancelAtPeriodEnd)
      throw new ConflictError('CANCEL_ALREADY_SCHEDULED', 'Cancellation is already scheduled');
    return integrations().approvals.createRequest(
      ctx,
      {
        type: 'SUBSCRIPTION_CANCEL',
        societyId,
        subscriptionId: sub.id!,
        requestedBy: ctx.user!.id,
        reason: input.reason,
        approverPermission: 'settings.subscription.edit',
      },
      t,
    );
  });
}

export async function withdrawCancellation(
  ctx: Ctx,
  societyId: number,
  input: { version: number },
): Promise<{ version: number }> {
  return sequelize.transaction(async t => {
    const { society, sub } = await lockSocietyAndSub(societyId, t);
    if (!sub) throw subscriptionNotFound();
    checkVersion(sub, input.version);
    if (!sub.cancelAtPeriodEnd) throw new ConflictError('NO_PENDING_CHANGE', 'No cancellation is scheduled');
    if (sub.currentPeriodEnd && sub.currentPeriodEnd < todayOf(society))
      throw invalidState('The period has ended');
    sub.cancelAtPeriodEnd = false;
    sub.cancelRequestedBy = null;
    sub.cancelReason = null;
    sub.updatedBy = actorId(ctx);
    sub.version += 1;
    await sub.save({ transaction: t });
    await auditSub(
      ctx,
      sub,
      'cancel_withdrawn',
      { before: { cancelAtPeriodEnd: true }, after: { cancelAtPeriodEnd: false } },
      t,
    );
    emitSubscriptionUpdated(t, sub, await planCodeOfVersion(sub.planVersionId, t));
    return { version: sub.version };
  });
}

// ------------------------------------------------------------------ module 08: flats (BR-04-12)
export async function onFlatCountChanged(ctx: Ctx, societyId: number, t: Transaction): Promise<void> {
  const { society, sub } = await lockSocietyAndSub(societyId, t);
  if (!sub) return;
  const flats = await flatsCount(societyId, t);
  if (flats === sub.billableFlats && sub.status !== 'ACTIVE') return;
  const before = { billableFlats: sub.billableFlats };
  sub.billableFlats = flats;
  if (sub.status === 'ACTIVE') {
    const v = await versionById(sub.planVersionId, t);
    recordSegment(sub, todayOf(society), chargedOf(sub, v, flats));
  }
  sub.version += 1;
  await sub.save({ transaction: t });
  await auditSub(ctx, sub, 'flats_changed', { before, after: { billableFlats: flats } }, t);
  invalidate(societyId, t);
}

// ------------------------------------------------------------------ renewal (6.5)
/** One renewal step for an ACTIVE subscription whose period ended. Returns true when it renewed or cancelled. */
export async function renewOnce(subscriptionId: number, ctx: Ctx = SYSTEM): Promise<boolean> {
  return sequelize.transaction(async t => {
    const pre = await Subscription.findByPk(subscriptionId, { transaction: t });
    if (!pre) return false;
    const { society, sub } = await lockSocietyAndSub(pre.societyId, t);
    if (!sub || sub.id !== pre.id || sub.status !== 'ACTIVE') return false;
    const today = todayOf(society);
    if (!sub.currentPeriodEnd || sub.currentPeriodEnd >= today) return false;

    if (sub.cancelAtPeriodEnd) {
      await cancelNow(ctx, sub, 'CANCELLED_AT_PERIOD_END', t);
      await integrations().lifecycle.closeForSubscriptionCancellation(sub.societyId, sub.id!, t);
      return true;
    }
    const oldVersion = await versionById(sub.planVersionId, t);
    const months = monthsOf(sub.billingCycle);
    const segments = (sub.flatSegments ?? []).map(s => ({ ...s, toDate: s.toDate ?? sub.currentPeriodEnd! }));
    const previous: PreviousPeriod = {
      periodStart: sub.currentPeriodStart!,
      periodEnd: sub.currentPeriodEnd,
      months,
      freeMonths: freeMonthsFor(sub.billingCycle, oldVersion.annualFreeMonths),
      pricePerFlatPerMonthPaise: priceOf(sub, oldVersion),
      planVersionId: oldVersion.id!,
      flatSegments: segments,
    };
    const newStart = addDaysYmd(sub.currentPeriodEnd, 1);
    const before = {
      planVersionId: sub.planVersionId,
      billingCycle: sub.billingCycle,
      periodEnd: sub.currentPeriodEnd,
    };
    let switchedTo: PlanVersion | null = null;

    if (sub.pendingPlanVersionId && sub.pendingChangeAt && sub.pendingChangeAt <= newStart) {
      const target = await versionById(sub.pendingPlanVersionId, t);
      const targetCode = await planCodeOfVersion(target.id!, t);
      const targetPlan = await planByCode(targetCode, t);
      if (sub.pendingChangeType === 'DOWNGRADE') {
        const c = await limitConflicts(sub.societyId, target, t);
        if (c.length) {
          if (sub.pendingPostponements >= 2) {
            sub.pendingPlanVersionId = null;
            sub.pendingChangeType = null;
            sub.pendingChangeAt = null;
            sub.pendingPostponements = 0;
          } else {
            sub.pendingPostponements += 1;
            sub.pendingChangeAt = addDaysYmd(periodFrom(newStart, sub.billingAnchorDay, months).periodEnd, 1);
          }
          await auditSub(
            ctx,
            sub,
            'downgrade_postponed',
            { after: { limitConflicts: c, postponements: sub.pendingPostponements } },
            t,
          );
          notifyViewers(t, sub.societyId, 'subscription.downgrade_blocked', {
            planName: targetPlan.name,
            conflicts: c.map(x => `${x.limitKey}: ${x.used} of ${x.targetLimit}`).join(', '),
          });
        } else {
          sub.downgradedFromPlanVersionId = sub.planVersionId;
          sub.downgradedAt = now();
          switchedTo = target;
          await auditSub(
            ctx,
            sub,
            'downgrade_applied',
            { before: { planVersionId: sub.planVersionId }, after: { planVersionId: target.id } },
            t,
          );
          notifyViewers(t, sub.societyId, 'subscription.downgrade_applied', {
            planName: targetPlan.name,
            readOnlyUntil: localDate(addDays(now(), READ_GRACE_DAYS), society.timezone),
          });
        }
      } else {
        switchedTo = target;
        await auditSub(
          ctx,
          sub,
          'migrated',
          { before: { planVersionId: sub.planVersionId }, after: { planVersionId: target.id } },
          t,
        );
      }
      if (switchedTo) {
        sub.planId = targetPlan.id!;
        sub.planVersionId = switchedTo.id!;
        sub.pendingPlanVersionId = null;
        sub.pendingChangeType = null;
        sub.pendingChangeAt = null;
        sub.pendingPostponements = 0;
        if (targetCode !== 'ENTERPRISE') {
          sub.customPricePerFlatPaise = null;
          sub.customMinFlats = null;
        }
      }
    }
    if (sub.pendingBillingCycle) {
      sub.billingCycle = sub.pendingBillingCycle;
      sub.pendingBillingCycle = null;
      await auditSub(
        ctx,
        sub,
        'cycle_changed',
        { before: { billingCycle: before.billingCycle }, after: { billingCycle: sub.billingCycle } },
        t,
      );
      notifyViewers(t, sub.societyId, 'subscription.cycle_changed', { billingCycle: sub.billingCycle });
    }
    // add-ons whose cancellation date passed, and those the (new) plan no longer allows
    const periodEndAt = zonedDayStart(newStart, society.timezone);
    for (const a of await SubscriptionAddon.findAll({
      where: { subscriptionId: sub.id!, status: { [Op.ne]: 'ENDED' }, endsAt: { [Op.lte]: periodEndAt } },
      transaction: t,
      lock: t.LOCK.UPDATE,
    }))
      await endAddon(ctx, a, a.billingType === 'ONE_TIME' ? 'EXPIRED' : 'CANCELLED', t);
    if (switchedTo) await endAddonsForPlan(ctx, sub, switchedTo, { upgrade: false }, t);

    const v = switchedTo ?? oldVersion;
    const period = periodFrom(newStart, sub.billingAnchorDay, monthsOf(sub.billingCycle));
    const flats = await flatsCount(sub.societyId, t);
    sub.previousPeriod = previous;
    sub.currentPeriodStart = period.periodStart;
    sub.currentPeriodEnd = period.periodEnd;
    sub.billableFlats = flats;
    sub.flatSegments = [
      { fromDate: period.periodStart, toDate: null, billableFlats: chargedOf(sub, v, flats) },
    ];
    sub.version += 1;
    await sub.save({ transaction: t });
    const invoice = await integrations().billing.issuePeriodInvoice(
      ctx,
      { subscriptionId: sub.id!, periodStart: period.periodStart },
      t,
    );
    if (invoice) {
      sub.lastInvoicedPeriodStart = period.periodStart;
      await sub.save({ transaction: t });
    }
    await auditSub(
      ctx,
      sub,
      'renewed',
      {
        before,
        after: {
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          planVersionId: sub.planVersionId,
        },
      },
      t,
    );
    emitSubscriptionUpdated(t, sub, await planCodeOfVersion(sub.planVersionId, t));
    invalidate(sub.societyId, t);
    return true;
  });
}

/** Renews until the current period contains today (a society that missed several runs catches up). */
export async function renewIfDue(subscriptionId: number, ctx: Ctx = SYSTEM): Promise<number> {
  let n = 0;
  while (n < 40 && (await renewOnce(subscriptionId, ctx))) n += 1;
  return n;
}

/** Job `subscriptions:renewals`. */
export async function runRenewals(): Promise<number> {
  const due = await Subscription.findAll({
    where: { status: 'ACTIVE', currentPeriodEnd: { [Op.lt]: localDate(now()) } },
    attributes: ['id'],
  });
  let n = 0;
  for (const d of due) {
    try {
      n += await renewIfDue(d.id!);
    } catch (err) {
      logger.error({ err, subscriptionId: d.id }, 'renewal failed');
    }
  }
  return n;
}

// ------------------------------------------------------------------ module 06 functions (8.9)
export async function listDueForInvoicing(
  todayIst: string,
): Promise<{ subscriptionId: number; periodStart: string }[]> {
  const due = await Subscription.findAll({
    where: { status: 'ACTIVE', currentPeriodEnd: { [Op.lt]: todayIst } },
    attributes: ['id'],
  });
  for (const d of due) await renewIfDue(d.id!);
  const rows = await Subscription.findAll({
    where: {
      status: 'ACTIVE',
      currentPeriodStart: { [Op.lte]: todayIst },
      [Op.or]: [
        { currentPeriodStart: { [Op.gte]: addDaysYmd(todayIst, -7) } },
        { lastInvoicedPeriodStart: null },
        { lastInvoicedPeriodStart: { [Op.lt]: sequelize.col('currentPeriodStart') } },
      ],
    },
    attributes: ['id', 'currentPeriodStart'],
    order: [['id', 'ASC']],
  });
  return rows.map(r => ({ subscriptionId: r.id!, periodStart: r.currentPeriodStart! }));
}

export async function getBillingSnapshot(subscriptionId: number, periodStart: string) {
  const sub = await Subscription.findByPk(subscriptionId);
  if (!sub) throw subscriptionNotFound();
  if (sub.currentPeriodStart !== periodStart)
    throw invalidState('The snapshot is only for the current period');
  const v = await versionById(sub.planVersionId);
  const plan = await planByCode(await planCodeOfVersion(v.id!));
  const addons = await SubscriptionAddon.findAll({
    where: {
      subscriptionId,
      billingType: 'RECURRING',
      status: ['ACTIVE', 'CANCEL_SCHEDULED'],
      [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: zonedDayStart(periodStart) } }],
    },
    include: [{ model: Addon, attributes: ['name'] }],
  });
  let previousPeriod = null;
  if (sub.previousPeriod) {
    await closeUsageMonths(sub.societyId);
    const pv = sub.previousPeriod;
    const rows = await loadVersionRows(pv.planVersionId);
    const counters = await UsageCounter.findAll({
      where: {
        societyId: sub.societyId,
        periodKey: { [Op.gte]: pv.periodStart, [Op.lte]: pv.periodEnd, [Op.ne]: 'ALL' },
        cycleAtClose: 'MONTHLY',
      },
    });
    const overages = LIMITS.filter(l => l.enforcement === 'SOFT')
      .map(l => ({
        limitKey: l.key,
        label: l.overageLabel ?? l.title,
        quantity: counters.filter(c => c.limitKey === l.key).reduce((a, c) => a + Number(c.overageUnits), 0),
        unitPricePaise: rows.limits[l.key]?.overagePricePaise ?? l.overage?.pricePaise ?? 0,
      }))
      .filter(o => o.quantity > 0);
    previousPeriod = {
      periodStart: pv.periodStart,
      periodEnd: pv.periodEnd,
      months: pv.months,
      freeMonths: pv.freeMonths,
      pricePerFlatPerMonthPaise: pv.pricePerFlatPerMonthPaise,
      flatSegments: pv.flatSegments.map(s => ({
        fromDate: s.fromDate,
        toDate: s.toDate ?? pv.periodEnd,
        billableFlats: s.billableFlats,
      })),
      overages,
    };
  }
  return {
    societyId: sub.societyId,
    planKey: plan.code,
    planName: plan.name,
    planVersionId: v.id!,
    billingCycle: sub.billingCycle,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
    pricePerFlatPerMonthPaise: priceOf(sub, v),
    annualFreeMonths: sub.billingCycle === 'ANNUAL' ? v.annualFreeMonths : 0,
    billableFlats: sub.flatSegments?.[0]?.billableFlats ?? chargedOf(sub, v, sub.billableFlats),
    addons: addons.map(a => ({
      addonKey: a.addonCode,
      name: (a as unknown as { Addon: Addon }).Addon.name,
      quantity: a.quantity,
      monthlyPricePaise: Number(a.unitPricePaise),
    })),
    previousPeriod,
  };
}

/** BR-04-22: PENDING_PAYMENT packs of this invoice become ACTIVE for the current usage month. Safe to call twice. */
export async function onPlatformInvoicePaid(ctx: Ctx, invoiceId: number, t: Transaction): Promise<void> {
  const rows = await SubscriptionAddon.findAll({
    where: { invoiceId, status: 'PENDING_PAYMENT' },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const a of rows) {
    const sub = await Subscription.findByPk(a.subscriptionId, { transaction: t });
    const society = await Society.findByPk(a.societyId, { attributes: ['id', 'timezone'], transaction: t });
    if (!sub || sub.status === 'CANCELLED') continue;
    const month = usageMonth(todayOf(society), sub.billingAnchorDay);
    a.status = 'ACTIVE';
    a.periodKey = month.periodStart;
    a.endsAt = zonedDayStart(addDaysYmd(month.periodEnd, 1), society?.timezone);
    a.version += 1;
    await a.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'subscriptions.subscription_addon.activated',
        entityType: 'subscription_addon',
        entityId: a.id!,
        entityLabel: a.addonCode,
        societyId: a.societyId,
        after: { status: 'ACTIVE', periodKey: a.periodKey },
      },
      t,
    );
    notifyViewers(t, a.societyId, 'subscription.addon_activated', { addonCode: a.addonCode });
    invalidate(a.societyId, t);
  }
}

/** BR-04-31: only module 06, only while the flag `platform.autopay` is on. */
export async function setAutopay(
  ctx: Ctx,
  subscriptionId: number,
  input: {
    autopayStatus: AutopayStatus;
    autopayMethod?: 'UPI_AUTOPAY' | 'EMANDATE' | null;
    autopayMandateRef?: string | null;
    autopayMaxAmountPaise?: number | null;
  },
  t: Transaction,
): Promise<void> {
  if (!(await isFlagOn('platform.autopay'))) throw new NotFoundError('NOT_FOUND', 'Autopay is not available');
  const sub = await Subscription.findByPk(subscriptionId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!sub) throw subscriptionNotFound();
  const before = {
    autopayStatus: sub.autopayStatus,
    autopayMethod: sub.autopayMethod,
    autopayMaxAmountPaise: sub.autopayMaxAmountPaise,
  };
  sub.autopayStatus = input.autopayStatus;
  if (input.autopayMethod !== undefined) sub.autopayMethod = input.autopayMethod;
  if (input.autopayMandateRef !== undefined) sub.autopayMandateRef = input.autopayMandateRef;
  if (input.autopayMaxAmountPaise !== undefined) sub.autopayMaxAmountPaise = input.autopayMaxAmountPaise;
  sub.version += 1;
  await sub.save({ transaction: t });
  await auditSub(
    ctx,
    sub,
    'autopay_changed',
    { before, after: { autopayStatus: sub.autopayStatus, autopayMethod: sub.autopayMethod } },
    t,
  );
}

// ------------------------------------------------------------------ views shared by society and platform reads
export async function subscriptionView(sub: Subscription) {
  const v = await versionById(sub.planVersionId);
  const code = await planCodeOfVersion(v.id!);
  const plan = await planByCode(code);
  const ent = await getEntitlements(sub.societyId);
  const status = await integrations().lifecycle.getStatusInfo(sub.societyId);
  const pending = sub.pendingPlanVersionId
    ? {
        type: sub.pendingChangeType,
        planCode: await planCodeOfVersion(sub.pendingPlanVersionId),
        at: sub.pendingChangeAt,
      }
    : null;
  const addons = await SubscriptionAddon.findAll({
    where: { subscriptionId: sub.id!, status: { [Op.ne]: 'ENDED' } },
    order: [['id', 'ASC']],
  });
  const trial = await EntitlementOverride.findOne({
    where: {
      societyId: sub.societyId,
      source: 'PREMIUM_TRIAL',
      revokedAt: null,
      expiresAt: { [Op.gt]: now() },
      startsAt: { [Op.lte]: now() },
    },
  });
  const flats = sub.status === 'ACTIVE' ? sub.billableFlats : await flatsCount(sub.societyId);
  const periodValue = periodValueOf(sub, v, flats, sub.billingCycle);
  const autopayOn = await isFlagOn('platform.autopay');
  return {
    id: sub.id!,
    societyId: sub.societyId,
    status: sub.status,
    statusReason: sub.statusReason,
    version: sub.version,
    societyStatus: status.status,
    plan: {
      code,
      name: plan.name,
      versionNo: v.versionNo,
      pricePerFlatPaise: priceOf(sub, v),
      minBillableFlats: sub.customMinFlats ?? v.minBillableFlats,
      annualFreeMonths: v.annualFreeMonths,
    },
    billingCycle: sub.billingCycle,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    billableFlats: flats,
    chargedFlats: chargedOf(sub, v, flats),
    periodValuePaise: periodValue,
    monthlyEquivalentPaise: monthlyEquivalent(periodValue, sub.billingCycle),
    customPricePerFlatPaise:
      sub.customPricePerFlatPaise === null ? null : Number(sub.customPricePerFlatPaise),
    customMinFlats: sub.customMinFlats,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    pendingChange: pending,
    pendingBillingCycle: sub.pendingBillingCycle,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    readOnlyFeatures: ent.readOnlyFeatures,
    readOnlyUntil: ent.readOnlyUntil,
    activeAddons: addons.map(a => ({ id: a.id!, code: a.addonCode, quantity: a.quantity, status: a.status })),
    activeFeatureTrial: trial
      ? {
          featureKey: trial.entitlementKey,
          title: FEATURE_BY_KEY.get(trial.entitlementKey ?? '')?.title ?? trial.entitlementKey,
          startsAt: trial.startsAt.toISOString(),
          expiresAt: trial.expiresAt!.toISOString(),
        }
      : null,
    ...(autopayOn
      ? {
          autopay: {
            status: sub.autopayStatus,
            method: sub.autopayMethod,
            maxAmountPaise: sub.autopayMaxAmountPaise === null ? null : Number(sub.autopayMaxAmountPaise),
          },
        }
      : {}),
  };
}

export async function getSummary(societyId: number) {
  const sub = await liveSub(societyId);
  if (!sub) throw subscriptionNotFound();
  return subscriptionView(sub);
}

export const limitTitle = (key: string): string => LIMIT_BY_KEY.get(key)?.title ?? key;

export async function getSubscriptionById(subscriptionId: number): Promise<Subscription> {
  const s = await Subscription.findByPk(subscriptionId);
  if (!s) throw subscriptionNotFound();
  return s;
}
