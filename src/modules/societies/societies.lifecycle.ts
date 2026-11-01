import { Op, type Transaction } from 'sequelize';
import { Society, SocietyLifecycleEvent, sequelize } from '../../models';
import type { ClosureReason, SuspensionCause } from '../../models/society.model';
import type {
  LifecycleEventType,
  TriggerCode,
  TriggerSource,
} from '../../models/society-lifecycle-event.model';
import { addDays, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { cancelAllPendingInvitations, invalidateSociety } from '../access-control/access-control.public';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { societyPorts, setting } from './societies.ports';
import { AUDIT, type SocietyStatus } from './societies.types';
import { emitAfterCommit, groups, notifyAfterCommit } from './societies.notify';
import { endGrantsForClosure, clearGrantCacheForSociety } from './societies.support-access';
import { latestClosureExportId, queueClosureExport } from './societies.exports';

/**
 * Society lifecycle state machine (section 6.1, BR-05-1 to BR-05-21). `transition()` is the only writer of
 * `societies.status`. Hooks for modules 04 and 06 run inside the caller's transaction and never open their own.
 */

// ------------------------------------------------------------------ transition table (6.1)
export const ALLOWED: Record<SocietyStatus, SocietyStatus[]> = {
  TRIAL: ['ACTIVE', 'SUSPENDED', 'CLOSED'],
  ACTIVE: ['PAST_DUE', 'SUSPENDED', 'CLOSED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'PAST_DUE', 'TRIAL', 'CLOSED'],
  CLOSED: ['ACTIVE'],
};
export const isAllowed = (from: SocietyStatus, to: SocietyStatus): boolean => ALLOWED[from].includes(to);

export const invalidTransition = () =>
  new ConflictError('INVALID_LIFECYCLE_TRANSITION', 'This change is not allowed in the current status');
export const staleVersion = () =>
  new ConflictError('STALE_VERSION', 'Someone else changed this society. Reload and try again.');
export const societyNotFound = () => new NotFoundError('SOCIETY_NOT_FOUND', 'Society not found');
export const societyPurged = () =>
  new ConflictError('SOCIETY_PURGED', 'The data of this society has already been purged');

/** BR-05-38: 31 March of (start year of the FY of `closedAt` in Asia/Kolkata) + 9. */
export function financialRetainUntilFor(closedAt: Date): string {
  const ist = new Date(closedAt.getTime() + 5.5 * 3_600_000);
  const y = ist.getUTCFullYear();
  const fyStart = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${fyStart + 9}-03-31`;
}

export const actorNameOf = (ctx: Ctx, source: TriggerSource): string =>
  source === 'BILLING' ? 'billing' : (ctx.user?.name ?? 'system');

// ------------------------------------------------------------------ events
export interface EventInput {
  eventType: LifecycleEventType;
  fromStatus: SocietyStatus | null;
  toStatus: SocietyStatus | null;
  triggerSource: TriggerSource;
  triggerCode: TriggerCode;
  reasonCategory?: string | null;
  reason?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: number | null;
  metadata?: Record<string, unknown> | null;
}

export async function writeEvent(
  ctx: Ctx,
  societyId: number,
  e: EventInput,
  t: Transaction,
): Promise<SocietyLifecycleEvent> {
  return SocietyLifecycleEvent.create(
    {
      societyId,
      eventType: e.eventType,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      triggerSource: e.triggerSource,
      triggerCode: e.triggerCode,
      reasonCategory: e.reasonCategory ?? null,
      reason: e.reason ?? null,
      actorUserId:
        e.triggerSource === 'BILLING' || e.triggerSource === 'SYSTEM_JOB' ? null : (ctx.user?.id ?? null),
      actorName: actorNameOf(ctx, e.triggerSource).slice(0, 120),
      relatedEntityType: e.relatedEntityType ?? null,
      relatedEntityId: e.relatedEntityId ?? null,
      metadata: e.metadata ?? null,
      requestId: ctx.requestId ? ctx.requestId.slice(0, 20) : null,
    },
    { transaction: t },
  );
}

const auditActor = (ctx: Ctx, source: TriggerSource) =>
  source === 'BILLING'
    ? { userId: null, name: 'billing', role: 'system' }
    : source === 'SYSTEM_JOB' || !ctx.user
      ? { userId: null, name: 'System', role: 'system' }
      : undefined;

export async function lockSociety(societyId: number, t: Transaction): Promise<Society> {
  const s = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!s) throw societyNotFound();
  return s;
}

// ------------------------------------------------------------------ transition
export interface TransitionInput {
  to: SocietyStatus;
  triggerSource: TriggerSource;
  triggerCode: TriggerCode;
  /** Manual actions throw `409 INVALID_LIFECYCLE_TRANSITION`; hooks and jobs are no-ops (BR-05-2). */
  manual: boolean;
  reason?: string | null;
  reasonCategory?: string | null;
  suspensionCause?: SuspensionCause;
  closureReason?: ClosureReason;
  suspensionHoldUntil?: Date | null;
  trialEndsAt?: Date;
  relatedEntityType?: string | null;
  relatedEntityId?: number | null;
  metadata?: Record<string, unknown> | null;
  /** Audit action (defaults by target status). */
  auditAction?: string;
  /** Skip the default notification of the target status. */
  silent?: boolean;
  /** CLOSED only: send `societies.closed_resident` (default true). */
  notifyResidents?: boolean;
}

const defaultAudit = (from: SocietyStatus, to: SocietyStatus): string => {
  if (to === 'CLOSED') return AUDIT.closed;
  if (to === 'SUSPENDED') return AUDIT.suspended;
  if (to === 'PAST_DUE') return from === 'SUSPENDED' ? AUDIT.reactivated : AUDIT.pastDue;
  if (to === 'TRIAL') return AUDIT.trialExtended;
  if (from === 'TRIAL') return AUDIT.converted;
  if (from === 'CLOSED') return AUDIT.reopened;
  return AUDIT.reactivated;
};

/**
 * BR-05-1: moves the locked society row to `to`, applies the column rules of 6.1, writes one lifecycle event and one
 * audit row, and schedules side effects after commit (module 03 `invalidateSociety` first). The caller must hold the row
 * lock (`lockSociety`). Returns false (no-op) when the transition is not allowed and `manual` is false.
 */
export async function transition(
  ctx: Ctx,
  society: Society,
  input: TransitionInput,
  t: Transaction,
): Promise<boolean> {
  const from = society.status;
  const to = input.to;
  if (from === to || !isAllowed(from, to)) {
    if (input.manual) throw invalidTransition();
    logger.info(
      { societyId: society.id, from, to, trigger: input.triggerCode },
      'lifecycle transition skipped',
    );
    return false;
  }
  const t0 = now();
  const before = { status: from, suspensionCause: society.suspensionCause };
  switch (to) {
    case 'TRIAL':
      society.trialEndsAt = input.trialEndsAt ?? society.trialEndsAt;
      society.suspendedAt = null;
      society.suspensionCause = null;
      society.suspensionHoldUntil = null;
      break;
    case 'ACTIVE':
      if (!society.activatedAt) society.activatedAt = t0;
      if (from === 'TRIAL' || (from === 'SUSPENDED' && society.suspensionCause === 'TRIAL_EXPIRED'))
        society.trialEndsAt = null;
      society.pastDueSince = null;
      society.suspendedAt = null;
      society.suspensionCause = null;
      society.suspensionHoldUntil = null;
      if (from === 'CLOSED') {
        society.closedAt = null;
        society.closureReason = null;
        society.purgeAfter = null;
        society.financialRetainUntil = null;
      }
      break;
    case 'PAST_DUE':
      if (!society.pastDueSince) society.pastDueSince = t0;
      society.suspensionHoldUntil = input.suspensionHoldUntil ?? null;
      society.suspendedAt = null;
      society.suspensionCause = null;
      break;
    case 'SUSPENDED':
      society.suspendedAt = t0;
      society.suspensionCause = input.suspensionCause ?? 'MANUAL';
      society.suspensionHoldUntil = null;
      break;
    case 'CLOSED': {
      const days = await setting('lifecycle.retentionDaysAfterClose');
      society.closedAt = t0;
      society.closureReason = input.closureReason ?? 'OTHER';
      society.purgeAfter = addDays(t0, days);
      society.financialRetainUntil = financialRetainUntilFor(t0);
      society.healthScore = 0;
      society.suspensionHoldUntil = null;
      society.suspendedAt = null;
      society.suspensionCause = null;
      society.trialEndsAt = null;
      break;
    }
  }
  society.status = to;
  society.statusChangedAt = t0;
  society.version += 1;
  society.updatedBy = ctx.user?.id ?? society.updatedBy;
  await society.save({ transaction: t });

  await writeEvent(
    ctx,
    society.id!,
    {
      eventType: 'STATUS_CHANGED',
      fromStatus: from,
      toStatus: to,
      triggerSource: input.triggerSource,
      triggerCode: input.triggerCode,
      reasonCategory: input.reasonCategory,
      reason: input.reason,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
      metadata: input.metadata,
    },
    t,
  );
  await audit(
    ctx,
    {
      action: input.auditAction ?? defaultAudit(from, to),
      entityType: 'society',
      entityId: society.id!,
      entityLabel: society.name,
      societyId: society.id!,
      before,
      after: {
        status: to,
        suspensionCause: society.suspensionCause,
        triggerCode: input.triggerCode,
        ...(input.metadata ?? {}),
      },
      reason: input.reason ?? null,
      actor: auditActor(ctx, input.triggerSource),
    },
    t,
  );

  if (to === 'CLOSED') await closureEffects(ctx, society, t);

  const sid = society.id!;
  t.afterCommit(async () => {
    await invalidateSociety(sid);
    await clearGrantCacheForSociety(sid);
  });
  emitAfterCommit(t, [
    {
      room: `society:${sid}:admin`,
      event: 'society.status_changed',
      payload: { societyId: sid, status: to },
    },
  ]);
  if (!input.silent) notifyTransition(t, society, from, to, input);
  return true;
}

function notifyTransition(
  t: Transaction,
  s: Society,
  from: SocietyStatus,
  to: SocietyStatus,
  input: TransitionInput,
): void {
  const sid = s.id!;
  const data = { societyName: s.name, societyId: sid };
  if (to === 'PAST_DUE' && from !== 'SUSPENDED')
    notifyAfterCommit(t, 'societies.past_due', () => groups.billingAdmins(sid), data);
  else if (to === 'SUSPENDED')
    notifyAfterCommit(
      t,
      input.suspensionCause === 'TRIAL_EXPIRED' ? 'societies.trial_expired' : 'societies.suspended',
      () => (input.suspensionCause === 'TRIAL_EXPIRED' ? groups.billingAdmins(sid) : groups.committee(sid)),
      data,
    );
  else if (to === 'CLOSED') {
    notifyAfterCommit(t, 'societies.closed', () => groups.committee(sid), data);
    if (input.notifyResidents !== false)
      notifyAfterCommit(t, 'societies.closed_resident', () => groups.residents(sid), data);
  } else if (to === 'ACTIVE' && from === 'TRIAL')
    notifyAfterCommit(t, 'societies.converted', () => groups.billingAdmins(sid), data);
  else if (to === 'ACTIVE' && from === 'CLOSED')
    notifyAfterCommit(t, 'societies.reopened', () => groups.committee(sid), data);
  else if (from === 'SUSPENDED')
    notifyAfterCommit(t, 'societies.reactivated', () => groups.committee(sid), data);
}

/** BR-05-18 effects inside the close transaction. */
async function closureEffects(ctx: Ctx, society: Society, t: Transaction): Promise<void> {
  const sid = society.id!;
  await endGrantsForClosure(ctx, sid, t);
  await subscriptions.cancelForClosure(ctx, sid, t);
  await societyPorts().guardDevices.revokeAllForSociety(ctx, sid, t);
  await cancelAllPendingInvitations(ctx, sid, 'SOCIETY_CLOSED', t);
  await societyPorts().autopay.cancelAllForSociety(ctx, sid, t);
  await queueClosureExport(ctx, sid, t);
}

// ------------------------------------------------------------------ hooks for module 06 (8.25)
const billingSource = { triggerSource: 'BILLING' as const, manual: false };

/** ACTIVE → PAST_DUE. Runs in the caller's transaction; re-locks the society row (no-op re-lock when held). */
export async function onInvoiceOverdue(ctx: Ctx, societyId: number, t: Transaction): Promise<void> {
  const s = await lockSociety(societyId, t);
  if (s.status !== 'ACTIVE') return void logger.info({ societyId }, 'onInvoiceOverdue: no-op');
  await transition(ctx, s, { ...billingSource, to: 'PAST_DUE', triggerCode: 'INVOICE_OVERDUE' }, t);
}

/** PAST_DUE → SUSPENDED (NON_PAYMENT); no-op while `suspensionHoldUntil` is in the future (BR-05-17). */
export async function onGraceExpired(ctx: Ctx, societyId: number, t: Transaction): Promise<void> {
  const s = await lockSociety(societyId, t);
  if (s.status !== 'PAST_DUE') return;
  if (s.suspensionHoldUntil && s.suspensionHoldUntil >= now()) return;
  await transition(
    ctx,
    s,
    { ...billingSource, to: 'SUSPENDED', triggerCode: 'GRACE_EXPIRED', suspensionCause: 'NON_PAYMENT' },
    t,
  );
}

/** PAST_DUE → ACTIVE; SUSPENDED (NON_PAYMENT) → ACTIVE. Never lifts a MANUAL suspension (BR-05-16). */
export async function onAccountCleared(ctx: Ctx, societyId: number, t: Transaction): Promise<void> {
  const s = await lockSociety(societyId, t);
  if (s.status === 'PAST_DUE' || (s.status === 'SUSPENDED' && s.suspensionCause === 'NON_PAYMENT'))
    await transition(ctx, s, { ...billingSource, to: 'ACTIVE', triggerCode: 'ACCOUNT_CLEARED' }, t);
}

/** TRIAL → ACTIVE; SUSPENDED (TRIAL_EXPIRED) → ACTIVE. */
export async function onFirstInvoicePaid(ctx: Ctx, societyId: number, t: Transaction): Promise<void> {
  const s = await lockSociety(societyId, t);
  if (s.status === 'TRIAL' || (s.status === 'SUSPENDED' && s.suspensionCause === 'TRIAL_EXPIRED'))
    await transition(ctx, s, { ...billingSource, to: 'ACTIVE', triggerCode: 'FIRST_INVOICE_PAID' }, t);
}

/** Module 04 at the end of a cancelled paid period, or a cancelled trial: → CLOSED (SUBSCRIPTION_CANCELLED). */
export async function closeForSubscriptionCancellation(
  societyId: number,
  subscriptionId: number,
  t: Transaction,
): Promise<void> {
  const s = await lockSociety(societyId, t);
  if (s.status === 'CLOSED') return;
  await transition(
    { requestId: 'subscription', ip: '', userAgent: '' },
    s,
    {
      to: 'CLOSED',
      triggerSource: 'SYSTEM_JOB',
      triggerCode: 'SUBSCRIPTION_CANCELLED',
      manual: false,
      closureReason: 'CUSTOMER_REQUEST',
      reasonCategory: 'CUSTOMER_REQUEST',
      relatedEntityType: 'subscription',
      relatedEntityId: subscriptionId,
    },
    t,
  );
}

// ------------------------------------------------------------------ reads for other modules (8.25)
export async function getStatusInfo(societyId: number): Promise<{
  status: SocietyStatus;
  suspensionCause: string | null;
  suspensionHoldUntil: Date | null;
  purgedAt: Date | null;
}> {
  const s = await Society.findByPk(societyId, {
    attributes: ['id', 'status', 'suspensionCause', 'suspensionHoldUntil', 'purgedAt'],
  });
  if (!s) throw societyNotFound();
  return {
    status: s.status,
    suspensionCause: s.suspensionCause,
    suspensionHoldUntil: s.suspensionHoldUntil,
    purgedAt: s.purgedAt,
  };
}

/** `date` 'YYYY-MM-DD' means the end of that day in Asia/Kolkata; a Date means that instant. */
export async function getStatusAt(societyId: number, at: string | Date): Promise<SocietyStatus | null> {
  const instant = typeof at === 'string' ? new Date(`${at}T23:59:59.999+05:30`) : at;
  const e = await SocietyLifecycleEvent.findOne({
    where: { societyId, toStatus: { [Op.ne]: null }, createdAt: { [Op.lte]: instant } },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  return (e?.toStatus as SocietyStatus | undefined) ?? null;
}

/** Module 07 dashboard: conversions out of TRIAL in [from, to). */
export async function trialConversionStats(
  from: Date,
  to: Date,
): Promise<{ converted: number; ended: number; ratePct: number | null }> {
  const rows = await SocietyLifecycleEvent.findAll({
    where: {
      eventType: 'STATUS_CHANGED',
      fromStatus: 'TRIAL',
      toStatus: { [Op.in]: ['ACTIVE', 'SUSPENDED', 'CLOSED'] },
      createdAt: { [Op.gte]: from, [Op.lt]: to },
    },
    attributes: ['toStatus'],
  });
  const converted = rows.filter(r => r.toStatus === 'ACTIVE').length;
  const ended = rows.length;
  const ratePct = ended === 0 ? null : Math.round((converted * 1000) / ended) / 10;
  return { converted, ended, ratePct };
}

// ------------------------------------------------------------------ manual actions (8.8 to 8.14)
const checkVersion = (s: Society, version: number) => {
  if (s.version !== version) throw staleVersion();
};
const platformSource = { triggerSource: 'PLATFORM_USER' as const, manual: true };

export async function extendTrial(
  ctx: Ctx,
  societyId: number,
  input: { days: number; reason: string; version: number },
) {
  return sequelize.transaction(async t => {
    const s = await lockSociety(societyId, t);
    checkVersion(s, input.version);
    const fromSuspended = s.status === 'SUSPENDED' && s.suspensionCause === 'TRIAL_EXPIRED';
    if (s.status !== 'TRIAL' && !fromSuspended) throw invalidTransition();
    if (s.trialExtendedCount >= (await setting('lifecycle.trialMaxExtensions')))
      throw new UnprocessableError('TRIAL_EXTENSION_LIMIT', 'No trial extensions are left');
    const base = fromSuspended ? now() : (s.trialEndsAt ?? now());
    const trialEndsAt = addDays(base, input.days);
    const from = s.status;
    if (fromSuspended) {
      await transition(
        ctx,
        s,
        {
          ...platformSource,
          to: 'TRIAL',
          triggerCode: 'MANUAL_TRIAL_EXTENSION',
          reason: input.reason,
          trialEndsAt,
          metadata: { days: input.days, trialEndsAt: trialEndsAt.toISOString() },
          silent: true,
        },
        t,
      );
    } else {
      s.trialEndsAt = trialEndsAt;
      s.version += 1;
    }
    s.trialExtendedCount += 1;
    if (!fromSuspended) s.updatedBy = ctx.user?.id ?? null;
    await s.save({ transaction: t });
    await writeEvent(
      ctx,
      societyId,
      {
        eventType: 'TRIAL_EXTENDED',
        fromStatus: from,
        toStatus: 'TRIAL',
        triggerSource: 'PLATFORM_USER',
        triggerCode: 'MANUAL_TRIAL_EXTENSION',
        reason: input.reason,
        metadata: { days: input.days, trialEndsAt: trialEndsAt.toISOString() },
      },
      t,
    );
    if (!fromSuspended)
      await audit(
        ctx,
        {
          action: AUDIT.trialExtended,
          entityType: 'society',
          entityId: societyId,
          entityLabel: s.name,
          societyId,
          after: { days: input.days, trialEndsAt },
          reason: input.reason,
        },
        t,
      );
    await subscriptions.extendTrial(societyId, trialEndsAt, t);
    notifyAfterCommit(t, 'societies.trial_extended', () => groups.billingAdmins(societyId), {
      societyName: s.name,
      trialEndsAt: trialEndsAt.toISOString(),
    });
    return {
      id: societyId,
      status: s.status,
      trialEndsAt: trialEndsAt.toISOString(),
      trialExtendedCount: s.trialExtendedCount,
      version: s.version,
    };
  });
}

/** Maps module 04 plan errors to the module 05 code (`422 PLAN_NOT_AVAILABLE`). */
export const mapPlanError = (err: unknown): never => {
  if (
    err instanceof AppError &&
    ['PLAN_INACTIVE', 'PLAN_NOT_SELF_SERVE', 'PLAN_NOT_FOUND'].includes(err.code)
  )
    throw new UnprocessableError('PLAN_NOT_AVAILABLE', 'This plan is not available');
  throw err;
};

export async function convert(
  ctx: Ctx,
  societyId: number,
  input: {
    planKey?: 'STARTER' | 'STANDARD' | 'PREMIUM' | 'ENTERPRISE';
    billingCycle: 'MONTHLY' | 'ANNUAL';
    customPricePerFlatPaise?: number;
    reason: string;
    version: number;
  },
) {
  return sequelize.transaction(async t => {
    const s = await lockSociety(societyId, t);
    checkVersion(s, input.version);
    if (s.status !== 'TRIAL' && !(s.status === 'SUSPENDED' && s.suspensionCause === 'TRIAL_EXPIRED'))
      throw invalidTransition();
    if (input.customPricePerFlatPaise && input.planKey !== 'ENTERPRISE')
      throw new UnprocessableError('CUSTOM_PRICE_ENTERPRISE_ONLY', 'A custom price is only for Enterprise');
    const paid = await subscriptions
      .startPaid(
        ctx,
        {
          societyId,
          planKey: input.planKey,
          billingCycle: input.billingCycle,
          customPricePerFlatPaise: input.customPricePerFlatPaise,
        },
        t,
      )
      .catch(mapPlanError);
    await transition(
      ctx,
      s,
      {
        ...platformSource,
        to: 'ACTIVE',
        triggerCode: 'MANUAL_CONVERT',
        reason: input.reason,
        relatedEntityType: 'subscription',
        relatedEntityId: paid.subscriptionId,
        auditAction: AUDIT.converted,
      },
      t,
    );
    const summary = (await subscriptions.summaryForSocieties([societyId])).get(societyId);
    return {
      id: societyId,
      status: 'ACTIVE' as const,
      activatedAt: s.activatedAt!.toISOString(),
      planKey: summary?.planKey ?? input.planKey ?? null,
      billingCycle: input.billingCycle,
      version: s.version,
    };
  });
}

export async function suspend(
  ctx: Ctx,
  societyId: number,
  input: { reasonCategory: string; reason: string; version: number },
) {
  return sequelize.transaction(async t => {
    const s = await lockSociety(societyId, t);
    checkVersion(s, input.version);
    if (!['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(s.status)) throw invalidTransition();
    await transition(
      ctx,
      s,
      {
        ...platformSource,
        to: 'SUSPENDED',
        triggerCode: 'MANUAL_SUSPEND',
        suspensionCause: 'MANUAL',
        reason: input.reason,
        reasonCategory: input.reasonCategory,
      },
      t,
    );
    return {
      id: societyId,
      status: 'SUSPENDED' as const,
      suspendedAt: s.suspendedAt!.toISOString(),
      suspensionCause: 'MANUAL' as const,
      version: s.version,
    };
  });
}

export async function reactivate(
  ctx: Ctx,
  societyId: number,
  input: { reason: string; graceUntil?: string; version: number },
) {
  return sequelize.transaction(async t => {
    const s = await lockSociety(societyId, t);
    checkVersion(s, input.version);
    if (s.status !== 'SUSPENDED') throw invalidTransition();
    const overdue = await societyPorts().billing.hasOverdueInvoice(societyId, t);
    if (s.suspensionCause === 'TRIAL_EXPIRED' && !(await subscriptions.hasPaidSubscription(societyId, t)))
      throw new UnprocessableError(
        'NO_PAID_SUBSCRIPTION',
        'This trial has ended without a paid plan. Extend the trial or convert instead.',
      );
    if (overdue && !input.graceUntil)
      throw new UnprocessableError('GRACE_DATE_REQUIRED', 'Overdue invoices exist. Give a grace date.');
    if (!overdue && input.graceUntil)
      throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
        { field: 'graceUntil', message: 'Not allowed when no invoice is overdue' },
      ]);
    const holdUntil = input.graceUntil ? new Date(input.graceUntil) : null;
    if (holdUntil) {
      const ms = holdUntil.getTime() - now().getTime();
      if (ms < 86_400_000 || ms > 30 * 86_400_000)
        throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
          { field: 'graceUntil', message: 'Must be 1 to 30 days from now' },
        ]);
    }
    await transition(
      ctx,
      s,
      {
        ...platformSource,
        to: overdue ? 'PAST_DUE' : 'ACTIVE',
        triggerCode: 'MANUAL_REACTIVATE',
        reason: input.reason,
        suspensionHoldUntil: holdUntil,
        auditAction: AUDIT.reactivated,
        metadata: holdUntil ? { graceUntil: holdUntil.toISOString() } : null,
      },
      t,
    );
    if (holdUntil)
      await writeEvent(
        ctx,
        societyId,
        {
          eventType: 'GRACE_GRANTED',
          fromStatus: 'PAST_DUE',
          toStatus: 'PAST_DUE',
          triggerSource: 'PLATFORM_USER',
          triggerCode: 'MANUAL_REACTIVATE',
          reason: input.reason,
          metadata: { graceUntil: holdUntil.toISOString() },
        },
        t,
      );
    return {
      id: societyId,
      status: s.status as 'ACTIVE' | 'PAST_DUE',
      suspensionHoldUntil: s.suspensionHoldUntil?.toISOString() ?? null,
      version: s.version,
    };
  });
}

export async function close(
  ctx: Ctx,
  societyId: number,
  input: {
    closureReason: ClosureReason;
    reason: string;
    confirmName: string;
    notifyResidents?: boolean;
    version: number;
  },
) {
  return sequelize.transaction(async t => {
    const s = await lockSociety(societyId, t);
    checkVersion(s, input.version);
    if (s.status === 'CLOSED') throw invalidTransition();
    if (input.confirmName.trim() !== s.name.trim())
      throw new UnprocessableError(
        'CONFIRM_NAME_MISMATCH',
        'The name you typed does not match the society name',
      );
    await transition(
      ctx,
      s,
      {
        ...platformSource,
        to: 'CLOSED',
        triggerCode: 'MANUAL_CLOSE',
        closureReason: input.closureReason,
        reasonCategory: input.closureReason,
        reason: input.reason,
        notifyResidents: input.notifyResidents ?? true,
      },
      t,
    );
    const exp = await latestClosureExportId(societyId, t);
    return {
      id: societyId,
      status: 'CLOSED' as const,
      closedAt: s.closedAt!.toISOString(),
      purgeAfter: s.purgeAfter!.toISOString(),
      closureExportId: exp,
      version: s.version,
    };
  });
}

export async function reopen(
  ctx: Ctx,
  societyId: number,
  input: {
    planKey: 'STARTER' | 'STANDARD' | 'PREMIUM' | 'ENTERPRISE';
    billingCycle: 'MONTHLY' | 'ANNUAL';
    customPricePerFlatPaise?: number;
    reason: string;
    version: number;
  },
) {
  return sequelize.transaction(async t => {
    const s = await lockSociety(societyId, t);
    checkVersion(s, input.version);
    if (s.status !== 'CLOSED') throw invalidTransition();
    if (s.purgedAt) throw societyPurged();
    if (input.customPricePerFlatPaise && input.planKey !== 'ENTERPRISE')
      throw new UnprocessableError('CUSTOM_PRICE_ENTERPRISE_ONLY', 'A custom price is only for Enterprise');
    const paid = await subscriptions
      .startPaid(
        ctx,
        {
          societyId,
          planKey: input.planKey,
          billingCycle: input.billingCycle,
          customPricePerFlatPaise: input.customPricePerFlatPaise,
        },
        t,
      )
      .catch(mapPlanError);
    await transition(
      ctx,
      s,
      {
        ...platformSource,
        to: 'ACTIVE',
        triggerCode: 'MANUAL_REOPEN',
        reason: input.reason,
        relatedEntityType: 'subscription',
        relatedEntityId: paid.subscriptionId,
        auditAction: AUDIT.reopened,
      },
      t,
    );
    return { id: societyId, status: 'ACTIVE' as const, version: s.version };
  });
}

export async function setPurgeHold(
  ctx: Ctx,
  societyId: number,
  input: { reason: string; version: number },
  set: boolean,
) {
  return sequelize.transaction(async t => {
    const s = await lockSociety(societyId, t);
    checkVersion(s, input.version);
    if (s.purgedAt) throw societyPurged();
    if (!set && !s.purgeHoldReason)
      throw new ConflictError('INVALID_STATE', 'This society has no purge hold');
    const before = { purgeHoldReason: s.purgeHoldReason };
    s.purgeHoldReason = set ? input.reason : null;
    s.purgeHoldSetAt = set ? now() : null;
    s.version += 1;
    s.updatedBy = ctx.user?.id ?? null;
    await s.save({ transaction: t });
    await writeEvent(
      ctx,
      societyId,
      {
        eventType: set ? 'PURGE_HOLD_SET' : 'PURGE_HOLD_CLEARED',
        fromStatus: s.status,
        toStatus: s.status,
        triggerSource: 'PLATFORM_USER',
        triggerCode: 'MANUAL_PURGE_HOLD',
        reason: input.reason,
      },
      t,
    );
    await audit(
      ctx,
      {
        action: set ? AUDIT.purgeHoldSet : AUDIT.purgeHoldCleared,
        entityType: 'society',
        entityId: societyId,
        entityLabel: s.name,
        societyId,
        before,
        after: { purgeHoldReason: s.purgeHoldReason },
        reason: input.reason,
      },
      t,
    );
    return {
      id: societyId,
      purgeHoldReason: s.purgeHoldReason,
      purgeAfter: s.purgeAfter?.toISOString() ?? null,
      version: s.version,
    };
  });
}
