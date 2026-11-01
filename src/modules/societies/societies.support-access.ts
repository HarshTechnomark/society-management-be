import { Op, UniqueConstraintError, type Transaction, type WhereOptions } from 'sequelize';
import { AuditLog, Society, SupportAccessGrant, User, sequelize } from '../../models';
import type {
  ConsentStatus,
  GrantEndReason,
  SupportGrantStatus,
} from '../../models/support-access-grant.model';
import { addMinutes, now, nowMs } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { enqueueAfterCommit, usesRedis } from '../../lib/queue';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { sessions } from '../auth/auth.public';
import type { SupportGrantInfo } from '../auth/auth.ports';
import { getPlatformPermissionsOf } from '../access-control/access-control.access';
import { setting } from './societies.ports';
import { AUDIT, JOBS, QUEUE, type SupportScope } from './societies.types';
import { emitAfterCommit, groups, notifyAfterCommit, send } from './societies.notify';
import { isWrite, lockedClosed } from './societies.guard';

/** Support access grants (section 6.3, 8.18 to 8.23, BR-05-25 to BR-05-33, BR-05-37). */

export const grantNotFound = () =>
  new NotFoundError('SUPPORT_GRANT_NOT_FOUND', 'Support access request not found');
const invalidState = (m = 'This request is not in a state that allows this') =>
  new ConflictError('INVALID_STATE', m);
const accessExpired = () => new ForbiddenError('SUPPORT_ACCESS_EXPIRED', 'Support access has ended');
const staleVersion = () =>
  new ConflictError('STALE_VERSION', 'Someone else changed this request. Reload and try again.');

export const grantCode = (id: number): string => `G-${String(id).padStart(4, '0')}`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ------------------------------------------------------------------ cache `sag:<userId>:<societyId>`
const cacheKey = (userId: number, societyId: number) => `sag:${userId}:${societyId}`;
interface CachedGrant {
  id: number;
  scope: SupportScope;
  endsAt: string;
}
async function cacheDel(g: { platformUserId: number; societyId: number }): Promise<void> {
  try {
    await kv().cacheDel(cacheKey(g.platformUserId, g.societyId));
  } catch (err) {
    logger.warn({ err }, 'support grant cache delete failed');
  }
}
/** Deletes the cache entries of the society's open grants (lifecycle changes). */
export async function clearGrantCacheForSociety(societyId: number): Promise<void> {
  const rows = await SupportAccessGrant.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['platformUserId', 'societyId'],
  });
  for (const g of rows) await cacheDel(g);
}

// ------------------------------------------------------------------ views
type GrantRow = SupportAccessGrant & {
  Society?: Society;
  requester?: User;
  decidedBy?: User | null;
};
const include = [
  { model: Society, attributes: ['id', 'name'] },
  { model: User, as: 'requester', attributes: ['id', 'name'] },
  { model: User, as: 'decidedBy', attributes: ['id', 'name'] },
];

export function grantView(g: GrantRow, o: { society?: boolean; canDecide?: boolean } = {}) {
  const requesterName = g.requester?.name ?? 'SocietyApp support';
  return {
    id: g.id!,
    code: grantCode(g.id!),
    society: { id: g.societyId, name: g.Society?.name ?? '' },
    requester: o.society
      ? { name: requesterName, firstName: requesterName.split(' ')[0] }
      : { id: g.platformUserId, name: requesterName },
    scope: g.scope,
    reason: g.reason,
    ticketRef: g.ticketRef,
    durationMinutes: g.durationMinutes,
    isEmergency: g.isEmergency,
    status: g.status,
    consentStatus: g.consentStatus,
    consentRequired: g.consentRequired,
    consentExpiresAt: iso(g.consentExpiresAt),
    decidedBy: g.decidedBy ? { id: g.decidedBy.id!, name: g.decidedBy.name ?? 'Member' } : null,
    decidedAt: iso(g.decidedAt),
    decisionNote: g.decisionNote,
    startedAt: iso(g.startedAt),
    endsAt: iso(g.endsAt),
    endedAt: iso(g.endedAt),
    endReason: g.endReason,
    endNote: g.endNote,
    enteredAt: iso(g.enteredAt),
    requestCount: g.requestCount,
    writeCount: g.writeCount,
    lastActivityAt: iso(g.lastActivityAt),
    createdAt: iso(g.createdAt),
    version: g.version,
    ...(o.canDecide !== undefined ? { canDecide: o.canDecide && g.status === 'PENDING_CONSENT' } : {}),
  };
}
export type GrantView = ReturnType<typeof grantView>;

async function load(id: number, t?: Transaction): Promise<GrantRow> {
  const g = (await SupportAccessGrant.findByPk(id, { include, transaction: t })) as GrantRow | null;
  if (!g) throw grantNotFound();
  return g;
}

async function readLog(grantId: number) {
  const rows = await AuditLog.findAll({
    where: { supportGrantId: grantId },
    order: [['id', 'DESC']],
    limit: 100,
  });
  return rows
    .filter(r => r.action !== AUDIT.grantEntered && !r.action.startsWith('auth.'))
    .map(r => {
      const after = (r.after ?? {}) as { method?: string; route?: string };
      return {
        at: r.createdAt!.toISOString(),
        method: after.method ?? null,
        route: after.route ?? null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
      };
    });
}

// ------------------------------------------------------------------ leaving ACTIVE / PENDING
interface CloseInput {
  status: SupportGrantStatus;
  endReason?: GrantEndReason;
  consentStatus?: ConsentStatus;
  endNote?: string | null;
  endedBy?: number | null;
  auditAction: string;
  reason?: string | null;
  actor?: { userId: number | null; name: string; role: string };
}

/** Moves a locked grant out of PENDING_CONSENT or ACTIVE and schedules the after-commit effects. */
async function closeGrant(ctx: Ctx, g: SupportAccessGrant, c: CloseInput, t: Transaction): Promise<void> {
  const wasActive = g.status === 'ACTIVE';
  const before = { status: g.status };
  const t0 = now();
  g.status = c.status;
  if (c.consentStatus) g.consentStatus = c.consentStatus;
  if (wasActive) {
    g.endedAt = c.status === 'EXPIRED' && g.endsAt && g.endsAt < t0 ? g.endsAt : t0;
    g.endReason = c.endReason ?? null;
    g.endedByUserId = c.endedBy ?? null;
    g.endNote = c.endNote ?? null;
    g.requestCount = Math.max(g.requestCount, await requestCounter(g.id!));
  } else if (c.status === 'REVOKED' || c.status === 'CANCELLED') {
    g.endedAt = t0;
    g.endReason = c.endReason ?? null;
    g.endedByUserId = c.endedBy ?? null;
    g.endNote = c.endNote ?? null;
  }
  g.updatedBy = ctx.user?.id ?? null;
  g.version += 1;
  await g.save({ transaction: t });
  await audit(
    ctx,
    {
      action: c.auditAction,
      entityType: 'support_access_grant',
      entityId: g.id!,
      entityLabel: grantCode(g.id!),
      societyId: g.societyId,
      supportGrantId: g.id!,
      before,
      after: { status: g.status, endReason: g.endReason },
      reason: c.reason ?? null,
      actor: c.actor,
    },
    t,
  );
  const grantId = g.id!;
  const snapshot = { platformUserId: g.platformUserId, societyId: g.societyId };
  t.afterCommit(async () => {
    await cacheDel(snapshot);
    if (wasActive)
      try {
        await sessions.revokeBySupportGrant(grantId);
      } catch (err) {
        logger.error({ err, grantId }, 'revoke support sessions failed');
      }
  });
  emitAfterCommit(t, [
    {
      room: `society:${g.societyId}:admin`,
      event: 'support_access.ended',
      payload: { grantId, status: g.status },
    },
    { userId: g.platformUserId, event: 'support_access.ended', payload: { grantId, status: g.status } },
  ]);
  if (wasActive) {
    const data = {
      grantCode: grantCode(grantId),
      societyId: g.societyId,
      status: g.status,
      requestCount: g.requestCount,
      writeCount: g.writeCount,
    };
    notifyAfterCommit(
      t,
      'support_access.ended_summary',
      async () => [snapshot.platformUserId, ...(await groups.approvers(snapshot.societyId))],
      data,
    );
  }
}

// ------------------------------------------------------------------ request (8.19)
export interface RequestGrantInput {
  societyId: number;
  scope: SupportScope;
  durationMinutes: number;
  reason: string;
  ticketRef?: string;
  isEmergency?: boolean;
}

export async function requestGrant(ctx: Ctx, input: RequestGrantInput): Promise<GrantView> {
  const emergency = Boolean(input.isEmergency);
  if (emergency && !ctx.platformPermissions?.has('platform.support_access.approve'))
    throw new ForbiddenError('PERMISSION_DENIED', 'Only a Super Admin can open emergency access');
  if (emergency && (input.scope !== 'READ_ONLY' || input.durationMinutes > 60))
    throw new UnprocessableError(
      'EMERGENCY_SCOPE_READ_ONLY',
      'Emergency access is read only and at most 60 minutes',
    );
  const userId = ctx.user!.id;
  let id: number;
  try {
    id = await sequelize.transaction(async t => {
      const society = await Society.findByPk(input.societyId, { transaction: t, lock: t.LOCK.SHARE });
      if (!society) throw new NotFoundError('SOCIETY_NOT_FOUND', 'Society not found');
      if (society.status === 'CLOSED') throw lockedClosed();
      const open = await SupportAccessGrant.findOne({
        where: { platformUserId: userId, status: { [Op.in]: ['PENDING_CONSENT', 'ACTIVE'] } },
        transaction: t,
      });
      if (open) throw alreadyOpen();
      const t0 = now();
      const consentRequired = society.requiresSupportConsent;
      const startsNow = emergency || !consentRequired;
      const g = await SupportAccessGrant.create(
        {
          societyId: society.id!,
          platformUserId: userId,
          scope: input.scope,
          reason: input.reason,
          ticketRef: input.ticketRef ?? null,
          durationMinutes: input.durationMinutes,
          isEmergency: emergency,
          status: startsNow ? 'ACTIVE' : 'PENDING_CONSENT',
          consentRequired,
          consentStatus: emergency ? 'BYPASSED_EMERGENCY' : consentRequired ? 'PENDING' : 'NOT_REQUIRED',
          consentExpiresAt: startsNow
            ? null
            : addMinutes(t0, await setting('supportAccess.consentTimeoutMinutes')),
          decidedByUserId: null,
          decidedAt: null,
          decisionNote: null,
          startedAt: startsNow ? t0 : null,
          endsAt: startsNow ? addMinutes(t0, input.durationMinutes) : null,
          endedAt: null,
          endedByUserId: null,
          endReason: null,
          endNote: null,
          enteredAt: null,
          requestCount: 0,
          writeCount: 0,
          lastActivityAt: null,
          version: 1,
          createdBy: userId,
          updatedBy: userId,
        },
        { transaction: t },
      );
      const base = {
        entityType: 'support_access_grant',
        entityId: g.id!,
        entityLabel: grantCode(g.id!),
        societyId: society.id!,
        supportGrantId: g.id!,
        after: {
          scope: g.scope,
          durationMinutes: g.durationMinutes,
          isEmergency: emergency,
          status: g.status,
        },
      };
      await audit(ctx, { action: AUDIT.grantRequested, ...base }, t);
      if (startsNow) await audit(ctx, { action: AUDIT.grantStarted, ...base }, t);
      const sid = society.id!;
      const data = {
        societyName: society.name,
        grantCode: grantCode(g.id!),
        scope: g.scope,
        durationMinutes: g.durationMinutes,
        staffName: ctx.user?.name ?? 'SocietyApp support',
        link: `/settings/support-access/${g.id}`,
      };
      if (!startsNow) {
        notifyAfterCommit(t, 'support_access.consent_requested', () => groups.approvers(sid), data);
        emitAfterCommit(t, [
          { room: `society:${sid}:admin`, event: 'support_access.requested', payload: { grantId: g.id! } },
        ]);
      } else {
        notifyAfterCommit(
          t,
          emergency ? 'support_access.emergency_started' : 'support_access.started',
          () => groups.approvers(sid),
          data,
        );
        startedEffects(t, g);
      }
      return g.id!;
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw alreadyOpen();
    throw err;
  }
  return grantView(await load(id));
}

const alreadyOpen = () =>
  new ConflictError(
    'SUPPORT_GRANT_ALREADY_OPEN',
    'You already have a pending or active support access request',
  );

function startedEffects(t: Transaction, g: SupportAccessGrant): void {
  const payload = { grantId: g.id!, scope: g.scope, endsAt: iso(g.endsAt) };
  emitAfterCommit(t, [
    { room: `society:${g.societyId}:admin`, event: 'support_access.started', payload },
    { userId: g.platformUserId, event: 'support_access.started', payload },
  ]);
  // The delayed job only with Redis: the in-process runner would hold a timer for hours; the every-minute
  // `expire-support-grants` safety net and the per-request check (BR-05-32) cover memory mode.
  if (usesRedis() && g.endsAt)
    enqueueAfterCommit(
      t,
      QUEUE,
      JOBS.endSupportGrant,
      { grantId: g.id! },
      {
        jobId: `end-support-grant:${g.id}`,
        delayMs: Math.max(0, g.endsAt.getTime() - nowMs()),
      },
    );
}

// ------------------------------------------------------------------ platform lists and actions (8.18, 8.21)
export interface PlatformGrantQuery {
  societyId?: number;
  platformUserId?: number;
  status?: SupportGrantStatus[];
  scope?: SupportScope;
  isEmergency?: boolean;
  from?: string;
  to?: string;
  sortBy: 'createdAt' | 'startedAt' | 'endsAt' | 'status';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listPlatform(q: PlatformGrantQuery) {
  await expireDue();
  const where: WhereOptions = {};
  const w = where as Record<string | symbol, unknown>;
  if (q.societyId) w.societyId = q.societyId;
  if (q.platformUserId) w.platformUserId = q.platformUserId;
  if (q.status?.length) w.status = { [Op.in]: q.status };
  if (q.scope) w.scope = q.scope;
  if (q.isEmergency !== undefined) w.isEmergency = q.isEmergency;
  if (q.from || q.to)
    w.createdAt = {
      ...(q.from ? { [Op.gte]: new Date(`${q.from}T00:00:00.000+05:30`) } : {}),
      ...(q.to ? { [Op.lte]: new Date(`${q.to}T23:59:59.999+05:30`) } : {}),
    };
  const { rows, count } = await SupportAccessGrant.findAndCountAll({
    where,
    include,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  return { data: rows.map(r => grantView(r as GrantRow)), pagination: pageMeta(q.page, q.limit, count) };
}

export async function getPlatform(id: number) {
  await expireOne(id);
  return { ...grantView(await load(id)), readLog: await readLog(id) };
}

export async function current(ctx: Ctx) {
  const userId = ctx.user!.id;
  const g = await SupportAccessGrant.findOne({
    where: { platformUserId: userId, status: { [Op.in]: ['PENDING_CONSENT', 'ACTIVE'] } },
  });
  if (g) await expireOne(g.id!);
  const open = (await SupportAccessGrant.findOne({
    where: { platformUserId: userId, status: { [Op.in]: ['PENDING_CONSENT', 'ACTIVE'] } },
    include,
  })) as GrantRow | null;
  if (!open) return null;
  const until = open.status === 'ACTIVE' ? open.endsAt : open.consentExpiresAt;
  return {
    ...grantView(open),
    secondsLeft: until ? Math.max(0, Math.floor((until.getTime() - nowMs()) / 1000)) : null,
  };
}

async function lockGrant(id: number, t: Transaction, societyId?: number): Promise<SupportAccessGrant> {
  const g = await SupportAccessGrant.findOne({
    where: societyId ? { id, societyId } : { id },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!g) throw grantNotFound();
  return g;
}

export async function endOwn(ctx: Ctx, id: number): Promise<GrantView> {
  const outcome = await sequelize.transaction(async t => {
    const g = await lockGrant(id, t);
    if (g.platformUserId !== ctx.user!.id) throw grantNotFound();
    if (g.status === 'ACTIVE' && g.endsAt && g.endsAt <= now()) {
      await expireLocked(g, t);
      return 'expired' as const;
    }
    if (g.status !== 'ACTIVE') throw invalidState('This access is not active');
    await closeGrant(
      ctx,
      g,
      {
        status: 'ENDED',
        endReason: 'ENDED_BY_REQUESTER',
        endedBy: ctx.user!.id,
        auditAction: AUDIT.grantEnded,
      },
      t,
    );
    return 'ok' as const;
  });
  if (outcome === 'expired') throw invalidState('This access has already expired');
  return grantView(await load(id));
}

export async function cancelOwn(ctx: Ctx, id: number): Promise<GrantView> {
  await sequelize.transaction(async t => {
    const g = await lockGrant(id, t);
    if (g.platformUserId !== ctx.user!.id) throw grantNotFound();
    if (g.status !== 'PENDING_CONSENT') throw invalidState('This request is no longer pending');
    await closeGrant(
      ctx,
      g,
      {
        status: 'CANCELLED',
        consentStatus: 'CANCELLED',
        endedBy: ctx.user!.id,
        auditAction: AUDIT.grantCancelled,
      },
      t,
    );
  });
  return grantView(await load(id));
}

export async function revoke(
  ctx: Ctx,
  id: number,
  input: { reason: string; version: number },
  by: 'PLATFORM' | 'SOCIETY',
  societyId?: number,
): Promise<GrantView> {
  await sequelize.transaction(async t => {
    const g = await lockGrant(id, t, societyId);
    if (g.version !== input.version) throw staleVersion();
    const allowed = by === 'PLATFORM' ? ['PENDING_CONSENT', 'ACTIVE'] : ['ACTIVE'];
    if (!allowed.includes(g.status)) throw invalidState('This access is not active');
    await closeGrant(
      ctx,
      g,
      {
        status: 'REVOKED',
        endReason: by === 'PLATFORM' ? 'REVOKED_BY_PLATFORM' : 'REVOKED_BY_SOCIETY',
        consentStatus: g.status === 'PENDING_CONSENT' ? 'CANCELLED' : undefined,
        endNote: input.reason,
        endedBy: ctx.user!.id,
        auditAction: AUDIT.grantRevoked,
        reason: input.reason,
      },
      t,
    );
    if (by === 'SOCIETY')
      notifyAfterCommit(t, 'support_access.revoked', [g.platformUserId], {
        grantCode: grantCode(g.id!),
        reason: input.reason,
      });
  });
  return grantView(await load(id), by === 'SOCIETY' ? { society: true, canDecide: false } : {});
}

// ------------------------------------------------------------------ society side (8.23)
export async function listSociety(
  societyId: number,
  q: { status?: SupportGrantStatus[]; page: number; limit: number },
  canDecide: boolean,
) {
  await expireDue(societyId);
  const where: Record<string, unknown> = { societyId };
  if (q.status?.length) where.status = { [Op.in]: q.status };
  const { rows, count } = await SupportAccessGrant.findAndCountAll({
    where,
    include,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  return {
    data: rows.map(r => grantView(r as GrantRow, { society: true, canDecide })),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

export async function getSociety(societyId: number, id: number, canDecide: boolean) {
  const g = await SupportAccessGrant.findOne({ where: { id, societyId }, attributes: ['id'] });
  if (!g) throw grantNotFound();
  await expireOne(id);
  return { ...grantView(await load(id), { society: true, canDecide }), readLog: await readLog(id) };
}

export async function approve(ctx: Ctx, societyId: number, id: number, version: number): Promise<GrantView> {
  const outcome = await sequelize.transaction(async t => {
    const g = await lockGrant(id, t, societyId);
    if (g.status !== 'PENDING_CONSENT') throw invalidState('This request was already decided');
    if (g.version !== version) throw staleVersion();
    if (g.consentExpiresAt && g.consentExpiresAt <= now()) {
      await consentExpireLocked(g, t);
      return 'window' as const;
    }
    const t0 = now();
    g.status = 'ACTIVE';
    g.consentStatus = 'APPROVED';
    g.decidedByUserId = ctx.user!.id;
    g.decidedAt = t0;
    g.startedAt = t0;
    g.endsAt = addMinutes(t0, g.durationMinutes);
    g.version += 1;
    g.updatedBy = ctx.user!.id;
    await g.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.grantApproved,
        entityType: 'support_access_grant',
        entityId: g.id!,
        entityLabel: grantCode(g.id!),
        societyId,
        supportGrantId: null,
        after: { status: 'ACTIVE', endsAt: g.endsAt },
      },
      t,
    );
    notifyAfterCommit(t, 'support_access.approved', [g.platformUserId], {
      grantCode: grantCode(g.id!),
      endsAt: g.endsAt.toISOString(),
    });
    startedEffects(t, g);
    return 'ok' as const;
  });
  if (outcome === 'window')
    throw new ConflictError('CONSENT_WINDOW_EXPIRED', 'The time to answer this request has passed');
  return grantView(await load(id), { society: true, canDecide: true });
}

export async function deny(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
): Promise<GrantView> {
  await sequelize.transaction(async t => {
    const g = await lockGrant(id, t, societyId);
    if (g.status !== 'PENDING_CONSENT') throw invalidState('This request was already decided');
    if (g.version !== input.version) throw staleVersion();
    g.status = 'DENIED';
    g.consentStatus = 'DENIED';
    g.decidedByUserId = ctx.user!.id;
    g.decidedAt = now();
    g.decisionNote = input.reason;
    g.version += 1;
    g.updatedBy = ctx.user!.id;
    await g.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.grantDenied,
        entityType: 'support_access_grant',
        entityId: g.id!,
        entityLabel: grantCode(g.id!),
        societyId,
        supportGrantId: null,
        after: { status: 'DENIED' },
        reason: input.reason,
      },
      t,
    );
    notifyAfterCommit(t, 'support_access.denied', [g.platformUserId], {
      grantCode: grantCode(g.id!),
      reason: input.reason,
    });
  });
  return grantView(await load(id), { society: true, canDecide: true });
}

export async function getConsentSetting(societyId: number) {
  const s = await Society.findByPk(societyId, { attributes: ['id', 'requiresSupportConsent', 'version'] });
  if (!s) throw new NotFoundError('SOCIETY_NOT_FOUND', 'Society not found');
  return { requiresSupportConsent: s.requiresSupportConsent, version: s.version };
}

export async function setConsentSetting(
  ctx: Ctx,
  societyId: number,
  input: { requiresSupportConsent: boolean; version: number },
) {
  return sequelize.transaction(async t => {
    const s = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw new NotFoundError('SOCIETY_NOT_FOUND', 'Society not found');
    if (s.version !== input.version) throw new ConflictError('STALE_VERSION', 'Reload and try again');
    const before = { requiresSupportConsent: s.requiresSupportConsent };
    s.requiresSupportConsent = input.requiresSupportConsent;
    s.version += 1;
    s.updatedBy = ctx.user!.id;
    await s.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.consentChanged,
        entityType: 'society',
        entityId: societyId,
        entityLabel: s.name,
        societyId,
        before,
        after: { requiresSupportConsent: s.requiresSupportConsent },
      },
      t,
    );
    notifyAfterCommit(t, 'support_access.setting_changed', () => groups.approvers(societyId), {
      societyName: s.name,
      requiresSupportConsent: s.requiresSupportConsent,
    });
    return { requiresSupportConsent: s.requiresSupportConsent, version: s.version };
  });
}

/** Count of PENDING_CONSENT requests (society status banner). */
export async function pendingCount(societyId: number): Promise<number> {
  return SupportAccessGrant.count({
    where: { societyId, status: 'PENDING_CONSENT', consentExpiresAt: { [Op.gt]: now() } },
  });
}

/** The ACTIVE grant of a society (status endpoint, platform detail). */
export async function activeGrantOfSociety(societyId: number): Promise<GrantRow | null> {
  return (await SupportAccessGrant.findOne({
    where: { societyId, status: 'ACTIVE', endsAt: { [Op.gt]: now() } },
    include,
    order: [['id', 'DESC']],
  })) as GrantRow | null;
}

export async function openGrantOfSociety(societyId: number): Promise<GrantView | null> {
  const g = (await SupportAccessGrant.findOne({
    where: { societyId, status: { [Op.in]: ['PENDING_CONSENT', 'ACTIVE'] } },
    include,
    order: [['id', 'DESC']],
  })) as GrantRow | null;
  return g ? grantView(g) : null;
}

// ------------------------------------------------------------------ expiry (lazy and jobs)
async function expireLocked(g: SupportAccessGrant, t: Transaction): Promise<void> {
  await closeGrant(
    { requestId: 'job', ip: '', userAgent: '' },
    g,
    {
      status: 'EXPIRED',
      endReason: 'EXPIRED',
      auditAction: AUDIT.grantExpired,
      actor: { userId: null, name: 'System', role: 'system' },
    },
    t,
  );
}

async function consentExpireLocked(g: SupportAccessGrant, t: Transaction): Promise<void> {
  g.status = 'CONSENT_EXPIRED';
  g.consentStatus = 'EXPIRED';
  g.version += 1;
  await g.save({ transaction: t });
  await audit(
    { requestId: 'job', ip: '', userAgent: '' },
    {
      action: AUDIT.grantConsentExpired,
      entityType: 'support_access_grant',
      entityId: g.id!,
      entityLabel: grantCode(g.id!),
      societyId: g.societyId,
      supportGrantId: null,
      after: { status: 'CONSENT_EXPIRED' },
      actor: { userId: null, name: 'System', role: 'system' },
    },
    t,
  );
  notifyAfterCommit(t, 'support_access.consent_expired', [g.platformUserId], { grantCode: grantCode(g.id!) });
}

/** Expires one grant if its window or consent window has passed. Returns true when it changed. */
export async function expireOne(id: number): Promise<boolean> {
  return sequelize.transaction(async t => {
    const g = await SupportAccessGrant.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!g) return false;
    const t0 = now();
    if (g.status === 'ACTIVE' && g.endsAt && g.endsAt <= t0) {
      await expireLocked(g, t);
      return true;
    }
    if (g.status === 'PENDING_CONSENT' && g.consentExpiresAt && g.consentExpiresAt <= t0) {
      await consentExpireLocked(g, t);
      return true;
    }
    return false;
  });
}

/** `societies:expire-support-grants` and `expire-support-consents` (and lazily before lists). */
export async function expireDue(societyId?: number): Promise<number> {
  const t0 = now();
  const rows = await SupportAccessGrant.findAll({
    where: {
      ...(societyId ? { societyId } : {}),
      [Op.or]: [
        { status: 'ACTIVE', endsAt: { [Op.lte]: t0 } },
        { status: 'PENDING_CONSENT', consentExpiresAt: { [Op.lte]: t0 } },
      ],
    },
    attributes: ['id'],
  });
  let n = 0;
  for (const r of rows) if (await expireOne(r.id!)) n++;
  return n;
}

/** Closure (BR-05-18): ACTIVE → REVOKED, PENDING_CONSENT → CANCELLED, `endReason = SOCIETY_CLOSED`, in the close transaction. */
export async function endGrantsForClosure(ctx: Ctx, societyId: number, t: Transaction): Promise<number> {
  const rows = await SupportAccessGrant.findAll({
    where: { societyId, status: { [Op.in]: ['PENDING_CONSENT', 'ACTIVE'] } },
    transaction: t,
    lock: t.LOCK.UPDATE,
    order: [['id', 'ASC']],
  });
  for (const g of rows)
    await closeGrant(
      ctx,
      g,
      g.status === 'ACTIVE'
        ? {
            status: 'REVOKED',
            endReason: 'SOCIETY_CLOSED',
            auditAction: AUDIT.grantRevoked,
            endedBy: ctx.user?.id,
          }
        : {
            status: 'CANCELLED',
            consentStatus: 'CANCELLED',
            endReason: 'SOCIETY_CLOSED',
            auditAction: AUDIT.grantCancelled,
            endedBy: ctx.user?.id,
          },
      t,
    );
  return rows.length;
}

/** BR-05-33: open grants of a user who lost access are revoked with `USER_DISABLED`. */
export async function revokeForUser(userId: number): Promise<number> {
  const rows = await SupportAccessGrant.findAll({
    where: { platformUserId: userId, status: { [Op.in]: ['PENDING_CONSENT', 'ACTIVE'] } },
    attributes: ['id'],
  });
  for (const r of rows)
    await sequelize.transaction(async t => {
      const g = await lockGrant(r.id!, t);
      if (g.status !== 'PENDING_CONSENT' && g.status !== 'ACTIVE') return;
      await closeGrant(
        { requestId: 'job', ip: '', userAgent: '' },
        g,
        {
          status: 'REVOKED',
          endReason: 'USER_DISABLED',
          consentStatus: g.status === 'PENDING_CONSENT' ? 'CANCELLED' : undefined,
          auditAction: AUDIT.grantRevoked,
          actor: { userId: null, name: 'System', role: 'system' },
        },
        t,
      );
    });
  return rows.length;
}

// ------------------------------------------------------------------ module 03 port: resolution on every request
/**
 * `getActiveGrant(platformUserId, societyId)` (BR-05-32): the grant is checked on every request against the clock; an
 * expired ACTIVE grant is moved to EXPIRED here and the request gets `403 SUPPORT_ACCESS_EXPIRED`. Cache
 * `sag:<userId>:<societyId>` (TTL = seconds to `endsAt`). Returns null when the user never had a grant in the society.
 */
export async function getActiveGrant(
  platformUserId: number,
  societyId: number,
): Promise<{ id: number; scope: SupportScope; endsAt: Date } | null> {
  const perms = await getPlatformPermissionsOf(platformUserId);
  if (!perms.includes('platform.support_access.create')) {
    if (await revokeForUser(platformUserId)) throw accessExpired();
    return null;
  }
  try {
    const hit = await kv().cacheGet(cacheKey(platformUserId, societyId));
    if (hit) {
      const c = JSON.parse(hit) as CachedGrant;
      if (new Date(c.endsAt).getTime() > nowMs())
        return { id: c.id, scope: c.scope, endsAt: new Date(c.endsAt) };
    }
  } catch (err) {
    logger.warn({ err }, 'support grant cache read failed');
  }
  const g = await SupportAccessGrant.findOne({
    where: { platformUserId, societyId, startedAt: { [Op.ne]: null } },
    order: [['id', 'DESC']],
  });
  if (!g) return null;
  if (g.status === 'ACTIVE' && g.endsAt && g.endsAt > now()) {
    const ttl = Math.max(1, Math.floor((g.endsAt.getTime() - nowMs()) / 1000));
    try {
      await kv().cacheSet(
        cacheKey(platformUserId, societyId),
        JSON.stringify({ id: g.id!, scope: g.scope, endsAt: g.endsAt.toISOString() }),
        ttl,
      );
    } catch (err) {
      logger.warn({ err }, 'support grant cache write failed');
    }
    return { id: g.id!, scope: g.scope, endsAt: g.endsAt };
  }
  if (g.status === 'ACTIVE') await expireOne(g.id!);
  throw accessExpired();
}

// ------------------------------------------------------------------ request tracking (BR-05-31)
const tracking = new Set<Promise<void>>();
/** Test helper: wait for the read-log and counter writes of finished requests. */
export async function drainSupportTracking(): Promise<void> {
  while (tracking.size) await Promise.all([...tracking]);
}
const requestKey = (grantId: number) => `sag:req:${grantId}`;
async function requestCounter(grantId: number): Promise<number> {
  try {
    return await kv().counterGet(requestKey(grantId));
  } catch {
    return 0;
  }
}

export function onSupportRequest(input: {
  grant: { id: number; scope: SupportScope };
  societyId: number;
  userId: number;
  method: string;
  route: string;
  statusCode: number;
}): void {
  const p = (async () => {
    try {
      await kv().counterIncr(requestKey(input.grant.id));
      const okStatus = input.statusCode >= 200 && input.statusCode < 300;
      if (!okStatus) return;
      if (isWrite(input.method)) {
        await SupportAccessGrant.increment({ writeCount: 1 }, { where: { id: input.grant.id } });
        await SupportAccessGrant.update({ lastActivityAt: now() }, { where: { id: input.grant.id } });
        return;
      }
      const hit = await kv().slidingWindowHit(`sag-viewed:${input.grant.id}:${input.route}`, 300_000, 1);
      if (!hit.allowed) return;
      const u = await User.findByPk(input.userId, { attributes: ['id', 'name'] });
      await audit(
        { requestId: 'support', ip: '', userAgent: '' },
        {
          action: AUDIT.grantViewed,
          entityType: 'route',
          entityId: input.route.slice(0, 60),
          societyId: input.societyId,
          supportGrantId: input.grant.id,
          after: { method: input.method, route: input.route },
          actor: { userId: input.userId, name: u?.name ?? 'Support', role: `support:${input.grant.scope}` },
        },
      );
    } catch (err) {
      logger.warn({ err }, 'support request tracking failed');
    }
  })();
  tracking.add(p);
  void p.finally(() => tracking.delete(p));
}

/** Writes the request counters of open grants (every minute). */
export async function flushRequestCounts(): Promise<number> {
  const rows = await SupportAccessGrant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'requestCount'],
  });
  let n = 0;
  for (const g of rows) {
    const c = await requestCounter(g.id!);
    if (c > g.requestCount) {
      await SupportAccessGrant.update({ requestCount: c, lastActivityAt: now() }, { where: { id: g.id! } });
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ module 02 ports (8.20)
export async function validateForHandoff(userId: number, grantId: number): Promise<SupportGrantInfo> {
  const g = await SupportAccessGrant.findByPk(grantId);
  if (!g || g.platformUserId !== userId) throw grantNotFound();
  if (g.status === 'ACTIVE' && g.endsAt && g.endsAt <= now()) {
    await expireOne(g.id!);
    throw accessExpired();
  }
  if (g.status !== 'ACTIVE') throw invalidState('This access is not active');
  const s = await Society.findByPk(g.societyId, { attributes: ['id', 'status'] });
  if (!s || s.status === 'CLOSED') throw new AppError(423, 'SOCIETY_CLOSED', 'This society is closed');
  return { grantId: g.id!, societyId: g.societyId, scope: g.scope, endsAt: g.endsAt! };
}

export async function markEntered(grantId: number, tx: Transaction): Promise<void> {
  const g = await SupportAccessGrant.findByPk(grantId, { transaction: tx, lock: tx.LOCK.UPDATE });
  if (!g) return;
  if (!g.enteredAt) {
    g.enteredAt = now();
    await g.save({ transaction: tx, fields: ['enteredAt', 'updatedAt'] });
  }
  const u = await User.findByPk(g.platformUserId, { attributes: ['id', 'name'], transaction: tx });
  await audit(
    { requestId: 'handoff', ip: '', userAgent: '' },
    {
      action: AUDIT.grantEntered,
      entityType: 'support_access_grant',
      entityId: g.id!,
      entityLabel: grantCode(g.id!),
      societyId: g.societyId,
      supportGrantId: g.id!,
      actor: { userId: g.platformUserId, name: u?.name ?? 'Support', role: `support:${g.scope}` },
    },
    tx,
  );
}

export async function isGrantActive(grantId: number): Promise<boolean> {
  const g = await SupportAccessGrant.findByPk(grantId, { attributes: ['id', 'status', 'endsAt'] });
  return Boolean(g && g.status === 'ACTIVE' && g.endsAt && g.endsAt > now());
}

export async function getGrantSummary(grantId: number): Promise<{ id: number; scope: string; endsAt: Date }> {
  const g = await SupportAccessGrant.findByPk(grantId);
  if (!g || !g.endsAt) throw grantNotFound();
  return { id: g.id!, scope: g.scope, endsAt: g.endsAt };
}

/** Sends the ended summary directly (job path without a transaction). */
export const sendSummary = send;
