import { randomBytes } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import { Session, User, UserPasskey, UserRecoveryCode, sequelize } from '../../models';
import type { RevokeReason } from '../../models/session.model';
import { addDays, addHours, addMinutes, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import { enqueue } from '../../lib/queue';
import { disconnectSession, emitToUser } from '../../lib/realtime';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { hashRefreshToken, randomToken, sha256Hex } from './auth.crypto';
import { ports } from './auth.ports';
import { signAccessToken, deviceLabelFor, setSessionCookies, type SessionCookies } from './auth.tokens';
import {
  APP_RULES,
  REFRESH_GRACE_MS,
  type Amr,
  type AuthMe,
  type AuthUserView,
  type ClientApp,
  type MembershipView,
} from './auth.types';
import { safeAfterCommit } from './auth.util';

const invalidState = (msg = 'This action is not allowed here') => new AppError(409, 'INVALID_STATE', msg);

// ------------------------------------------------------------------ policies
const SCOPES: Record<ClientApp, string[]> = {
  PLATFORM: [],
  ADMIN: ['society'],
  GATE: ['gate'],
  WORK: ['work'],
  RESIDENT: ['society', 'gate', 'work'],
};
export const membershipFitsApp = (m: MembershipView, app: ClientApp): boolean =>
  SCOPES[app].includes(m.roleScope);

/** BR-02-36: idle timeout in minutes for an app (and the active society for ADMIN). */
export async function idleMinutesFor(app: ClientApp, societyId: number | null): Promise<number> {
  if (app === 'PLATFORM') return ports().getPlatformSetting('security.idleMinutes');
  if (app === 'ADMIN' && societyId)
    return (await ports().societySettings.getSessionPolicy(societyId)).adminIdleMinutes;
  return APP_RULES[app].idleMinutes;
}

/** BR-02-40: step-up window in minutes. */
export async function stepUpMinutesFor(app: ClientApp, societyId: number | null): Promise<number> {
  if (app === 'PLATFORM') return ports().getPlatformSetting('security.stepUpMinutes');
  if (app === 'ADMIN' && societyId)
    return (await ports().societySettings.getSessionPolicy(societyId)).stepUpMinutes;
  return 5;
}

export async function userRequiresMfa(u: Pick<User, 'id' | 'platformRoleId'>): Promise<boolean> {
  return Boolean(u.platformRoleId) || (await ports().authAccess.userRequiresMfa(u.id!));
}

/** BR-02-44: last used society if still active and fitting, else the only fitting one, else none. */
export function resolveActiveSociety(
  lastSocietyId: number | null,
  app: ClientApp,
  memberships: MembershipView[],
): { activeSocietyId: number | null; needsSocietyPick: boolean } {
  if (app === 'PLATFORM') return { activeSocietyId: null, needsSocietyPick: false };
  const fit = memberships.filter(m => m.status === 'ACTIVE' && membershipFitsApp(m, app));
  const societyIds = [...new Set(fit.map(m => m.societyId))];
  if (lastSocietyId && societyIds.includes(lastSocietyId))
    return { activeSocietyId: lastSocietyId, needsSocietyPick: false };
  if (societyIds.length === 1) return { activeSocietyId: societyIds[0], needsSocietyPick: false };
  return { activeSocietyId: null, needsSocietyPick: societyIds.length >= 2 };
}

// ------------------------------------------------------------------ views
export async function buildUserView(u: User): Promise<AuthUserView> {
  const [passkeyCount, recoveryCodesRemaining, mfaMandatory, passwordSet] = await Promise.all([
    UserPasskey.count({ where: { userId: u.id } }),
    UserRecoveryCode.count({ where: { userId: u.id, usedAt: null } }),
    userRequiresMfa(u),
    hasPassword(u.id!),
  ]);
  return {
    id: u.id!,
    name: u.name,
    mobile: u.mobile,
    email: u.email,
    emailVerified: u.emailVerifiedAt !== null,
    photoFileId: u.photoFileId,
    locale: u.locale,
    status: u.status,
    hasPassword: passwordSet,
    mfaEnabled: u.mfaEnabledAt !== null,
    mfaMandatory,
    passkeyCount,
    recoveryCodesRemaining,
    needsProfile: u.name === null,
    deletionScheduledFor: u.deletionScheduledFor?.toISOString() ?? null,
    version: u.version,
  };
}

/** `hasPassword` needs the secret column, which the default scope hides. */
async function hasPassword(userId: number): Promise<boolean> {
  const u = await User.scope('withSecrets').findByPk(userId, { attributes: ['id', 'passwordHash'] });
  return Boolean(u?.passwordHash);
}

/** The object returned by `GET /auth/me` and inside every SIGNED_IN result (section 8.13). */
export async function buildMe(user: User, s: Session): Promise<AuthMe> {
  const app = s.clientApp;
  const support = s.supportGrantId !== null;
  const all = support
    ? []
    : (await ports().authAccess.listMemberships(user.id!)).filter(m => membershipFitsApp(m, app));
  const fitActiveSocieties = new Set(all.filter(m => m.status === 'ACTIVE').map(m => m.societyId));
  const view = await buildUserView(user);
  const societyId = s.activeSocietyId;
  const [permissions, platformPermissions, features, grant, stepUpMinutes] = await Promise.all([
    societyId && !support ? ports().authAccess.getPermissions(user.id!, societyId) : Promise.resolve([]),
    app === 'PLATFORM' ? ports().authAccess.getPlatformPermissions(user.id!) : Promise.resolve([]),
    societyId ? ports().entitlements.getFeatures(societyId) : Promise.resolve([]),
    support ? ports().supportAccess.getGrantSummary(s.supportGrantId!) : Promise.resolve(null),
    stepUpMinutesFor(app, societyId),
  ]);
  return {
    user: view,
    session: {
      id: s.id!,
      clientApp: app,
      authTime: s.authTime.toISOString(),
      idleTimeoutMinutes: s.idleTimeoutMinutes,
      stepUpMinutes,
      absoluteExpiresAt: s.absoluteExpiresAt.toISOString(),
      amr: s.amr,
    },
    memberships: all,
    activeSocietyId: societyId,
    needsSocietyPick: !support && app !== 'PLATFORM' && societyId === null && fitActiveSocieties.size >= 2,
    platformRole: user.platformRoleId ? { id: user.platformRoleId } : null,
    permissions,
    platformPermissions,
    features,
    supportGrant: grant ? { id: grant.id, scope: grant.scope, endsAt: grant.endsAt.toISOString() } : null,
  };
}

// ------------------------------------------------------------------ create
export interface CreateSessionInput {
  userId: number;
  clientApp: ClientApp;
  amr: Amr[];
  mfaVerified: boolean;
  activeSocietyId?: number | null;
  supportGrantId?: number | null;
  authTime?: Date;
  expiresAt?: Date;
}

export interface CreatedSession {
  sessionId: number;
  me: AuthMe;
  cookies: SessionCookies;
}

/**
 * Creates the session row and the tokens (BR-02-31, BR-02-32, BR-02-36, BR-02-45). Callers decide first-factor,
 * second-step and app-access rules; this function enforces the rules that belong to the session itself (PIN, system user).
 */
export async function createSession(
  ctx: Ctx,
  tx: Transaction,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const user = await User.findByPk(input.userId, { transaction: tx, lock: tx.LOCK.UPDATE });
  if (!user) throw new NotFoundError('NOT_FOUND', 'User not found');
  if (user.status === 'SYSTEM' || (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION'))
    throw invalidState();
  const usesPin = input.amr.includes('PIN');
  if (usesPin && (input.clientApp !== 'GATE' || input.mfaVerified || input.amr.length !== 1))
    throw invalidState();
  if (input.supportGrantId && (input.clientApp !== 'ADMIN' || !input.activeSocietyId)) throw invalidState();

  const t = now();
  const app = input.clientApp;
  const rules = APP_RULES[app];
  let societyId = input.activeSocietyId;
  if (app === 'PLATFORM') societyId = null;
  else if (societyId === undefined) {
    const memberships = (await ports().authAccess.listMemberships(user.id!)).filter(m =>
      membershipFitsApp(m, app),
    );
    societyId = resolveActiveSociety(user.lastSocietyId, app, memberships).activeSocietyId;
  }
  const idleTimeoutMinutes = usesPin ? 840 : await idleMinutesFor(app, societyId ?? null);
  let absolute = usesPin
    ? addHours(t, 14)
    : app === 'ADMIN' || app === 'PLATFORM'
      ? addHours(t, rules.absoluteHours)
      : addHours(t, rules.absoluteHours);
  if (input.expiresAt && input.expiresAt < absolute) absolute = input.expiresAt;

  const deviceId = ctx.deviceId ?? randomBytes(32).toString('base64url');
  const deviceIdHash = sha256Hex(deviceId);
  const earlier = await Session.count({ where: { userId: user.id }, transaction: tx });
  const seenDevice = earlier
    ? await Session.count({
        where: { userId: user.id, deviceIdHash, createdAt: { [Op.gte]: addDays(t, -90) } },
        transaction: tx,
      })
    : 0;
  const deviceLabel = deviceLabelFor(ctx.userAgent);

  const row = await Session.create(
    {
      userId: user.id!,
      clientApp: app,
      activeSocietyId: societyId ?? null,
      refreshTokenHash: hashRefreshToken(randomBytes(16).toString('hex')),
      previousTokenHash: null,
      rotatedAt: null,
      rotationCount: 0,
      amr: input.amr,
      mfaVerified: input.mfaVerified,
      authTime: input.authTime ?? t,
      lastSeenAt: t,
      idleTimeoutMinutes,
      absoluteExpiresAt: absolute,
      deviceIdHash,
      deviceLabel,
      userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 255) : null,
      ipFirst: ctx.ip ? ctx.ip.slice(0, 45) : null,
      ipLast: ctx.ip ? ctx.ip.slice(0, 45) : null,
      revokedAt: null,
      revokeReason: null,
      revokedBy: null,
      supportGrantId: input.supportGrantId ?? null,
    },
    { transaction: tx },
  );
  const refreshToken = `${row.id}.${randomToken()}`;
  row.refreshTokenHash = hashRefreshToken(refreshToken);
  await row.save({ transaction: tx });

  user.lastLoginAt = t;
  if (societyId && !input.supportGrantId && societyId !== user.lastSocietyId) user.lastSocietyId = societyId;
  await user.save({ transaction: tx });

  await audit(
    ctx,
    {
      action: 'auth.session.created',
      entityType: 'session',
      entityId: row.id!,
      after: { clientApp: app, amr: input.amr, deviceLabel, ip: ctx.ip },
      actor: { userId: user.id!, name: user.name ?? 'User', role: 'user' },
      supportGrantId: input.supportGrantId ?? null,
      societyId: input.supportGrantId ? (societyId ?? null) : null,
    },
    tx,
  );
  if (earlier > 0 && seenDevice === 0)
    safeAfterCommit(tx, () => notify('auth.new_device_login', [{ userId: user.id! }], { deviceLabel }));

  const me = await buildMe(user, row);
  return {
    sessionId: row.id!,
    me,
    cookies: {
      accessToken: signAccessToken(user.id!, row.id!, app),
      refreshToken,
      sessionId: row.id!,
      absoluteExpiresAt: absolute,
      newDeviceId: ctx.deviceId ? undefined : deviceId,
    },
  };
}

// ------------------------------------------------------------------ revoke
/** Side effects after a revoke commits: realtime, socket disconnect, communication hook (BR-02-62). */
function afterRevoke(tx: Transaction, rows: { id: number; userId: number }[], reason: RevokeReason): void {
  tx.afterCommit(async () => {
    for (const r of rows) {
      try {
        emitToUser(r.userId, 'auth.session.revoked', { sessionId: r.id, reason });
        disconnectSession(r.id);
      } catch (err) {
        logger.warn({ err }, 'realtime emit failed');
      }
      try {
        await ports().communicationHooks.onSessionRevoked(r.id);
      } catch (err) {
        logger.warn({ err, sessionId: r.id }, 'onSessionRevoked hook failed; retrying through the queue');
        await enqueue('auth', 'auth:session-revoked-hook', { sessionId: r.id }).catch(() => undefined);
      }
    }
  });
}

/** Revokes the given (already loaded, active) sessions in the caller's transaction. */
export async function revokeSessionRows(
  rows: Session[],
  reason: RevokeReason,
  tx: Transaction,
  revokedBy: number | null = null,
): Promise<number> {
  const live = rows.filter(r => r.revokedAt === null);
  if (!live.length) return 0;
  const t = now();
  for (const r of live) {
    r.revokedAt = t;
    r.revokeReason = reason;
    r.revokedBy = revokedBy;
    await r.save({ transaction: tx });
  }
  afterRevoke(
    tx,
    live.map(r => ({ id: r.id!, userId: r.userId })),
    reason,
  );
  return live.length;
}

/** Revokes every active session of a user, optionally one app or all but one session. */
export async function revokeUserSessionsInternal(
  ctx: Ctx,
  userId: number,
  opts: { reason: RevokeReason; clientApp?: ClientApp; exceptSessionId?: number },
  tx: Transaction,
): Promise<number> {
  const rows = await Session.findAll({
    where: {
      userId,
      revokedAt: null,
      ...(opts.clientApp ? { clientApp: opts.clientApp } : {}),
      ...(opts.exceptSessionId ? { id: { [Op.ne]: opts.exceptSessionId } } : {}),
    },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  return revokeSessionRows(rows, opts.reason, tx, ctx.user?.id ?? null);
}

/** Revokes one session in its own transaction (idle and absolute expiry found by the middleware, reuse, job). */
export async function revokeSessionById(
  sessionId: number,
  reason: RevokeReason,
  revokedBy: number | null = null,
): Promise<boolean> {
  return sequelize.transaction(async tx => {
    const s = await Session.findByPk(sessionId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!s) return false;
    return (await revokeSessionRows([s], reason, tx, revokedBy)) === 1;
  });
}

// ------------------------------------------------------------------ public namespace (section 8.30)
export const sessions = {
  /**
   * The single function that creates sessions. Sets the cookies on `res`. `supportGrantId` is not accepted here:
   * only the support redeem path (8.32) creates support sessions.
   */
  async issueForUser(
    ctx: Ctx,
    tx: Transaction,
    res: Pick<import('express').Response, 'cookie'>,
    input: Omit<CreateSessionInput, 'supportGrantId'> & { supportGrantId?: undefined | null },
  ): Promise<{ sessionId: number; me: AuthMe }> {
    if (input.supportGrantId) throw invalidState();
    const c = await createSession(ctx, tx, input);
    setSessionCookies(res, c.cookies);
    return { sessionId: c.sessionId, me: c.me };
  },

  async setActiveSociety(
    sessionId: number,
    societyId: number,
    opts: { supportGrantId?: number | null },
    tx?: Transaction,
  ): Promise<void> {
    const run = async (t: Transaction) => {
      const s = await Session.findByPk(sessionId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!s || s.revokedAt) throw new NotFoundError('SESSION_NOT_FOUND', 'Session not found');
      if (s.clientApp === 'PLATFORM') throw invalidState();
      if (s.supportGrantId && opts.supportGrantId !== undefined && opts.supportGrantId !== s.supportGrantId)
        throw invalidState();
      const grant = opts.supportGrantId ?? s.supportGrantId;
      const before = s.activeSocietyId;
      s.activeSocietyId = societyId;
      if (opts.supportGrantId) s.supportGrantId = opts.supportGrantId;
      s.idleTimeoutMinutes = await idleMinutesFor(s.clientApp, societyId);
      await s.save({ transaction: t });
      if (!grant)
        await User.update({ lastSocietyId: societyId }, { where: { id: s.userId }, transaction: t });
      const u = await User.findByPk(s.userId, { transaction: t });
      await audit(
        { requestId: 'service', ip: '', userAgent: '' },
        {
          action: 'auth.session.society_switched',
          entityType: 'session',
          entityId: s.id!,
          societyId,
          before: { societyId: before },
          after: { societyId },
          actor: { userId: s.userId, name: u?.name ?? 'User', role: 'user' },
          supportGrantId: grant,
        },
        t,
      );
    };
    if (tx) return run(tx);
    await sequelize.transaction(run);
  },

  /** Module 03 calls this inside its transaction (role changes, MFA policy). */
  revokeUserSessions(
    ctx: Ctx,
    userId: number,
    opts: { reason: 'ADMIN_REVOKED' | 'MFA_POLICY_CHANGED'; clientApp?: ClientApp },
    tx: Transaction,
  ): Promise<number> {
    return revokeUserSessionsInternal(ctx, userId, opts, tx);
  },

  /** Module 05 calls this after its commit when a grant leaves ACTIVE. Own transaction, idempotent (BR-02-57). */
  async revokeBySupportGrant(grantId: number): Promise<number> {
    return sequelize.transaction(async tx => {
      const rows = await Session.findAll({
        where: { supportGrantId: grantId, revokedAt: null },
        transaction: tx,
        lock: tx.LOCK.UPDATE,
      });
      return revokeSessionRows(rows, 'SUPPORT_GRANT_ENDED', tx, null);
    });
  },
};

// ------------------------------------------------------------------ refresh (BR-02-32, BR-02-33, BR-02-39)
export interface RefreshResult {
  cookies: SessionCookies;
  accessExpiresAt: Date;
  absoluteExpiresAt: Date;
}

const REFRESH_RE = /^(\d{1,19})\.[A-Za-z0-9_-]{43}$/;
export const sessionIdFromRefresh = (raw: string | undefined): number | null => {
  const m = raw ? REFRESH_RE.exec(raw) : null;
  return m ? Number(m[1]) : null;
};

export const isExpiredIdle = (s: Session, at: Date): boolean =>
  at.getTime() - s.lastSeenAt.getTime() > s.idleTimeoutMinutes * 60_000;

export async function refreshSession(ctx: Ctx, rawRefresh: string | undefined): Promise<RefreshResult> {
  const sid = sessionIdFromRefresh(rawRefresh);
  if (!sid || !rawRefresh) throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Sign in again');
  const hash = hashRefreshToken(rawRefresh);

  type Outcome = { error: AppError } | { result: RefreshResult };
  const outcome = await sequelize.transaction(async (tx): Promise<Outcome> => {
    const s = await Session.findByPk(sid, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!s || s.revokedAt) return { error: new AppError(401, 'REFRESH_TOKEN_INVALID', 'Sign in again') };
    const t = now();
    const user = await User.findByPk(s.userId, { transaction: tx });
    const isCurrent = hash === s.refreshTokenHash;
    if (!isCurrent) {
      if (
        s.previousTokenHash === hash &&
        s.rotatedAt &&
        t.getTime() - s.rotatedAt.getTime() <= REFRESH_GRACE_MS
      )
        return { error: new AppError(401, 'REFRESH_SUPERSEDED', 'Another tab already refreshed; retry') };
      await revokeSessionRows([s], 'TOKEN_REUSE', tx, null);
      await audit(
        ctx,
        {
          action: 'auth.session.reuse_detected',
          entityType: 'session',
          entityId: s.id!,
          actor: { userId: s.userId, name: user?.name ?? 'User', role: 'user' },
        },
        tx,
      );
      safeAfterCommit(tx, () => notify('auth.refresh_reuse_detected', [{ userId: s.userId }], {}));
      return { error: new AppError(401, 'REFRESH_TOKEN_REUSED', 'Someone may have copied your sign-in') };
    }
    if (!user || (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION')) {
      await revokeSessionRows([s], 'USER_DISABLED', tx, null);
      return { error: new AppError(401, 'SESSION_REVOKED', 'Your session was ended') };
    }
    if (t >= s.absoluteExpiresAt) {
      await revokeSessionRows([s], s.supportGrantId ? 'SUPPORT_GRANT_ENDED' : 'EXPIRED', tx, null);
      return {
        error: new AppError(401, 'SESSION_EXPIRED', 'Your session has expired', [
          { field: 'reason', message: 'ABSOLUTE' },
        ]),
      };
    }
    if (isExpiredIdle(s, t)) {
      await revokeSessionRows([s], 'IDLE_TIMEOUT', tx, null);
      return {
        error: new AppError(401, 'SESSION_EXPIRED', 'You were signed out for inactivity', [
          { field: 'reason', message: 'IDLE' },
        ]),
      };
    }
    if (s.supportGrantId && !(await ports().supportAccess.isGrantActive(s.supportGrantId))) {
      await revokeSessionRows([s], 'SUPPORT_GRANT_ENDED', tx, null);
      return { error: new AppError(401, 'SESSION_REVOKED', 'Support access has ended') };
    }
    const refreshToken = `${s.id}.${randomToken()}`;
    s.previousTokenHash = s.refreshTokenHash;
    s.refreshTokenHash = hashRefreshToken(refreshToken);
    s.rotatedAt = t;
    s.rotationCount += 1;
    await s.save({ transaction: tx });
    return {
      result: {
        cookies: {
          accessToken: signAccessToken(s.userId, s.id!, s.clientApp),
          refreshToken,
          sessionId: s.id!,
          absoluteExpiresAt: s.absoluteExpiresAt,
        },
        accessExpiresAt: addMinutes(t, 15),
        absoluteExpiresAt: s.absoluteExpiresAt,
      },
    };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

// ------------------------------------------------------------------ counting (BR-02-59, BR-02-60)
export const countActiveUsers = async (societyId: number, days: number): Promise<number> => {
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new ValidationError([{ field: 'days', message: 'Must be an integer from 1 to 90' }]);
  const since = addDays(now(), -days);
  const rows = (await Session.findAll({
    where: { activeSocietyId: societyId, supportGrantId: null, lastSeenAt: { [Op.gte]: since } },
    attributes: ['userId'],
    include: [
      {
        model: User,
        attributes: ['id'],
        where: { status: { [Op.ne]: 'SYSTEM' }, platformRoleId: null },
        required: true,
      },
    ],
    group: ['Session.userId'],
    raw: true,
  })) as unknown[];
  return rows.length;
};

export const countActiveUsersPlatform = async (since: Date): Promise<number> => {
  const t = now();
  if (!(since instanceof Date) || Number.isNaN(since.getTime()) || since > t || since < addDays(t, -90))
    throw new ValidationError([{ field: 'since', message: 'Must be a date within the last 90 days' }]);
  const rows = (await Session.findAll({
    where: { supportGrantId: null, lastSeenAt: { [Op.gte]: since } },
    attributes: ['userId'],
    include: [
      {
        model: User,
        attributes: ['id'],
        where: { status: { [Op.ne]: 'SYSTEM' }, platformRoleId: null },
        required: true,
      },
    ],
    group: ['Session.userId'],
    raw: true,
  })) as unknown[];
  return rows.length;
};
