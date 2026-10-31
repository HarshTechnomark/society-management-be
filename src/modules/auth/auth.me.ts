import { Session, User, sequelize } from '../../models';
import { LOCALES } from '../../models/user.model';
import { addHours, now } from '../../lib/clock';
import { emitToUser } from '../../lib/realtime';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { appUrl, requireApp } from './auth.apps';
import { classify, consumeOrThrow, findToken, issueToken, linkError, ttl } from './auth.links';
import { ports } from './auth.ports';
import {
  buildMe,
  buildUserView,
  createSession,
  revokeSessionRows,
  sessions,
  userRequiresMfa,
  membershipFitsApp,
} from './auth.sessions';
import type { SessionCookies } from './auth.tokens';
import type { AuthMe, AuthUserView } from './auth.types';
import { lockUser } from './auth.users';
import { safeAfterCommit } from './auth.util';

const actorOf = (ctx: Ctx) => ({ userId: ctx.user!.id, name: ctx.user!.name ?? 'User', role: 'user' });

/** `GET /auth/me`. "Stay signed in" calls this, so it always bumps `lastSeenAt` (section 8.13). */
export async function getMe(ctx: Ctx): Promise<AuthMe> {
  const s = (await Session.findByPk(ctx.session!.id))!;
  const t = now();
  s.lastSeenAt = t;
  if (ctx.ip) s.ipLast = ctx.ip.slice(0, 45);
  await s.save({ fields: ['lastSeenAt', 'ipLast', 'updatedAt'] });
  const u = (await User.findByPk(ctx.user!.id))!;
  return buildMe(u, s);
}

/** `PATCH /auth/me` (section 8.14). */
export async function patchMe(
  ctx: Ctx,
  input: { version: number; name?: string; locale?: (typeof LOCALES)[number]; photoFileId?: number | null },
): Promise<AuthUserView> {
  return sequelize.transaction(async tx => {
    const u = await lockUser(ctx.user!.id, tx);
    if (u.version !== input.version)
      throw new ConflictError('STALE_VERSION', 'Your profile changed elsewhere. Reload and try again.');
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (input.name !== undefined && input.name !== u.name) {
      before.name = u.name;
      after.name = input.name;
      u.name = input.name;
    }
    if (input.locale !== undefined && input.locale !== u.locale) {
      before.locale = u.locale;
      after.locale = input.locale;
      u.locale = input.locale;
    }
    if (input.photoFileId !== undefined && input.photoFileId !== u.photoFileId) {
      if (input.photoFileId === null) await ports().files.unlinkUserPhoto(ctx, u.photoFileId!, tx);
      else await ports().files.linkUserPhoto(ctx, input.photoFileId, u.id!, tx);
      before.photoFileId = u.photoFileId;
      after.photoFileId = input.photoFileId;
      u.photoFileId = input.photoFileId;
    }
    if (Object.keys(after).length) {
      u.version += 1;
      u.updatedBy = u.id!;
      await u.save({ transaction: tx });
      await audit(
        ctx,
        {
          action: 'auth.user.updated',
          entityType: 'user',
          entityId: u.id!,
          before,
          after,
          actor: actorOf(ctx),
        },
        tx,
      );
      safeAfterCommit(tx, () => emitToUser(u.id!, 'auth.profile.updated', { version: u.version }));
    }
    return buildUserView(u, tx);
  });
}

/** `POST /auth/switch-society` (section 8.15, BR-02-44). */
export async function switchSociety(ctx: Ctx, societyId: number): Promise<AuthMe> {
  const s0 = ctx.session!;
  if (s0.clientApp === 'PLATFORM')
    throw new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'Platform sessions have no society');
  if (s0.supportGrantId)
    throw new ForbiddenError('SUPPORT_SESSION_LOCKED', 'Support sessions cannot switch society');
  const u = (await User.findByPk(ctx.user!.id))!;
  const mine = (await ports().authAccess.listMemberships(u.id!)).filter(m => m.societyId === societyId);
  if (!mine.length) throw new NotFoundError('SOCIETY_NOT_FOUND', 'Society not found');
  const ok = mine.find(m => m.status === 'ACTIVE' && membershipFitsApp(m, s0.clientApp));
  if (!ok) throw new ForbiddenError('MEMBERSHIP_NOT_ACTIVE', 'Your membership in this society is not active');
  if ((await userRequiresMfa(u)) && !u.mfaEnabledAt)
    throw new ForbiddenError('MFA_ENROLLMENT_REQUIRED', 'Set up two-step sign-in first');
  await sessions.setActiveSociety(s0.id, societyId, {});
  const s = (await Session.findByPk(s0.id))!;
  return buildMe((await User.findByPk(u.id!))!, s);
}

/** `POST /auth/logout` (section 8.12). */
export async function logout(ctx: Ctx): Promise<void> {
  await sequelize.transaction(async tx => {
    const s = await Session.findByPk(ctx.session!.id, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!s) return;
    if ((await revokeSessionRows([s], 'LOGOUT', tx, ctx.user!.id)) === 1)
      await audit(
        ctx,
        {
          action: 'auth.session.revoked',
          entityType: 'session',
          entityId: s.id!,
          after: { reason: 'LOGOUT' },
          actor: actorOf(ctx),
        },
        tx,
      );
  });
}

// ------------------------------------------------------------------ support hand-off (8.31, 8.32)
export async function issueSupportHandoff(ctx: Ctx, grantId: number) {
  const s = ctx.session!;
  if (s.clientApp !== 'PLATFORM')
    throw new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'Hand-off starts on the platform host');
  const perms = await ports().authAccess.getPlatformPermissions(ctx.user!.id);
  if (!perms.includes('platform.support_access.create'))
    throw new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to do this');
  if (!s.mfaVerified) throw new ForbiddenError('MFA_ENROLLMENT_REQUIRED', 'Set up two-step sign-in first');
  const grant = await ports().supportAccess.validateForHandoff(ctx.user!.id, grantId);
  return sequelize.transaction(async tx => {
    const t = await issueToken(ctx, tx, {
      purpose: 'SUPPORT_HANDOFF',
      prefix: 'sh_',
      userId: ctx.user!.id,
      sessionId: s.id,
      payload: { grantId: grant.grantId, societyId: grant.societyId },
      expiresAt: ttl(60_000),
    });
    await audit(
      ctx,
      {
        action: 'auth.support_handoff.issued',
        entityType: 'session',
        entityId: s.id,
        societyId: grant.societyId,
        supportGrantId: grant.grantId,
        actor: actorOf(ctx),
      },
      tx,
    );
    return {
      handoffToken: t.raw,
      redeemUrl: appUrl('ADMIN', `/support/enter#token=${t.raw}`),
      expiresAt: t.expiresAt.toISOString(),
      societyId: grant.societyId,
    };
  });
}

export async function redeemSupportHandoff(
  ctx: Ctx,
  rawToken: string,
): Promise<{ me: AuthMe; cookies: SessionCookies }> {
  const app = requireApp(ctx.clientApp);
  if (app !== 'ADMIN')
    throw new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'Open the hand-off link on the admin host');
  return sequelize.transaction(async tx => {
    const token = await findToken(rawToken, 'SUPPORT_HANDOFF', tx, true);
    const problem = classify(token);
    if (problem) throw linkError(problem);
    await consumeOrThrow(tx, token!);
    const gone = () => new AppError(401, 'SESSION_REVOKED', 'The platform session is no longer valid');
    const platform = token!.sessionId ? await Session.findByPk(token!.sessionId, { transaction: tx }) : null;
    const t = now();
    if (!platform || platform.revokedAt || !platform.mfaVerified || t >= platform.absoluteExpiresAt)
      throw gone();
    if (t.getTime() - platform.lastSeenAt.getTime() > platform.idleTimeoutMinutes * 60_000) throw gone();
    const user = await User.findByPk(platform.userId, { transaction: tx });
    if (!user || user.status !== 'ACTIVE' || !user.platformRoleId) throw gone();
    const grantId = Number(token!.payload?.grantId);
    const grant = await ports().supportAccess.validateForHandoff(user.id!, grantId);
    const created = await createSession(
      {
        ...ctx,
        user: {
          id: user.id!,
          name: user.name,
          mobile: user.mobile,
          email: user.email,
          platformRoleId: user.platformRoleId,
          status: user.status,
        },
      },
      tx,
      {
        userId: user.id!,
        clientApp: 'ADMIN',
        amr: platform.amr,
        mfaVerified: platform.mfaVerified,
        activeSocietyId: grant.societyId,
        supportGrantId: grant.grantId,
        authTime: platform.authTime,
        expiresAt: new Date(Math.min(grant.endsAt.getTime(), addHours(t, 12).getTime())),
      },
    );
    await ports().supportAccess.markEntered(grant.grantId, tx);
    await audit(
      ctx,
      {
        action: 'auth.support_handoff.redeemed',
        entityType: 'session',
        entityId: created.sessionId,
        societyId: grant.societyId,
        supportGrantId: grant.grantId,
        actor: { userId: user.id!, name: user.name ?? 'User', role: 'user' },
      },
      tx,
    );
    return { me: created.me, cookies: created.cookies };
  });
}
