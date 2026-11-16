import { Op, UniqueConstraintError, type WhereOptions } from 'sequelize';
import { AutopayMandate, PaymentOrder, Unit, User, sequelize } from '../../models';
import { addHours, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import { flags } from '../subscriptions/subscriptions.public';
import { getEntitlements, featureAllowed, featureNotInPlan } from '../subscriptions/entitlements.service';
import type { FeatureMode } from '../subscriptions/entitlements.service';
import { systemCtx, type Ctx } from '../../types/context';
import {
  AUDIT,
  ENT,
  ERR,
  FLAG_UPI_AUTOPAY,
  NOTIFY,
  type MandateEndReason,
  type MandateType,
} from './payments.constants';
import { paymentsPorts } from './payments.ports';
import { n, setting, societyToday, withSociety } from './payments.shared';
import type { AnyCtx, Transaction } from './payments.types';

/**
 * AutoPay mandates (sections 5.9, 6.5, 8.8, 8.20; BR-12-47 to BR-12-49). Mandates are created at the gateway (`createMandate`),
 * authorised by the payer outside the app, activated by the gateway event (`handleMandateEvent`) and charged by the jobs in
 * `payments.autopay.jobs.ts`. Everything is behind the flag `payments.upi_autopay` and the entitlement of the mandate type.
 */
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const LIVE = ['PENDING_AUTH', 'ACTIVE', 'PAUSED'] as const;
const AUTH_HOURS = 48;
export const CAP_LIMITS: Record<MandateType, { min: number; max: number }> = {
  UPI_AUTOPAY: { min: 100, max: 1_500_000 },
  ENACH: { min: 100, max: 100_000_000 },
};
const ENT_OF: Record<MandateType, typeof ENT.upiAutopay | typeof ENT.enach> = {
  UPI_AUTOPAY: ENT.upiAutopay,
  ENACH: ENT.enach,
};

const mandateNotFound = () => new NotFoundError(ERR.mandateNotFound, 'Mandate not found');
const staleVersion = () =>
  new ConflictError(ERR.staleVersion, 'Someone else changed this mandate. Reload to see the change.');
const invalidState = (m: string) => new ConflictError(ERR.invalidState, m);
const gatewayError = () =>
  new AppError(502, ERR.gatewayError, 'The payment gateway could not complete this. Try again.');
const notAvailable = () =>
  new UnprocessableError(ERR.autopayNotAvailable, 'AutoPay is not available for this society');

// ------------------------------------------------------------------ gate (BR-12-47)
/**
 * `402 FEATURE_NOT_IN_PLAN` unless the plan has the key of the mandate type (either key when the type is not known yet), then
 * `422 AUTOPAY_NOT_AVAILABLE` while the flag `payments.upi_autopay` is off for the society.
 */
export async function assertAutopayAvailable(
  societyId: number,
  type?: MandateType,
  mode: FeatureMode = 'write',
): Promise<void> {
  const ent = await getEntitlements(societyId);
  if (type) {
    if (!featureAllowed(ent, ENT_OF[type], mode)) throw await featureNotInPlan(ent, ENT_OF[type]);
  } else if (!featureAllowed(ent, ENT.upiAutopay, mode) && !featureAllowed(ent, ENT.enach, mode))
    throw await featureNotInPlan(ent, ENT.upiAutopay);
  if (!(await flags.isFlagOn(FLAG_UPI_AUTOPAY, { societyId }))) throw notAvailable();
}

// ------------------------------------------------------------------ DTOs
export interface MandateDto {
  id: number;
  unitId: number;
  unitLabel: string;
  payerUserId: number;
  payerName: string;
  mandateType: MandateType;
  maxAmountPaise: number;
  debitDaysBeforeDue: number;
  startDate: string;
  endDate: string;
  status: string;
  payerInstrumentMasked: string | null;
  consecutiveFailures: number;
  lastDebitAt: string | null;
  lastDebitStatus: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  version: number;
}

async function toDtos(rows: AutopayMandate[]): Promise<MandateDto[]> {
  const units = await Unit.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(r => n(r.unitId)))] } },
    attributes: ['id', 'label'],
  });
  const users = await User.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(r => n(r.payerUserId)))] } },
    attributes: ['id', 'name'],
  });
  const ul = new Map(units.map(u => [n(u.id), u.label]));
  const un = new Map(users.map(u => [n(u.id), u.name ?? '']));
  return rows.map(r => ({
    id: n(r.id),
    unitId: n(r.unitId),
    unitLabel: ul.get(n(r.unitId)) ?? '',
    payerUserId: n(r.payerUserId),
    payerName: un.get(n(r.payerUserId)) ?? '',
    mandateType: r.mandateType,
    maxAmountPaise: n(r.maxAmountPaise),
    debitDaysBeforeDue: n(r.debitDaysBeforeDue),
    startDate: r.startDate,
    endDate: r.endDate,
    status: r.status,
    payerInstrumentMasked: r.payerInstrumentMasked,
    consecutiveFailures: n(r.consecutiveFailures),
    lastDebitAt: iso(r.lastDebitAt),
    lastDebitStatus: r.lastDebitStatus,
    activatedAt: iso(r.activatedAt),
    pausedAt: iso(r.pausedAt),
    endedAt: iso(r.endedAt),
    endReason: r.endReason,
    createdAt: iso(r.createdAt)!,
    version: n(r.version),
  }));
}

const pageOf = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

export async function listMine(
  ctx: Ctx,
  q: { status?: string; unitId?: number; page: number; limit: number },
) {
  const where: WhereOptions[] = [
    {
      societyId: ctx.society!.id,
      payerUserId: ctx.user!.id,
      unitId: { [Op.in]: ctx.unitIds?.length ? ctx.unitIds : [0] },
    },
  ];
  if (q.status) where.push({ status: q.status });
  if (q.unitId) where.push({ unitId: q.unitId });
  const { rows, count } = await AutopayMandate.findAndCountAll({
    where: { [Op.and]: where },
    order: [['id', 'DESC']],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { items: await toDtos(rows), pagination: pageOf(q.page, q.limit, count) };
}

export async function listAdmin(
  societyId: number,
  q: { status?: string; unitId?: number; mandateType?: string; page: number; limit: number },
) {
  const where: WhereOptions[] = [{ societyId }];
  if (q.status) where.push({ status: q.status });
  if (q.unitId) where.push({ unitId: q.unitId });
  if (q.mandateType) where.push({ mandateType: q.mandateType });
  const { rows, count } = await AutopayMandate.findAndCountAll({
    where: { [Op.and]: where },
    order: [['id', 'DESC']],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { items: await toDtos(rows), pagination: pageOf(q.page, q.limit, count) };
}

// ------------------------------------------------------------------ create (8.8)
export interface MandateCreateInput {
  unitId: number;
  mandateType: MandateType;
  maxAmountPaise: number;
  startDate: string;
  endDate: string;
  debitDaysBeforeDue?: number;
}

const addYears = (ymd: string, years: number): string => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
};
const addDaysYmd = (ymd: string, days: number): string =>
  new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

export async function createMandate(ctx: Ctx, input: MandateCreateInput) {
  const societyId = ctx.society!.id;
  const userId = ctx.user!.id;
  await assertAutopayAvailable(societyId, input.mandateType);
  if (!ctx.unitIds?.includes(input.unitId)) throw new NotFoundError(ERR.unitNotFound, 'Unit not found');
  const limit = CAP_LIMITS[input.mandateType];
  if (input.maxAmountPaise < limit.min || input.maxAmountPaise > limit.max)
    throw new UnprocessableError(
      ERR.mandateLimitExceeded,
      'The limit per debit is outside what this mandate type allows',
      [
        {
          field: 'maxAmountPaise',
          message: 'Outside the allowed range',
          minPaise: limit.min,
          maxPaise: limit.max,
        },
      ],
    );
  const today = await societyToday(societyId);
  const errors = [];
  if (input.startDate < today || input.startDate > addDaysYmd(today, 60))
    errors.push({ field: 'startDate', message: 'Must be today or within the next 60 days' });
  if (input.endDate <= input.startDate)
    errors.push({ field: 'endDate', message: 'Must be after the start date' });
  else if (input.endDate > addYears(input.startDate, 10))
    errors.push({ field: 'endDate', message: 'At most 10 years after the start date' });
  if (errors.length) throw new ValidationError(errors);
  const account = await paymentsPorts().gateways.accountFor(societyId);
  if (!account || !account.isActive || !account.supportsMandates) throw notAvailable();
  const debitDays =
    input.debitDaysBeforeDue ?? Number(await setting(societyId, 'payments.autopayDebitDaysBeforeDue'));

  try {
    return await sequelize.transaction(async t => {
      const live = await AutopayMandate.findOne({
        where: { societyId, unitId: input.unitId, payerUserId: userId, status: { [Op.in]: [...LIVE] } },
        attributes: ['id'],
        transaction: t,
      });
      if (live) throw new ConflictError(ERR.mandateExists, 'You already have a mandate for this flat');
      const m = await AutopayMandate.create(
        {
          societyId,
          unitId: input.unitId,
          payerUserId: userId,
          mandateType: input.mandateType,
          gatewayAccountId: account.id,
          gatewayMandateId: null,
          gatewayCustomerId: null,
          payerInstrumentMasked: null,
          maxAmountPaise: input.maxAmountPaise,
          debitDaysBeforeDue: debitDays,
          startDate: input.startDate,
          endDate: input.endDate,
          status: 'PENDING_AUTH',
          consecutiveFailures: 0,
          lastDebitAt: null,
          lastDebitStatus: null,
          activatedAt: null,
          pausedAt: null,
          endedAt: null,
          endReason: null,
          createdBy: userId,
          updatedBy: null,
          version: 1,
        },
        { transaction: t },
      );
      let auth: { mandateId: string; authUrl: string };
      try {
        auth = await paymentsPorts()
          .gateways.clientFor(account)
          .createMandate({
            societyGatewayAccountId: String(account.id),
            customerRef: `user-${userId}`,
            maxAmountPaise: input.maxAmountPaise,
            frequency: 'AS_PRESENTED',
            startDate: input.startDate,
            endDate: input.endDate,
          });
      } catch (err) {
        logger.error({ err, societyId }, 'gateway createMandate failed');
        throw gatewayError();
      }
      await m.update(
        { gatewayMandateId: auth.mandateId, gatewayCustomerId: `user-${userId}` },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.mandateCreated,
          entityType: 'autopay_mandate',
          entityId: n(m.id),
          societyId,
          after: {
            unitId: input.unitId,
            mandateType: input.mandateType,
            maxAmountPaise: input.maxAmountPaise,
            startDate: input.startDate,
            endDate: input.endDate,
          },
        },
        t,
      );
      return {
        mandateId: n(m.id),
        status: 'PENDING_AUTH' as const,
        authorisation: {
          ...(input.mandateType === 'UPI_AUTOPAY' ? { upiIntentUrl: auth.authUrl } : {}),
          redirectUrl: auth.authUrl,
        },
        expiresAt: addHours(m.createdAt ?? now(), AUTH_HOURS).toISOString(),
      };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError)
      throw new ConflictError(ERR.mandateExists, 'You already have a mandate for this flat');
    throw err;
  }
}

// ------------------------------------------------------------------ pause, resume, cancel
async function loadLocked(societyId: number, id: number, t: Transaction, payerUserId?: number) {
  const m = await AutopayMandate.findOne({
    where: { id, societyId, ...(payerUserId ? { payerUserId } : {}) },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!m) throw mandateNotFound();
  return m;
}

async function mine(ctx: Ctx, id: number, version: number, t: Transaction) {
  const m = await loadLocked(ctx.society!.id, id, t, ctx.user!.id);
  if (n(m.version) !== version) throw staleVersion();
  return m;
}

export async function pauseMandate(ctx: Ctx, id: number, version: number) {
  const societyId = ctx.society!.id;
  await assertAutopayAvailable(societyId);
  return sequelize.transaction(async t => {
    const m = await mine(ctx, id, version, t);
    if (m.status !== 'ACTIVE') throw invalidState('Only an active mandate can be paused');
    await m.update(
      { status: 'PAUSED', pausedAt: now(), updatedBy: ctx.user!.id, version: n(m.version) + 1 },
      { transaction: t },
    );
    await audit(ctx, auditOf(AUDIT.mandatePaused, m, { status: 'ACTIVE' }), t);
    return (await toDtos([m]))[0]!;
  });
}

export async function resumeMandate(ctx: Ctx, id: number, version: number) {
  const societyId = ctx.society!.id;
  await assertAutopayAvailable(societyId);
  return sequelize.transaction(async t => {
    const m = await mine(ctx, id, version, t);
    if (m.status !== 'PAUSED') throw invalidState('Only a paused mandate can be resumed');
    if (m.endDate < (await societyToday(societyId)))
      throw invalidState('The mandate has passed its end date');
    await m.update(
      {
        status: 'ACTIVE',
        pausedAt: null,
        consecutiveFailures: 0,
        updatedBy: ctx.user!.id,
        version: n(m.version) + 1,
      },
      { transaction: t },
    );
    await audit(ctx, auditOf(AUDIT.mandateResumed, m, { status: 'PAUSED' }), t);
    return (await toDtos([m]))[0]!;
  });
}

const auditOf = (action: string, m: AutopayMandate, before: unknown, reason?: string | null) => ({
  action,
  entityType: 'autopay_mandate',
  entityId: n(m.id),
  societyId: n(m.societyId),
  before,
  after: { status: m.status, endReason: m.endReason },
  reason: reason ?? null,
});

/** Cancels the debits that are still waiting for this mandate (orders `CREATED` that the gateway has not been asked to charge). */
async function cancelWaitingOrders(m: AutopayMandate, reason: string, t: Transaction): Promise<void> {
  await PaymentOrder.update(
    {
      status: 'CANCELLED',
      cancelledAt: now(),
      cancelReason: reason.slice(0, 300),
      version: sequelize.literal('version + 1') as never,
    },
    {
      where: { mandateId: n(m.id), sourceType: 'AUTOPAY', status: 'CREATED', gatewayOrderId: null },
      transaction: t,
    },
  );
}

/**
 * Moves a live mandate to CANCELLED (payer, admin, unit link ended, closure, gateway). `fromGateway` skips the gateway call
 * (6.5). A gateway failure refuses the cancel (`502`), so debits never go on by mistake.
 */
async function endMandate(
  ctx: AnyCtx,
  m: AutopayMandate,
  reason: MandateEndReason,
  opts: { fromGateway?: boolean; note?: string | null; actorUserId?: number | null },
  t: Transaction,
): Promise<void> {
  if (!(LIVE as readonly string[]).includes(m.status)) throw invalidState('This mandate has already ended');
  if (!opts.fromGateway && m.gatewayMandateId) {
    try {
      const account = await paymentsPorts().gateways.getAccount(n(m.gatewayAccountId));
      if (account) await paymentsPorts().gateways.clientFor(account).cancelMandate(m.gatewayMandateId);
    } catch (err) {
      logger.error({ err, mandateId: n(m.id) }, 'gateway cancelMandate failed');
      throw gatewayError();
    }
  }
  const before = { status: m.status };
  await m.update(
    {
      status: 'CANCELLED',
      endedAt: now(),
      endReason: reason,
      updatedBy: opts.actorUserId ?? ctx.user?.id ?? null,
      version: n(m.version) + 1,
    },
    { transaction: t },
  );
  await cancelWaitingOrders(m, `Mandate ${reason.toLowerCase()}`, t);
  await audit(ctx as Ctx, auditOf(AUDIT.mandateCancelled, m, before, opts.note ?? reason), t);
}

export async function cancelMine(ctx: Ctx, id: number, input: { version: number; reason?: string }) {
  return sequelize.transaction(async t => {
    const m = await mine(ctx, id, input.version, t);
    await endMandate(ctx, m, 'PAYER_CANCELLED', { note: input.reason ?? null }, t);
    return (await toDtos([m]))[0]!;
  });
}

export async function cancelByAdmin(ctx: Ctx, id: number, input: { version: number; reason: string }) {
  const societyId = ctx.society!.id;
  return sequelize.transaction(async t => {
    const m = await loadLocked(societyId, id, t);
    if (n(m.version) !== input.version) throw staleVersion();
    await endMandate(ctx, m, 'ADMIN_CANCELLED', { note: input.reason }, t);
    const payer = n(m.payerUserId);
    t.afterCommit(() => {
      void paymentsPorts()
        .notifications.send(NOTIFY.mandateCancelled, [payer], { mandateId: n(m.id), reason: input.reason })
        .catch(err => logger.error({ err }, 'mandate cancelled notification failed'));
    });
    return (await toDtos([m]))[0]!;
  });
}

// ------------------------------------------------------------------ hooks for other modules
/** Module 09 hook (via `payments.onUnitLinkEnded`, part 12.1 calls it): the payer's live mandates of that flat end (BR-12-49). */
export async function cancelMandatesForUnitLink(
  ctx: AnyCtx,
  unitId: number,
  userId: number,
  t: Transaction,
): Promise<number> {
  const societyId = ctx.society?.id;
  const rows = await AutopayMandate.findAll({
    where: {
      ...(societyId ? { societyId } : {}),
      unitId,
      payerUserId: userId,
      status: { [Op.in]: [...LIVE] },
    },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const m of rows) await endGatewayAfterCommit(ctx, m, 'UNIT_LINK_ENDED', t);
  return rows.length;
}

/** The gateway call of a system-made end runs after commit and only logs on failure (the local state must not block a unit move or a closure). */
async function endGatewayAfterCommit(
  ctx: AnyCtx,
  m: AutopayMandate,
  reason: MandateEndReason,
  t: Transaction,
) {
  const gatewayMandateId = m.gatewayMandateId;
  const accountId = n(m.gatewayAccountId);
  await endMandate(withSociety(ctx, n(m.societyId)), m, reason, { fromGateway: true }, t);
  if (!gatewayMandateId) return;
  t.afterCommit(() => {
    void (async () => {
      try {
        const account = await paymentsPorts().gateways.getAccount(accountId);
        if (account) await paymentsPorts().gateways.clientFor(account).cancelMandate(gatewayMandateId);
      } catch (err) {
        logger.error({ err, mandateId: n(m.id) }, 'gateway cancelMandate after commit failed');
      }
    })();
  });
}

/** Module 05 (8.26, society closure): every live mandate of the society ends (`SOCIETY_CLOSED`). Returns how many. */
export async function cancelAllForSociety(societyId: number, t: Transaction): Promise<number> {
  const rows = await AutopayMandate.findAll({
    where: { societyId, status: { [Op.in]: [...LIVE] } },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const ctx = withSociety(systemCtx('closure'), societyId);
  for (const m of rows) await endGatewayAfterCommit(ctx, m, 'SOCIETY_CLOSED', t);
  return rows.length;
}

export interface MandateEvent {
  societyId: number;
  /** `mandate.activated`, `mandate.rejected` or `mandate.cancelled` (the gateway's event, section 6.5). */
  type: string;
  gatewayMandateId: string;
  eventId?: string;
  payerInstrumentMasked?: string;
}
export type MandateEventOutcome = 'ACTIVATED' | 'FAILED' | 'CANCELLED' | 'IGNORED' | 'NOT_FOUND';

/** The mandate part of the webhook (6.5): PENDING_AUTH to ACTIVE or FAILED, any live mandate to CANCELLED. Idempotent. */
export async function handleMandateEvent(
  baseCtx: AnyCtx,
  ev: MandateEvent,
  outerTx?: Transaction,
): Promise<MandateEventOutcome> {
  if (!['mandate.activated', 'mandate.rejected', 'mandate.cancelled'].includes(ev.type)) return 'IGNORED';
  const run = async (t: Transaction): Promise<MandateEventOutcome> => {
    const m = await AutopayMandate.findOne({
      where: { societyId: ev.societyId, gatewayMandateId: ev.gatewayMandateId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!m) return 'NOT_FOUND';
    const ctx = withSociety(baseCtx, ev.societyId);
    const reason = ev.eventId ? `Gateway event ${ev.eventId}` : null;
    if (ev.type === 'mandate.activated') {
      if (m.status !== 'PENDING_AUTH') return 'IGNORED';
      await m.update(
        {
          status: 'ACTIVE',
          activatedAt: now(),
          payerInstrumentMasked: ev.payerInstrumentMasked ?? m.payerInstrumentMasked,
          version: n(m.version) + 1,
        },
        { transaction: t },
      );
      await audit(ctx as Ctx, auditOf(AUDIT.mandateActivated, m, { status: 'PENDING_AUTH' }, reason), t);
      notifyPayer(t, NOTIFY.mandateActivated, m, {});
      return 'ACTIVATED';
    }
    if (ev.type === 'mandate.rejected') {
      if (m.status !== 'PENDING_AUTH') return 'IGNORED';
      await m.update(
        { status: 'FAILED', endedAt: now(), endReason: 'AUTH_FAILED', version: n(m.version) + 1 },
        { transaction: t },
      );
      await audit(ctx as Ctx, auditOf(AUDIT.mandateFailed, m, { status: 'PENDING_AUTH' }, reason), t);
      return 'FAILED';
    }
    if (!(LIVE as readonly string[]).includes(m.status)) return 'IGNORED';
    await endMandate(ctx, m, 'GATEWAY_CANCELLED', { fromGateway: true, note: reason }, t);
    notifyPayer(t, NOTIFY.mandateCancelled, m, {});
    return 'CANCELLED';
  };
  return outerTx ? run(outerTx) : sequelize.transaction(run);
}

export function notifyPayer(
  t: Transaction,
  template: string,
  m: AutopayMandate,
  data: Record<string, unknown>,
) {
  const payer = n(m.payerUserId);
  t.afterCommit(() => {
    void paymentsPorts()
      .notifications.send(template, [payer], { mandateId: n(m.id), unitId: n(m.unitId), ...data })
      .catch(err => logger.error({ err, template }, 'mandate notification failed'));
  });
}

export { LIVE as LIVE_MANDATE_STATUSES, auditOf as mandateAudit, addDaysYmd };
