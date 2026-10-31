import { Op, type Transaction } from 'sequelize';
import { Plan, PlanVersion, Society, Subscription, SubscriptionAddon, sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { now } from '../../lib/clock';
import { notify } from '../../lib/notify';
import { emitToRoom } from '../../lib/realtime';
import { AppError, ConflictError, NotFoundError } from '../../utils/errors';
import { usersWithPermission } from '../access-control/access-control.public';
import { PLAN_RANK, type PlanCode } from './subscriptions.catalogue';
import { chargedFlats, freeMonthsFor, localDate, monthsOf, roundHalfUpDiv } from './pricing';
import { integrations } from './subscriptions.integrations';
import type { BillingCycle } from './subscriptions.types';
import './subscriptions.templates';

export const invalidState = (message = 'This action is not allowed in the current state') =>
  new AppError(409, 'INVALID_STATE', message);
export const staleVersion = (what = 'subscription') =>
  new ConflictError('STALE_VERSION', `Someone else changed this ${what}. Reload to see the change.`);
export const subscriptionNotFound = () =>
  new NotFoundError('SUBSCRIPTION_NOT_FOUND', 'No subscription found');

/** Runs after commit and never throws (notifications, realtime). */
export function afterCommit(t: Transaction, fn: () => unknown): void {
  t.afterCommit(async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, 'subscriptions after-commit action failed');
    }
  });
}

/** "Viewers": active members holding `settings.subscription.view` (section 10). */
export function notifyViewers(
  t: Transaction,
  societyId: number,
  templateKey: string,
  data: Record<string, unknown> = {},
  permission = 'settings.subscription.view',
): void {
  afterCommit(t, async () => {
    const ids = await usersWithPermission(societyId, permission);
    await notify(
      templateKey,
      ids.map(userId => ({ userId })),
      data,
    );
  });
}

export function emitSubscriptionUpdated(t: Transaction, sub: Subscription, planCode: string): void {
  afterCommit(t, () =>
    emitToRoom(`society:${sub.societyId}:admin`, 'subscription.updated', {
      status: sub.status,
      planCode,
      pendingChange: sub.pendingChangeType,
      version: sub.version,
    }),
  );
}

/** BR-04-29 lock order: the `societies` row first, then the live subscription. */
export async function lockSocietyAndSub(
  societyId: number,
  t: Transaction,
): Promise<{ society: Society; sub: Subscription | null }> {
  const society = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!society) throw new AppError(404, 'SOCIETY_NOT_FOUND', 'Society not found');
  const sub = await Subscription.findOne({
    where: { societyId, status: { [Op.ne]: 'CANCELLED' } },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  return { society, sub };
}

export async function liveSub(societyId: number, t?: Transaction): Promise<Subscription | null> {
  return Subscription.findOne({ where: { societyId, status: { [Op.ne]: 'CANCELLED' } }, transaction: t });
}

export const checkVersion = (row: { version: number }, version: number, what?: string): void => {
  if (row.version !== version) throw staleVersion(what);
};

const planCache = new Map<number, Plan>();
export async function planById(id: number, t?: Transaction): Promise<Plan> {
  const p = await Plan.findByPk(id, { transaction: t });
  if (!p) throw new NotFoundError('PLAN_NOT_FOUND', 'Plan not found');
  planCache.set(id, p);
  return p;
}
export async function planByCode(code: PlanCode, t?: Transaction): Promise<Plan> {
  const p = await Plan.findOne({ where: { code }, transaction: t });
  if (!p) throw new NotFoundError('PLAN_NOT_FOUND', 'Plan not found');
  return p;
}
export async function versionById(id: number, t?: Transaction): Promise<PlanVersion> {
  const v = await PlanVersion.findByPk(id, { transaction: t });
  if (!v) throw new NotFoundError('PLAN_VERSION_NOT_FOUND', 'Plan version not found');
  return v;
}
/** The plan's current published version. */
export async function currentVersion(plan: Plan, t?: Transaction): Promise<PlanVersion> {
  if (!plan.currentVersionId) throw new AppError(422, 'PLAN_INACTIVE', 'This plan has no published version');
  return versionById(plan.currentVersionId, t);
}

export const rankOf = (code: string): number => PLAN_RANK[code as PlanCode] ?? 0;

/** Price per flat per month (custom price when set, BR-04-5). */
export const priceOf = (sub: Pick<Subscription, 'customPricePerFlatPaise'>, v: PlanVersion): number =>
  sub.customPricePerFlatPaise !== null && sub.customPricePerFlatPaise !== undefined
    ? Number(sub.customPricePerFlatPaise)
    : Number(v.pricePerFlatPaise);

export const chargedOf = (
  sub: Pick<Subscription, 'customMinFlats'>,
  v: PlanVersion,
  billable: number,
): number => chargedFlats(billable, v.minBillableFlats, sub.customMinFlats);

/** Value of a full period (BR-04-5) through module 06's `periodValue`. */
export function periodValueOf(
  sub: Pick<Subscription, 'customPricePerFlatPaise' | 'customMinFlats'>,
  v: PlanVersion,
  billable: number,
  cycle: BillingCycle,
): number {
  return integrations().billing.periodValue(
    chargedOf(sub, v, billable),
    priceOf(sub, v),
    monthsOf(cycle),
    freeMonthsFor(cycle, v.annualFreeMonths),
  );
}

/** Monthly equivalent of a period value (annual ÷ 12, half-up). */
export const monthlyEquivalent = (value: number, cycle: BillingCycle): number =>
  cycle === 'ANNUAL' ? roundHalfUpDiv(value, 12) : value;

export const todayOf = (society: Pick<Society, 'timezone'> | null | undefined): string =>
  localDate(now(), society?.timezone ?? 'Asia/Kolkata');

/** Recurring add-ons that are not ENDED. */
export async function openAddons(subscriptionId: number, t?: Transaction): Promise<SubscriptionAddon[]> {
  return SubscriptionAddon.findAll({
    where: { subscriptionId, status: { [Op.ne]: 'ENDED' } },
    transaction: t,
    lock: t ? t.LOCK.UPDATE : undefined,
  });
}

export const db = sequelize;
