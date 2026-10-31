import { Op, type Transaction, type WhereOptions } from 'sequelize';
import {
  Addon,
  AuditLog,
  EntitlementOverride,
  Plan,
  PlanVersion,
  Society,
  Subscription,
  SubscriptionAddon,
  UsageCounter,
  User,
  sequelize,
} from '../../models';
import { addDays, now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import {
  FEATURES,
  FEATURE_BY_KEY,
  LIMITS,
  LIMIT_BY_KEY,
  PLAN_RANK,
  type PlanCode,
} from './subscriptions.catalogue';
import {
  READ_GRACE_DAYS,
  canUnlock,
  counterLimit,
  featureAllowed,
  featureUsageProviders,
  flatsCount,
  getEntitlements,
  invalidate,
  loadVersionRows,
  periodKeyFor,
  planCodeOfVersion,
  versionLimit,
} from './entitlements.service';
import { clientFlags } from './flags.service';
import { integrations } from './subscriptions.integrations';
import {
  addDaysYmd,
  chargedFlats,
  freeMonthsFor,
  monthsOf,
  periodFrom,
  proration,
  usageMonth,
  zonedDayStart,
} from './pricing';
import { limitConflicts, startPaid, subscriptionView } from './subscriptions.service';
import { usageView } from './subscriptions.usage';
import {
  checkVersion,
  currentVersion,
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
import type { BillingCycle } from './subscriptions.types';

const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const requireLive = async (societyId: number): Promise<Subscription> => {
  const s = await liveSub(societyId);
  if (!s) throw subscriptionNotFound();
  return s;
};

// ------------------------------------------------------------------ 8.5.2 entitlements
export async function entitlementsView(ctx: Ctx) {
  const societyId = ctx.society!.id;
  const ent = await getEntitlements(societyId);
  const out: Record<string, unknown> = {
    planCode: ent.planCode,
    status: ent.status,
    generation: ent.generation,
    features: Object.entries(ent.features)
      .filter(([, v]) => v.on)
      .map(([k]) => k),
    readOnlyFeatures: ent.readOnlyFeatures,
    flags: await clientFlags(societyId),
  };
  if (ctx.permissions?.has('settings.subscription.view')) {
    const counters = await UsageCounter.findAll({ where: { societyId, periodKey: ['ALL', ent.usageMonth] } });
    out.limits = Object.fromEntries(
      LIMITS.map(l => {
        const period = periodKeyFor(ent, l.key);
        const used = Number(counters.find(c => c.limitKey === l.key && c.periodKey === period)?.used ?? 0);
        return [l.key, { limit: ent.limits[l.key]?.limit ?? 0, used, period }];
      }),
    );
  }
  return out;
}

// ------------------------------------------------------------------ 8.5.4 plans
export async function plansForSociety(societyId: number, cycle: BillingCycle) {
  const sub = await requireLive(societyId);
  const ent = await getEntitlements(societyId);
  const flats = await flatsCount(societyId);
  const currentCode = await planCodeOfVersion(sub.planVersionId);
  const plans = await Plan.findAll({
    where: { isActive: true, isPublic: true },
    order: [['tierRank', 'ASC']],
  });
  const items = [];
  for (const p of plans) {
    if (!p.currentVersionId) continue;
    const v = await versionById(p.currentVersionId);
    const rows = await loadVersionRows(v.id!);
    const isCurrent = p.code === currentCode;
    const selfServe = p.code !== 'ENTERPRISE';
    const priceSub = isCurrent ? sub : { customPricePerFlatPaise: null, customMinFlats: null };
    const charged = chargedFlats(flats, v.minBillableFlats, isCurrent ? sub.customMinFlats : null);
    const showPrice = selfServe || (isCurrent && sub.customPricePerFlatPaise);
    const value = showPrice ? periodValueOf(priceSub, v, flats, cycle) : null;
    items.push({
      code: p.code,
      name: p.name,
      description: p.description,
      isCurrent,
      isSelfServe: selfServe,
      pricePerFlatPaise: showPrice ? priceOf(priceSub, v) : null,
      chargedFlats: charged,
      minBillableFlats: v.minBillableFlats,
      annualFreeMonths: v.annualFreeMonths,
      periodPricePaise: value,
      monthlyEquivalentPaise: value === null ? null : monthlyEquivalent(value, cycle),
      highlights: {
        featureCount: FEATURES.filter(f => f.catalogueStatus === 'LIVE' && rows.features[f.key]).length,
        limits: Object.fromEntries(LIMITS.map(l => [l.key, versionLimit(rows, l.key, flats)])),
      },
    });
  }
  const out: { billingCycle: BillingCycle; items: typeof items; recommendation?: unknown } = {
    billingCycle: cycle,
    items,
  };
  if (featureAllowed(ent, 'platform.plan_advisor'))
    out.recommendation = await recommend(sub, currentCode, flats, ent);
  return out;
}

async function recommend(
  sub: Subscription,
  currentCode: PlanCode,
  flats: number,
  ent: Awaited<ReturnType<typeof getEntitlements>>,
) {
  const reasons: string[] = [];
  let rank = PLAN_RANK[currentCode];
  const trial = await EntitlementOverride.findOne({
    where: {
      societyId: sub.societyId,
      source: 'PREMIUM_TRIAL',
      revokedAt: null,
      expiresAt: { [Op.gt]: now() },
    },
  });
  const trialPlan = trial ? FEATURE_BY_KEY.get(trial.entitlementKey ?? '')?.minPlan : undefined;
  if (trialPlan && PLAN_RANK[trialPlan] > rank && trialPlan !== 'ENTERPRISE') {
    reasons.push('USING_PREMIUM_TRIAL');
    rank = PLAN_RANK[trialPlan];
  }
  const flatLimit = ent.limits['limit.flats']?.limit;
  if (
    flatLimit !== null &&
    flatLimit !== undefined &&
    flatLimit > 0 &&
    flats * 100 >= flatLimit * 80 &&
    rank < 3
  ) {
    reasons.push('NEAR_FLAT_LIMIT');
    rank = Math.max(rank, PLAN_RANK[currentCode] + 1);
  }
  const code = (Object.keys(PLAN_RANK) as PlanCode[]).find(c => PLAN_RANK[c] === rank)!;
  const v = await currentVersion(await planByCode(code));
  const priceSub = code === currentCode ? sub : { customPricePerFlatPaise: null, customMinFlats: null };
  const annualSaving =
    periodValueOf(priceSub, v, flats, 'MONTHLY') * 12 - periodValueOf(priceSub, v, flats, 'ANNUAL');
  if (sub.billingCycle === 'MONTHLY' && annualSaving > 0) reasons.push('ANNUAL_SAVES');
  if (!reasons.length) return null;
  return { planCode: code, reasonCodes: reasons, annualSavingPaise: Math.max(0, annualSaving) };
}

// ------------------------------------------------------------------ 8.5.5 quote
export async function quote(
  societyId: number,
  q: { planCode: PlanCode; billingCycle?: BillingCycle; addons?: { code: string; qty: number }[] },
) {
  if (q.planCode === 'ENTERPRISE')
    throw new UnprocessableError('PLAN_NOT_SELF_SERVE', 'Enterprise is priced by the SocietyApp team');
  const sub = await requireLive(societyId);
  const society = await Society.findByPk(societyId);
  const cycle = q.billingCycle ?? sub.billingCycle;
  const currentCode = await planCodeOfVersion(sub.planVersionId);
  if (q.planCode === currentCode && cycle === sub.billingCycle && !q.addons?.length)
    throw new UnprocessableError('SAME_PLAN', 'This is already your plan and billing cycle');
  const plan = await planByCode(q.planCode);
  if (!plan.isActive) throw new UnprocessableError('PLAN_INACTIVE', 'This plan is not available');
  const v = await currentVersion(plan);
  const flats = await flatsCount(societyId);
  const priceSub = q.planCode === currentCode ? sub : { customPricePerFlatPaise: null, customMinFlats: null };
  const charged = chargedFlats(flats, v.minBillableFlats, priceSub.customMinFlats);
  const price = priceOf(priceSub, v);
  const months = monthsOf(cycle);
  const free = freeMonthsFor(cycle, v.annualFreeMonths);
  const today = todayOf(society);
  const start = sub.status === 'ACTIVE' && sub.currentPeriodEnd ? addDaysYmd(sub.currentPeriodEnd, 1) : today;
  const period = periodFrom(
    start,
    sub.status === 'ACTIVE' ? sub.billingAnchorDay : Number(today.slice(8)),
    months,
  );
  const lines: { type: string; description: string; amountPaise: number }[] = [
    {
      type: 'PLAN',
      description: `${plan.name}, ${charged} flats × ${rupees(price)} × ${months} month${months > 1 ? 's' : ''}${
        charged > flats ? ` (minimum ${v.minBillableFlats} flats billed)` : ''
      }`,
      amountPaise: charged * price * months,
    },
  ];
  if (free > 0)
    lines.push({
      type: 'DISCOUNT',
      description: `Annual discount: ${free} months free`,
      amountPaise: -(charged * price * free),
    });
  for (const a of q.addons ?? []) {
    const addon = await Addon.findOne({ where: { code: a.code } });
    if (!addon) throw new NotFoundError('ADDON_NOT_FOUND', `Add-on ${a.code} not found`);
    if (PLAN_RANK[q.planCode] < addon.minTierRank || PLAN_RANK[q.planCode] > addon.maxTierRank)
      throw new UnprocessableError(
        'ADDON_NOT_AVAILABLE_FOR_PLAN',
        `${addon.name} is not available on ${plan.name}`,
      );
    const recurring = addon.billingType === 'RECURRING';
    lines.push({
      type: 'ADDON',
      description: `${addon.name} × ${a.qty}${recurring ? ` × ${months} month${months > 1 ? 's' : ''}` : ' (one-time)'}`,
      amountPaise: a.qty * Number(addon.pricePaise) * (recurring ? months : 1),
    });
  }
  const subtotal = lines.reduce((s, l) => s + l.amountPaise, 0);
  const tax = await integrations().billing.previewTax(societyId, subtotal);
  let pr = null;
  if (sub.status === 'ACTIVE' && PLAN_RANK[q.planCode] > PLAN_RANK[currentCode]) {
    const from = await versionById(sub.planVersionId);
    pr = proration(
      today,
      sub.currentPeriodStart!,
      sub.currentPeriodEnd!,
      periodValueOf(sub, from, flats, sub.billingCycle),
      periodValueOf(priceSub, v, flats, sub.billingCycle),
    );
  }
  return {
    planCode: q.planCode,
    planVersionNo: v.versionNo,
    billingCycle: cycle,
    chargedFlats: charged,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    lines,
    subtotalPaise: subtotal,
    tax,
    totalPaise: subtotal + (tax ? tax.cgstPaise + tax.sgstPaise + tax.igstPaise : 0),
    proration: pr,
  };
}

// ------------------------------------------------------------------ 8.5.6 downgrade preview
export async function downgradePreview(societyId: number, planCode: PlanCode) {
  const sub = await requireLive(societyId);
  const currentCode = await planCodeOfVersion(sub.planVersionId);
  if (PLAN_RANK[planCode] >= PLAN_RANK[currentCode])
    throw new UnprocessableError('NOT_A_DOWNGRADE', 'Choose a plan lower than your current plan');
  const society = await Society.findByPk(societyId);
  const target = await currentVersion(await planByCode(planCode));
  const rows = await loadVersionRows(target.id!);
  const ent = await getEntitlements(societyId);
  const flats = await flatsCount(societyId);
  const effectiveDate =
    sub.status === 'ACTIVE' && sub.currentPeriodEnd ? addDaysYmd(sub.currentPeriodEnd, 1) : todayOf(society);
  const featuresLost = [];
  for (const f of FEATURES) {
    if (f.isAlwaysOn || f.catalogueStatus !== 'LIVE') continue;
    const cur = ent.features[f.key];
    if (!cur?.on || cur.source !== 'PLAN' || rows.features[f.key]) continue;
    const provider = featureUsageProviders.get(f.key);
    const recordsInUse = provider ? await provider(societyId).catch(() => null) : null;
    featuresLost.push({
      key: f.key,
      moduleNo: f.moduleNo,
      title: f.title,
      recordsInUse,
      stopsJobs: (recordsInUse ?? 0) > 0,
    });
  }
  const conflicts = await limitConflicts(societyId, target);
  const limitChanges = LIMITS.map(l => ({
    limitKey: l.key,
    current: ent.limits[l.key]?.limit ?? 0,
    target: versionLimit(rows, l.key, flats),
  })).filter(c => c.current !== c.target);
  const addons = await SubscriptionAddon.findAll({
    where: { subscriptionId: sub.id!, status: { [Op.ne]: 'ENDED' } },
    include: [{ model: Addon, attributes: ['minTierRank', 'maxTierRank'] }],
  });
  const rank = PLAN_RANK[planCode];
  return {
    targetPlan: planCode,
    effectiveDate,
    readOnlyUntil: addDaysYmd(effectiveDate, READ_GRACE_DAYS),
    featuresLost,
    limitConflicts: conflicts,
    limitChanges,
    addonsEnding: addons
      .filter(a => {
        const d = (a as unknown as { Addon: Addon }).Addon;
        return rank < d.minTierRank || rank > d.maxTierRank;
      })
      .map(a => ({ code: a.addonCode, reason: 'PLAN_CHANGED' })),
    canSchedule: conflicts.length === 0,
  };
}

// ------------------------------------------------------------------ 8.6.1 activate
export async function activate(
  ctx: Ctx,
  input: { planCode: PlanCode; billingCycle: BillingCycle; version: number },
) {
  const societyId = ctx.society!.id;
  if (input.planCode === 'ENTERPRISE')
    throw new UnprocessableError('PLAN_NOT_SELF_SERVE', 'Enterprise is set up by the SocietyApp team');
  if (!(await liveSub(societyId))) throw subscriptionNotFound();
  const r = await sequelize.transaction(t =>
    startPaid(
      ctx,
      { societyId, planKey: input.planCode, billingCycle: input.billingCycle, version: input.version },
      t,
    ),
  );
  const sub = (await Subscription.findByPk(r.subscriptionId))!;
  return { subscription: await subscriptionView(sub), invoice: r.invoice };
}

// ------------------------------------------------------------------ 8.6.5 to 8.6.7 add-on store
const ownedView = (a: SubscriptionAddon) => ({
  id: a.id!,
  code: a.addonCode,
  billingType: a.billingType,
  quantity: a.quantity,
  unitPricePaise: Number(a.unitPricePaise),
  status: a.status,
  startsAt: a.startsAt.toISOString(),
  endsAt: a.endsAt?.toISOString() ?? null,
  endedReason: a.endedReason,
  featureKey: a.featureKey,
  periodKey: a.periodKey,
  invoiceId: a.invoiceId,
  version: a.version,
});

async function usedQuantity(
  sub: Subscription,
  addon: Addon,
  monthStart: Date,
  t?: Transaction,
): Promise<number> {
  const where: WhereOptions =
    addon.billingType === 'RECURRING'
      ? { subscriptionId: sub.id!, addonId: addon.id!, status: { [Op.ne]: 'ENDED' } }
      : {
          subscriptionId: sub.id!,
          addonId: addon.id!,
          [Op.or]: [
            { status: 'ACTIVE', endsAt: { [Op.gt]: now() } },
            { status: 'PENDING_PAYMENT', startsAt: { [Op.gte]: monthStart } },
          ],
        };
  return (await SubscriptionAddon.sum('quantity', { where, transaction: t })) ?? 0;
}

export async function addonStore(societyId: number) {
  const sub = await requireLive(societyId);
  const society = await Society.findByPk(societyId);
  const rank = PLAN_RANK[await planCodeOfVersion(sub.planVersionId)];
  const month = usageMonth(todayOf(society), sub.billingAnchorDay);
  const monthStart = zonedDayStart(month.periodStart, society?.timezone);
  const store = [];
  for (const a of await Addon.findAll({
    where: { isOnSale: true },
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  }))
    store.push({
      code: a.code,
      name: a.name,
      description: a.description,
      billingType: a.billingType,
      pricePaise: Number(a.pricePaise),
      grants: a.grants,
      maxQuantity: a.maxQuantity,
      availableForPlan: rank >= a.minTierRank && rank <= a.maxTierRank,
      remainingQuantity: a.grants.some(g => g.type === 'FEATURE_CHOICE')
        ? a.maxQuantity
        : Math.max(0, a.maxQuantity - (await usedQuantity(sub, a, monthStart))),
    });
  const owned = await SubscriptionAddon.findAll({
    where: {
      subscriptionId: sub.id!,
      [Op.or]: [{ status: { [Op.ne]: 'ENDED' } }, { updatedAt: { [Op.gte]: addDays(now(), -90) } }],
    },
    order: [['id', 'DESC']],
  });
  return {
    usageMonth: month.periodStart,
    usageMonthEnd: month.periodEnd,
    store,
    owned: owned.map(ownedView),
  };
}

export async function buyAddon(
  ctx: Ctx,
  input: { addonCode: string; quantity: number; featureKey?: string },
) {
  const societyId = ctx.society!.id;
  return sequelize.transaction(async t => {
    const addon = await Addon.findOne({ where: { code: input.addonCode }, transaction: t });
    if (!addon) throw new NotFoundError('ADDON_NOT_FOUND', 'Add-on not found');
    const { society, sub } = await lockSocietyAndSub(societyId, t);
    if (!sub) throw subscriptionNotFound();
    const status = (await integrations().lifecycle.getStatusInfo(societyId)).status;
    if (sub.status === 'TRIALING' || status === 'TRIAL')
      throw new UnprocessableError(
        'ADDON_NOT_ALLOWED_IN_TRIAL',
        'Add-ons can be bought once the paid plan starts',
      );
    if (status !== 'ACTIVE' && status !== 'PAST_DUE')
      throw invalidState('Add-ons cannot be bought in this society state');
    if (!addon.isOnSale) throw new UnprocessableError('ADDON_NOT_ON_SALE', 'This add-on is not on sale');
    const planCode = await planCodeOfVersion(sub.planVersionId, t);
    const rank = PLAN_RANK[planCode];
    if (rank < addon.minTierRank || rank > addon.maxTierRank)
      throw new UnprocessableError(
        'ADDON_NOT_AVAILABLE_FOR_PLAN',
        `${addon.name} is not available on your plan`,
      );
    const choice = addon.grants.some(g => g.type === 'FEATURE_CHOICE');
    if (!choice && input.featureKey)
      throw new ValidationError([{ field: 'featureKey', message: 'Only for a feature unlock add-on' }]);
    const ent = await getEntitlements(societyId);
    if (choice) {
      if (!input.featureKey)
        throw new ValidationError([{ field: 'featureKey', message: 'Choose the feature to unlock' }]);
      const f = FEATURE_BY_KEY.get(input.featureKey);
      if (f?.catalogueStatus === 'PLANNED')
        throw new UnprocessableError('PLANNED_FEATURE', 'This feature is planned and not built yet');
      if (!f || !(await canUnlock(planCode, f.key)))
        throw new UnprocessableError(
          'FEATURE_UNLOCK_KEY_INVALID',
          'This feature cannot be unlocked on your plan',
        );
      if (ent.features[f.key]?.on)
        throw new UnprocessableError('FEATURE_ALREADY_INCLUDED', 'This feature is already enabled');
    } else {
      const features = addon.grants.filter(g => g.type === 'FEATURE').map(g => (g as { key: string }).key);
      const limits = addon.grants.some(g => g.type === 'LIMIT_INCREMENT');
      if (features.length && !limits && features.every(k => ent.features[k]?.on))
        throw new UnprocessableError('FEATURE_ALREADY_INCLUDED', 'Your plan already includes this');
      const monthStart = zonedDayStart(
        usageMonth(todayOf(society), sub.billingAnchorDay).periodStart,
        society.timezone,
      );
      if ((await usedQuantity(sub, addon, monthStart, t)) + input.quantity > addon.maxQuantity)
        throw new UnprocessableError(
          'ADDON_QUANTITY_EXCEEDED',
          `At most ${addon.maxQuantity} of this add-on`,
        );
    }
    if (choice && input.quantity !== 1)
      throw new UnprocessableError('ADDON_QUANTITY_EXCEEDED', 'A feature unlock is one per feature');
    const recurring = addon.billingType === 'RECURRING';
    const row = await SubscriptionAddon.create(
      {
        societyId,
        subscriptionId: sub.id!,
        addonId: addon.id!,
        addonCode: addon.code,
        billingType: addon.billingType,
        grants: addon.grants,
        featureKey: choice ? input.featureKey! : null,
        quantity: input.quantity,
        unitPricePaise: Number(addon.pricePaise),
        periodKey: null,
        status: recurring ? 'ACTIVE' : 'PENDING_PAYMENT',
        startsAt: now(),
        endsAt: null,
        invoiceId: null,
        endedReason: null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        version: 1,
      },
      { transaction: t },
    );
    const months = monthsOf(sub.billingCycle);
    const invoice = recurring
      ? await integrations().billing.issueProrationInvoice(
          ctx,
          {
            subscriptionId: sub.id!,
            changeRef: `ADDON:${row.id}`,
            effectiveDate: todayOf(society),
            items: [
              {
                addonKey: addon.code,
                label: addon.name,
                fromPeriodValuePaise: 0,
                toPeriodValuePaise: input.quantity * Number(addon.pricePaise) * months,
              },
            ],
          },
          t,
        )
      : await integrations().billing.issueOneTimeInvoice(
          ctx,
          {
            subscriptionId: sub.id!,
            purchaseRef: `ADDON:${row.id}`,
            addonKey: addon.code,
            label: addon.name,
            quantity: input.quantity,
            unitPricePaise: Number(addon.pricePaise),
            lineType: 'ADDON',
          },
          t,
        );
    if (invoice) {
      row.invoiceId = invoice.id;
      await row.save({ transaction: t });
    }
    await audit(
      ctx,
      {
        action: 'subscriptions.subscription_addon.purchased',
        entityType: 'subscription_addon',
        entityId: row.id!,
        entityLabel: addon.code,
        societyId,
        after: ownedView(row),
      },
      t,
    );
    notifyViewers(t, societyId, 'subscription.addon_purchased', { addonName: addon.name });
    if (recurring) invalidate(societyId, t);
    return { subscriptionAddon: ownedView(row), invoiceId: invoice?.id ?? null };
  });
}

async function lockOwned(societyId: number, id: number, version: number, t: Transaction) {
  const a = await SubscriptionAddon.findOne({
    where: { id, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!a) throw new NotFoundError('SUBSCRIPTION_ADDON_NOT_FOUND', 'Add-on purchase not found');
  checkVersion(a, version, 'add-on');
  return a;
}

export async function cancelAddon(ctx: Ctx, id: number, version: number) {
  const societyId = ctx.society!.id;
  return sequelize.transaction(async t => {
    const a = await lockOwned(societyId, id, version, t);
    if (a.billingType === 'ONE_TIME')
      throw new ConflictError('ADDON_NOT_CANCELLABLE', 'A one-time pack cannot be cancelled');
    if (a.status !== 'ACTIVE') throw invalidState('Only an active add-on can be cancelled');
    const sub = await Subscription.findByPk(a.subscriptionId, { transaction: t });
    const society = await Society.findByPk(societyId, { transaction: t });
    a.status = 'CANCEL_SCHEDULED';
    a.endsAt = zonedDayStart(addDaysYmd(sub!.currentPeriodEnd ?? todayOf(society), 1), society?.timezone);
    a.updatedBy = ctx.user?.id ?? null;
    a.version += 1;
    await a.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'subscriptions.subscription_addon.cancel_scheduled',
        entityType: 'subscription_addon',
        entityId: a.id!,
        entityLabel: a.addonCode,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: a.status, endsAt: a.endsAt },
      },
      t,
    );
    invalidate(societyId, t);
    return ownedView(a);
  });
}

export async function resumeAddon(ctx: Ctx, id: number, version: number) {
  const societyId = ctx.society!.id;
  return sequelize.transaction(async t => {
    const a = await lockOwned(societyId, id, version, t);
    if (a.status !== 'CANCEL_SCHEDULED' || !a.endsAt || a.endsAt.getTime() <= now().getTime())
      throw invalidState('Only a scheduled cancellation can be undone');
    a.status = 'ACTIVE';
    a.endsAt = null;
    a.updatedBy = ctx.user?.id ?? null;
    a.version += 1;
    await a.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'subscriptions.subscription_addon.resumed',
        entityType: 'subscription_addon',
        entityId: a.id!,
        entityLabel: a.addonCode,
        societyId,
        before: { status: 'CANCEL_SCHEDULED' },
        after: { status: 'ACTIVE' },
      },
      t,
    );
    invalidate(societyId, t);
    return ownedView(a);
  });
}

// ------------------------------------------------------------------ overrides (8.4.5) and feature trials (8.6.8)
export const overrideView = (o: EntitlementOverride, creatorName?: string | null) => {
  const at = now().getTime();
  return {
    id: o.id!,
    targetType: o.targetType,
    entitlementKey: o.entitlementKey,
    moduleNo: o.moduleNo,
    isEnabled: o.isEnabled === null ? null : Boolean(o.isEnabled),
    limitValue: o.limitValue === null ? null : Number(o.limitValue),
    isUnlimited: o.isUnlimited,
    source: o.source,
    reason: o.reason,
    startsAt: o.startsAt.toISOString(),
    expiresAt: o.expiresAt?.toISOString() ?? null,
    isActive: !o.revokedAt && o.startsAt.getTime() <= at && (!o.expiresAt || o.expiresAt.getTime() > at),
    revokedAt: o.revokedAt?.toISOString() ?? null,
    revokeReason: o.revokeReason,
    createdBy: o.createdBy ? { id: o.createdBy, name: creatorName ?? null } : null,
    version: o.version,
  };
};

async function subOr404(subscriptionId: number): Promise<Subscription> {
  const s = await Subscription.findByPk(subscriptionId);
  if (!s) throw subscriptionNotFound();
  return s;
}

export async function listOverrides(subscriptionId: number, includeHistory: boolean) {
  const sub = await subOr404(subscriptionId);
  const rows = await EntitlementOverride.findAll({
    where: { societyId: sub.societyId, ...(includeHistory ? {} : { revokedAt: null }) },
    order: [['id', 'DESC']],
  });
  const users = await User.findAll({
    where: { id: [...new Set(rows.map(r => r.createdBy).filter(Boolean))] as number[] },
    attributes: ['id', 'name'],
  });
  const names = new Map(users.map(u => [u.id!, u.name]));
  return rows
    .map(r => overrideView(r, r.createdBy ? names.get(r.createdBy) : null))
    .filter(v => includeHistory || v.isActive || Date.parse(v.startsAt) > now().getTime());
}

/** Closes a live row whose expiry passed so a new override for the same target can be created. */
async function freeTarget(societyId: number, liveTarget: string, t: Transaction): Promise<void> {
  const [type, target] = [
    liveTarget.slice(0, liveTarget.indexOf(':')),
    liveTarget.slice(liveTarget.indexOf(':') + 1),
  ];
  const where =
    type === 'KEY'
      ? { societyId, targetType: 'KEY', entitlementKey: target, revokedAt: null }
      : { societyId, targetType: 'MODULE', moduleNo: Number(target), revokedAt: null };
  const live = await EntitlementOverride.findOne({ where, transaction: t, lock: t.LOCK.UPDATE });
  if (!live) return;
  if (live.expiresAt && live.expiresAt.getTime() <= now().getTime()) {
    live.revokedAt = live.expiresAt;
    live.version += 1;
    await live.save({ transaction: t });
    return;
  }
  throw new ConflictError('OVERRIDE_EXISTS', 'An active override exists for this target. Revoke it first.');
}

export interface OverrideInput {
  targetType: 'KEY' | 'MODULE';
  entitlementKey?: string;
  moduleNo?: number;
  isEnabled?: boolean;
  limitValue?: number;
  isUnlimited?: boolean;
  source: 'CONTRACT' | 'SUPPORT' | 'PROMOTION';
  startsAt?: Date;
  expiresAt?: Date | null;
  reason: string;
}

export async function createOverride(ctx: Ctx, subscriptionId: number, input: OverrideInput) {
  const sub = await subOr404(subscriptionId);
  const at = now();
  const startsAt = input.startsAt ?? at;
  const fieldErr = (field: string, message: string) => new ValidationError([{ field, message }]);
  if (startsAt.getTime() > at.getTime() + 365 * 86_400_000)
    throw fieldErr('startsAt', 'At most 365 days ahead');
  if (input.expiresAt) {
    if (input.expiresAt.getTime() <= startsAt.getTime() || input.expiresAt.getTime() <= at.getTime())
      throw fieldErr('expiresAt', 'Must be after startsAt and in the future');
    if (input.source !== 'CONTRACT' && input.expiresAt.getTime() > startsAt.getTime() + 365 * 86_400_000)
      throw fieldErr('expiresAt', 'At most 365 days after startsAt');
  } else if (input.source !== 'CONTRACT') throw fieldErr('expiresAt', 'Required for SUPPORT and PROMOTION');
  const warnings: { limitKey: string; used: number; newLimit: number }[] = [];
  if (input.targetType === 'KEY') {
    const key = input.entitlementKey!;
    const f = FEATURE_BY_KEY.get(key);
    const l = LIMIT_BY_KEY.get(key);
    if (!f && !l) throw new UnprocessableError('UNKNOWN_ENTITLEMENT_KEY', `Unknown entitlement key ${key}`);
    if (f) {
      if (input.limitValue !== undefined || input.isUnlimited)
        throw new UnprocessableError('ENTITLEMENT_KIND_MISMATCH', `${key} is a feature`);
      if (input.isEnabled === undefined) throw fieldErr('isEnabled', 'Required for a feature key');
      if (f.isAlwaysOn && !input.isEnabled)
        throw new UnprocessableError('ALWAYS_ON_FEATURE', `${f.title} is always on and cannot be disabled`);
      if (f.catalogueStatus === 'PLANNED' && input.isEnabled)
        throw new UnprocessableError('PLANNED_FEATURE', `${f.title} is planned and not built yet`);
    } else {
      if (input.isEnabled !== undefined)
        throw new UnprocessableError('ENTITLEMENT_KIND_MISMATCH', `${key} is a limit`);
      if (input.limitValue === undefined && !input.isUnlimited)
        throw fieldErr('limitValue', 'Required unless isUnlimited');
      if (!input.isUnlimited) {
        const ent = await getEntitlements(sub.societyId);
        const counter = await UsageCounter.findOne({
          where: { societyId: sub.societyId, limitKey: key, periodKey: periodKeyFor(ent, key) },
        });
        const used = Number(counter?.used ?? 0);
        const newLimit = counterLimit(key, input.limitValue!)!;
        if (used > newLimit) warnings.push({ limitKey: key, used, newLimit: input.limitValue! });
      }
    }
  } else {
    if (!FEATURES.some(f => f.moduleNo === input.moduleNo))
      throw fieldErr('moduleNo', 'This module owns no feature key');
    if (input.isEnabled === undefined) throw fieldErr('isEnabled', 'Required for a module override');
  }
  const row = await sequelize.transaction(async t => {
    await freeTarget(
      sub.societyId,
      input.targetType === 'KEY' ? `KEY:${input.entitlementKey}` : `MODULE:${input.moduleNo}`,
      t,
    );
    const o = await EntitlementOverride.create(
      {
        societyId: sub.societyId,
        targetType: input.targetType,
        entitlementKey: input.targetType === 'KEY' ? input.entitlementKey! : null,
        moduleNo: input.targetType === 'MODULE' ? input.moduleNo! : null,
        isEnabled: input.isEnabled ?? null,
        limitValue: input.isUnlimited ? null : (input.limitValue ?? null),
        isUnlimited: Boolean(input.isUnlimited),
        source: input.source,
        reason: input.reason,
        startsAt,
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        expiryProcessedAt: null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        version: 1,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: 'subscriptions.override.created',
        entityType: 'entitlement_override',
        entityId: o.id!,
        entityLabel: o.entitlementKey ?? `module ${o.moduleNo}`,
        societyId: sub.societyId,
        after: overrideView(o),
        reason: input.reason,
      },
      t,
    );
    invalidate(sub.societyId, t);
    return o;
  });
  return { ...overrideView(row, ctx.user?.name ?? null), ...(warnings.length ? { warnings } : {}) };
}

export async function revokeOverride(
  ctx: Ctx,
  subscriptionId: number,
  overrideId: number,
  input: { reason: string; version: number },
) {
  const sub = await subOr404(subscriptionId);
  return sequelize.transaction(async t => {
    const o = await EntitlementOverride.findOne({
      where: { id: overrideId, societyId: sub.societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!o) throw new NotFoundError('OVERRIDE_NOT_FOUND', 'Override not found');
    if (o.revokedAt) throw invalidState('This override is already revoked');
    checkVersion(o, input.version, 'override');
    o.revokedAt = now();
    o.revokedBy = ctx.user?.id ?? null;
    o.revokeReason = input.reason;
    o.updatedBy = ctx.user?.id ?? null;
    o.version += 1;
    await o.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'subscriptions.override.revoked',
        entityType: 'entitlement_override',
        entityId: o.id!,
        entityLabel: o.entitlementKey ?? `module ${o.moduleNo}`,
        societyId: sub.societyId,
        before: { revokedAt: null },
        after: { revokedAt: o.revokedAt },
        reason: input.reason,
      },
      t,
    );
    invalidate(sub.societyId, t);
    return overrideView(o);
  });
}

export const TRIAL_DAYS = 14;

/** BR-04-24: a 14-day PREMIUM_TRIAL override, once per key, one at a time. */
export async function startFeatureTrial(ctx: Ctx, featureKey: string) {
  const societyId = ctx.society!.id;
  return sequelize.transaction(async t => {
    const { sub } = await lockSocietyAndSub(societyId, t);
    if (!sub) throw subscriptionNotFound();
    if (sub.status !== 'ACTIVE') throw invalidState('Feature trials start once the paid plan is active');
    const planCode = await planCodeOfVersion(sub.planVersionId, t);
    const f = FEATURE_BY_KEY.get(featureKey);
    if (f?.catalogueStatus === 'PLANNED')
      throw new UnprocessableError('PLANNED_FEATURE', 'This feature is planned and not built yet');
    if (!f || f.isAlwaysOn || f.minPlan === 'ENTERPRISE' || PLAN_RANK[f.minPlan] <= PLAN_RANK[planCode])
      throw new UnprocessableError(
        'FEATURE_UNLOCK_KEY_INVALID',
        'This feature cannot be trialled on your plan',
      );
    if (
      await EntitlementOverride.findOne({
        where: { societyId, source: 'PREMIUM_TRIAL', entitlementKey: featureKey },
        transaction: t,
      })
    )
      throw new ConflictError('FEATURE_TRIAL_USED', 'This feature was trialled before');
    const at = now();
    if (
      await EntitlementOverride.findOne({
        where: { societyId, source: 'PREMIUM_TRIAL', revokedAt: null, expiresAt: { [Op.gt]: at } },
        transaction: t,
      })
    )
      throw new ConflictError('FEATURE_TRIAL_ACTIVE', 'Another feature trial is running');
    if ((await getEntitlements(societyId)).features[featureKey]?.on)
      throw new UnprocessableError('FEATURE_ALREADY_INCLUDED', 'This feature is already enabled');
    await freeTarget(societyId, `KEY:${featureKey}`, t);
    const expiresAt = addDays(at, TRIAL_DAYS);
    const o = await EntitlementOverride.create(
      {
        societyId,
        targetType: 'KEY',
        entitlementKey: featureKey,
        moduleNo: null,
        isEnabled: true,
        limitValue: null,
        isUnlimited: false,
        source: 'PREMIUM_TRIAL',
        reason: 'Premium feature trial',
        startsAt: at,
        expiresAt,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        expiryProcessedAt: null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        version: 1,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: 'subscriptions.feature_trial.started',
        entityType: 'entitlement_override',
        entityId: o.id!,
        entityLabel: featureKey,
        societyId,
        after: { featureKey, expiresAt },
      },
      t,
    );
    notifyViewers(t, societyId, 'subscription.feature_trial_started', {
      featureTitle: f.title,
      expiresAt: expiresAt.toISOString().slice(0, 10),
    });
    invalidate(societyId, t);
    return { featureKey, startsAt: at.toISOString(), expiresAt: expiresAt.toISOString() };
  });
}

// ------------------------------------------------------------------ platform subscriptions (8.4.1, 8.4.2, 8.4.4)
export interface ListSubsQuery {
  status?: ('TRIALING' | 'ACTIVE' | 'CANCELLED')[];
  planCode?: PlanCode;
  billingCycle?: BillingCycle;
  hasPendingChange?: boolean;
  trialEndsBefore?: string;
  societyId?: number;
  q?: string;
  page: number;
  limit: number;
  sortBy: 'statusChangedAt' | 'currentPeriodEnd' | 'trialEndsAt' | 'billableFlats' | 'createdAt';
  sortOrder: 'asc' | 'desc';
}

export async function listSubscriptions(q: ListSubsQuery) {
  const where: Record<string | symbol, unknown> = {};
  if (q.status?.length) where.status = q.status;
  if (q.billingCycle) where.billingCycle = q.billingCycle;
  if (q.societyId) where.societyId = q.societyId;
  if (q.trialEndsBefore) where.trialEndsAt = { [Op.lt]: new Date(q.trialEndsBefore) };
  if (q.hasPendingChange !== undefined)
    where[Op.or as unknown as string] = q.hasPendingChange
      ? [{ pendingPlanVersionId: { [Op.ne]: null } }, { pendingBillingCycle: { [Op.ne]: null } }]
      : undefined;
  if (q.hasPendingChange === false) {
    delete where[Op.or as unknown as string];
    where.pendingPlanVersionId = null;
    where.pendingBillingCycle = null;
  }
  const include = [
    {
      model: Society,
      attributes: ['id', 'name', 'city'],
      required: true,
      ...(q.q ? { where: { name: { [Op.like]: `%${q.q}%` } } } : {}),
    },
    {
      model: Plan,
      attributes: ['code'],
      required: true,
      ...(q.planCode ? { where: { code: q.planCode } } : {}),
    },
    { model: PlanVersion, as: 'planVersion', required: true },
  ];
  const { rows, count } = await Subscription.findAndCountAll({
    where: where as WhereOptions,
    include,
    order: [[q.sortBy, q.sortOrder.toUpperCase()]],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  const data = await Promise.all(
    rows.map(async s => {
      const x = s as unknown as { Society: Society; Plan: Plan; planVersion: PlanVersion };
      const value = periodValueOf(s, x.planVersion, s.billableFlats, s.billingCycle);
      return {
        id: s.id!,
        society: { id: x.Society.id!, name: x.Society.name, city: x.Society.city },
        planCode: x.Plan.code,
        planVersionNo: x.planVersion.versionNo,
        status: s.status,
        billingCycle: s.billingCycle,
        billableFlats: s.billableFlats,
        chargedFlats: chargedFlats(s.billableFlats, x.planVersion.minBillableFlats, s.customMinFlats),
        monthlyEquivalentPaise: s.status === 'ACTIVE' ? monthlyEquivalent(value, s.billingCycle) : 0,
        currentPeriodEnd: s.currentPeriodEnd,
        trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
        pendingChange: s.pendingPlanVersionId
          ? {
              type: s.pendingChangeType,
              planCode: await planCodeOfVersion(s.pendingPlanVersionId),
              at: s.pendingChangeAt,
            }
          : s.pendingBillingCycle
            ? {
                type: 'CYCLE',
                billingCycle: s.pendingBillingCycle,
                at: s.currentPeriodEnd ? addDaysYmd(s.currentPeriodEnd, 1) : null,
              }
            : null,
        version: s.version,
      };
    }),
  );
  return { data, pagination: pageMeta(q.page, q.limit, count) };
}

export async function subscriptionDetail(subscriptionId: number) {
  const sub = await subOr404(subscriptionId);
  const view = await subscriptionView(sub);
  const ent = await getEntitlements(sub.societyId);
  const addons = await SubscriptionAddon.findAll({
    where: { subscriptionId },
    order: [['id', 'DESC']],
    limit: 50,
  });
  const history = await AuditLog.findAll({
    where: { entityType: 'subscription', entityId: String(subscriptionId) },
    order: [['id', 'DESC']],
    limit: 20,
  });
  const society = await Society.findByPk(sub.societyId, { attributes: ['id', 'name', 'city'] });
  return {
    ...view,
    society: society ? { id: society.id!, name: society.name, city: society.city } : null,
    entitlements: {
      planCode: ent.planCode,
      generation: ent.generation,
      features: FEATURES.map(f => ({
        key: f.key,
        moduleNo: f.moduleNo,
        title: f.title,
        on: ent.features[f.key]!.on,
        source: ent.features[f.key]!.source,
        isAlwaysOn: f.isAlwaysOn,
        catalogueStatus: f.catalogueStatus,
      })),
    },
    usage: await usageView(sub.societyId),
    addons: addons.map(ownedView),
    overrides: await listOverrides(subscriptionId, false),
    autopay: {
      status: sub.autopayStatus,
      method: sub.autopayMethod,
      mandateRef: sub.autopayMandateRef,
      maxAmountPaise: sub.autopayMaxAmountPaise === null ? null : Number(sub.autopayMaxAmountPaise),
    },
    history: history.map(h => ({
      id: h.id,
      action: h.action,
      actorName: h.actorName,
      actorRole: h.actorRole,
      reason: h.reason,
      before: h.before,
      after: h.after,
      createdAt: (h.createdAt as Date).toISOString(),
    })),
  };
}

export async function patchSubscription(
  ctx: Ctx,
  subscriptionId: number,
  input: {
    pendingBillingCycle?: BillingCycle | null;
    customPricePerFlatPaise?: number | null;
    customMinFlats?: number | null;
    reason: string;
    version: number;
  },
) {
  const pre = await subOr404(subscriptionId);
  await sequelize.transaction(async t => {
    const { sub } = await lockSocietyAndSub(pre.societyId, t);
    if (!sub || sub.id !== subscriptionId) throw invalidState('The subscription is cancelled');
    checkVersion(sub, input.version);
    const code = await planCodeOfVersion(sub.planVersionId, t);
    const before = {
      pendingBillingCycle: sub.pendingBillingCycle,
      customPricePerFlatPaise: sub.customPricePerFlatPaise,
      customMinFlats: sub.customMinFlats,
    };
    const actions: string[] = [];
    if (input.pendingBillingCycle !== undefined) {
      if (sub.status !== 'ACTIVE')
        throw invalidState('The billing cycle is chosen when the paid plan starts');
      sub.pendingBillingCycle =
        input.pendingBillingCycle === sub.billingCycle ? null : input.pendingBillingCycle;
      actions.push('cycle_change_scheduled');
    }
    if (input.customPricePerFlatPaise !== undefined || input.customMinFlats !== undefined) {
      if (code !== 'ENTERPRISE')
        throw new UnprocessableError('CUSTOM_PRICE_NOT_ALLOWED', 'A custom price applies to Enterprise only');
      if (input.customPricePerFlatPaise !== undefined) {
        if (input.customPricePerFlatPaise === null)
          throw new UnprocessableError('CUSTOM_PRICE_REQUIRED', 'Enterprise needs a custom price per flat');
        sub.customPricePerFlatPaise = input.customPricePerFlatPaise;
      }
      if (input.customMinFlats !== undefined) sub.customMinFlats = input.customMinFlats;
      actions.push('custom_price_set');
    }
    sub.updatedBy = ctx.user?.id ?? null;
    sub.version += 1;
    await sub.save({ transaction: t });
    for (const a of actions)
      await audit(
        ctx,
        {
          action: `subscriptions.subscription.${a}`,
          entityType: 'subscription',
          entityId: sub.id!,
          societyId: sub.societyId,
          before,
          after: {
            pendingBillingCycle: sub.pendingBillingCycle,
            customPricePerFlatPaise: sub.customPricePerFlatPaise,
            customMinFlats: sub.customMinFlats,
          },
          reason: input.reason,
        },
        t,
      );
    invalidate(sub.societyId, t);
  });
  return subscriptionView((await Subscription.findByPk(subscriptionId))!);
}
