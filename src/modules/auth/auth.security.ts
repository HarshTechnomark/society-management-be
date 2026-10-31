import { Op } from 'sequelize';
import { Session, User, UserPasskey, UserRecoveryCode, sequelize } from '../../models';
import { addDays, now } from '../../lib/clock';
import { emitToUser } from '../../lib/realtime';
import { notify } from '../../lib/notify';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { hashPassword, verifyPassword } from './auth.crypto';
import { appUrl, requireApp } from './auth.apps';
import { assertNotLocked, lockedError, recordFailure, resetLock } from './auth.lockout';
import { issueToken, ttl } from './auth.links';
import {
  consumeTotpStep,
  generateRecoveryCodes,
  mfaFailure,
  startTotpSetup,
  totpStepFor,
  userWithSecrets,
  type TotpSetupView,
} from './auth.mfa';
import { createOtpChallenge, verifyOtpChallenge, type OtpSendResult } from './auth.otp';
import { assertPasswordPolicy } from './auth.password';
import { passkeyView, verifyReauthPasskey } from './auth.passkey';
import { isError } from './auth.signin';
import {
  buildUserView,
  revokeSessionRows,
  revokeUserSessionsInternal,
  userRequiresMfa,
} from './auth.sessions';
import { ports } from './auth.ports';
import { DELETION_GRACE_DAYS, mask, type AuthUserView } from './auth.types';
import { appHost } from './auth.apps';
import { lockUser } from './auth.users';
import { safeAfterCommit, txOutcome } from './auth.util';

const me = (ctx: Ctx) => ctx.user!;
const actorOf = (ctx: Ctx) => ({ userId: me(ctx).id, name: me(ctx).name ?? 'User', role: 'user' });
const profileUpdated = (tx: import('sequelize').Transaction, userId: number, version: number) =>
  safeAfterCommit(tx, () => emitToUser(userId, 'auth.profile.updated', { version }));

// ------------------------------------------------------------------ overview (8.22)
export async function securityOverview(ctx: Ctx) {
  const u = (await User.scope('withSecrets').findByPk(me(ctx).id))!;
  const [passkeys, remaining, activeSessions, mandatory] = await Promise.all([
    UserPasskey.findAll({ where: { userId: u.id }, order: [['createdAt', 'DESC']] }),
    UserRecoveryCode.count({ where: { userId: u.id, usedAt: null } }),
    Session.count({ where: { userId: u.id, revokedAt: null } }),
    userRequiresMfa(u),
  ]);
  return {
    mobile: u.mobile,
    email: u.email,
    emailVerified: u.emailVerifiedAt !== null,
    hasPassword: Boolean(u.passwordHash),
    passwordChangedAt: u.passwordChangedAt?.toISOString() ?? null,
    mfaEnabled: u.mfaEnabledAt !== null,
    mfaMandatory: mandatory,
    recoveryCodesRemaining: remaining,
    passkeys: passkeys.map(passkeyView),
    activeSessions,
    deletionScheduledFor: u.deletionScheduledFor?.toISOString() ?? null,
  };
}

// ------------------------------------------------------------------ password (8.23)
export async function changePassword(
  ctx: Ctx,
  input: { currentPassword?: string; newPassword: string },
): Promise<{ otherSessionsRevoked: number }> {
  const u0 = await userWithSecrets(me(ctx).id);
  const subject = u0.email ?? `id:${u0.id}`;
  await assertNotLocked('PASSWORD', subject);
  return txOutcome<{ otherSessionsRevoked: number }>(async tx => {
    const u = await userWithSecrets(u0.id!, tx);
    const had = Boolean(u.passwordHash);
    if (had) {
      if (!input.currentPassword)
        return {
          error: new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
            { field: 'currentPassword', message: 'Required' },
          ]),
        };
      if (!(await verifyPassword(u.passwordHash!, input.currentPassword))) {
        const f = await recordFailure('PASSWORD', subject, { userId: u.id!, ctx, tx });
        if (f.alreadyLocked) return { error: lockedError(f.retryAfterSeconds) };
        return {
          error: new UnprocessableError('CURRENT_PASSWORD_INCORRECT', 'Your current password is not correct'),
        };
      }
      if (await verifyPassword(u.passwordHash!, input.newPassword))
        return {
          error: new UnprocessableError(
            'PASSWORD_SAME_AS_CURRENT',
            'Choose a password you have not used here',
          ),
        };
    }
    try {
      await assertPasswordPolicy(input.newPassword, { email: u.email });
    } catch (e) {
      return { error: e as AppError };
    }
    u.passwordHash = await hashPassword(input.newPassword);
    u.passwordChangedAt = now();
    await u.save({ transaction: tx });
    await resetLock('PASSWORD', subject, tx);
    const n = await revokeUserSessionsInternal(
      ctx,
      u.id!,
      { reason: 'PASSWORD_CHANGED', exceptSessionId: ctx.session?.id },
      tx,
    );
    await audit(
      ctx,
      {
        action: had ? 'auth.password.changed' : 'auth.password.set',
        entityType: 'user',
        entityId: u.id!,
        actor: actorOf(ctx),
      },
      tx,
    );
    safeAfterCommit(tx, () => notify('auth.password_changed', [{ userId: u.id! }], {}));
    profileUpdated(tx, u.id!, u.version);
    return { otherSessionsRevoked: n };
  });
}

// ------------------------------------------------------------------ TOTP (8.24, 8.25)
export async function totpSetup(ctx: Ctx): Promise<TotpSetupView> {
  return sequelize.transaction(async tx => {
    const u = await userWithSecrets(me(ctx).id, tx, true);
    if (u.mfaEnabledAt) throw new ConflictError('MFA_ALREADY_ENABLED', 'Two-step sign-in is already on');
    return startTotpSetup(u, tx);
  });
}

export async function totpConfirm(ctx: Ctx, code: string): Promise<{ recoveryCodes: string[] }> {
  await assertNotLocked('MFA', String(me(ctx).id));
  return txOutcome<{ recoveryCodes: string[] }>(async tx => {
    const u = await userWithSecrets(me(ctx).id, tx);
    if (u.mfaEnabledAt)
      return { error: new ConflictError('MFA_ALREADY_ENABLED', 'Two-step sign-in is already on') };
    if (!u.totpSecretEnc)
      return { error: new ConflictError('MFA_SETUP_NOT_STARTED', 'Start the authenticator setup first') };
    const step = totpStepFor(u, code, now().getTime());
    if (step === null) return { error: await mfaFailure(ctx, u, 'TOTP_INVALID', 'TOTP', { tx }) };
    if (!(await consumeTotpStep(tx, u.id!, step)))
      return { error: await mfaFailure(ctx, u, 'TOTP_REUSED', 'TOTP', { tx }) };
    u.mfaEnabledAt = now();
    u.version += 1;
    await u.save({ transaction: tx });
    const recoveryCodes = await generateRecoveryCodes(u.id!, tx);
    await resetLock('MFA', String(u.id), tx);
    await Session.update({ mfaVerified: true }, { where: { id: ctx.session!.id }, transaction: tx });
    await audit(
      ctx,
      { action: 'auth.mfa.enabled', entityType: 'user', entityId: u.id!, actor: actorOf(ctx) },
      tx,
    );
    await audit(
      ctx,
      { action: 'auth.recovery_codes.generated', entityType: 'user', entityId: u.id!, actor: actorOf(ctx) },
      tx,
    );
    safeAfterCommit(tx, () => notify('auth.mfa_enabled', [{ userId: u.id! }], {}));
    profileUpdated(tx, u.id!, u.version);
    return { recoveryCodes };
  });
}

export async function totpDisable(ctx: Ctx): Promise<void> {
  await sequelize.transaction(async tx => {
    const u = await userWithSecrets(me(ctx).id, tx, true);
    if (!u.mfaEnabledAt) throw new ConflictError('MFA_NOT_ENABLED', 'Two-step sign-in is not on');
    if (await userRequiresMfa(u))
      throw new ConflictError('MFA_MANDATORY', 'Your role requires two-step sign-in');
    u.totpSecretEnc = null;
    u.mfaEnabledAt = null;
    u.totpLastUsedStep = null;
    u.version += 1;
    await u.save({ transaction: tx });
    await UserRecoveryCode.destroy({ where: { userId: u.id }, transaction: tx });
    await audit(
      ctx,
      { action: 'auth.mfa.disabled', entityType: 'user', entityId: u.id!, actor: actorOf(ctx) },
      tx,
    );
    safeAfterCommit(tx, () => notify('auth.mfa_disabled', [{ userId: u.id! }], {}));
    profileUpdated(tx, u.id!, u.version);
  });
}

export async function regenerateRecoveryCodes(
  ctx: Ctx,
): Promise<{ recoveryCodes: string[]; batchCreatedAt: string }> {
  return sequelize.transaction(async tx => {
    const u = await lockUser(me(ctx).id, tx);
    if (!u.mfaEnabledAt) throw new ConflictError('MFA_NOT_ENABLED', 'Two-step sign-in is not on');
    const recoveryCodes = await generateRecoveryCodes(u.id!, tx);
    await audit(
      ctx,
      { action: 'auth.recovery_codes.generated', entityType: 'user', entityId: u.id!, actor: actorOf(ctx) },
      tx,
    );
    safeAfterCommit(tx, () => notify('auth.recovery_codes_regenerated', [{ userId: u.id! }], {}));
    return { recoveryCodes, batchCreatedAt: now().toISOString() };
  });
}

// ------------------------------------------------------------------ passkeys (8.26)
export async function listPasskeys(ctx: Ctx) {
  return (await UserPasskey.findAll({ where: { userId: me(ctx).id }, order: [['createdAt', 'DESC']] })).map(
    passkeyView,
  );
}

async function ownPasskey(ctx: Ctx, id: number, tx?: import('sequelize').Transaction): Promise<UserPasskey> {
  const p = await UserPasskey.findOne({ where: { id, userId: me(ctx).id }, transaction: tx });
  if (!p) throw new NotFoundError('PASSKEY_NOT_FOUND', 'Passkey not found');
  return p;
}

export async function renamePasskey(ctx: Ctx, id: number, name: string) {
  return sequelize.transaction(async tx => {
    const p = await ownPasskey(ctx, id, tx);
    const before = p.name;
    p.name = name;
    await p.save({ transaction: tx });
    await audit(
      ctx,
      {
        action: 'auth.passkey.renamed',
        entityType: 'user',
        entityId: me(ctx).id,
        before: { name: before },
        after: { name },
        actor: actorOf(ctx),
      },
      tx,
    );
    return passkeyView(p);
  });
}

export async function removePasskey(ctx: Ctx, id: number): Promise<void> {
  await sequelize.transaction(async tx => {
    const p = await ownPasskey(ctx, id, tx);
    const name = p.name;
    await p.destroy({ transaction: tx });
    await audit(
      ctx,
      {
        action: 'auth.passkey.removed',
        entityType: 'user',
        entityId: me(ctx).id,
        before: { passkeyId: id, name },
        actor: actorOf(ctx),
      },
      tx,
    );
    safeAfterCommit(tx, () => notify('auth.passkey_removed', [{ userId: me(ctx).id }], { name }));
    profileUpdated(tx, me(ctx).id, 0);
  });
}

// ------------------------------------------------------------------ sessions (8.27)
export async function listSessions(
  ctx: Ctx,
  q: {
    page: number;
    limit: number;
    status: 'active' | 'all';
    sortBy: 'lastSeenAt' | 'createdAt';
    sortOrder: 'asc' | 'desc';
  },
) {
  const where =
    q.status === 'active'
      ? { userId: me(ctx).id, revokedAt: null }
      : {
          userId: me(ctx).id,
          [Op.or]: [{ revokedAt: null }, { revokedAt: { [Op.gte]: addDays(now(), -30) } }],
        };
  const { rows, count } = await Session.findAndCountAll({
    where,
    order: [[q.sortBy, q.sortOrder.toUpperCase()]],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return {
    items: rows.map(s => ({
      id: s.id!,
      clientApp: s.clientApp,
      deviceLabel: s.deviceLabel,
      ipLast: s.ipLast,
      createdAt: s.createdAt!.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      isCurrent: s.id === ctx.session?.id,
      revokedAt: s.revokedAt?.toISOString() ?? null,
      revokeReason: s.revokeReason,
    })),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

export async function revokeOwnSession(ctx: Ctx, id: number): Promise<void> {
  await sequelize.transaction(async tx => {
    const s = await Session.findOne({
      where: { id, userId: me(ctx).id, revokedAt: null },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!s) throw new NotFoundError('SESSION_NOT_FOUND', 'Session not found');
    if (s.id === ctx.session?.id)
      throw new ConflictError('CANNOT_REVOKE_CURRENT_SESSION', 'Use sign out for this device');
    await revokeSessionRows([s], 'USER_REVOKED', tx, me(ctx).id);
    await audit(
      ctx,
      {
        action: 'auth.session.revoked',
        entityType: 'session',
        entityId: s.id!,
        after: { reason: 'USER_REVOKED' },
        actor: actorOf(ctx),
      },
      tx,
    );
  });
}

export async function revokeOtherSessions(ctx: Ctx): Promise<{ revoked: number }> {
  return sequelize.transaction(async tx => {
    const n = await revokeUserSessionsInternal(
      ctx,
      me(ctx).id,
      { reason: 'USER_REVOKED', exceptSessionId: ctx.session!.id },
      tx,
    );
    await audit(
      ctx,
      {
        action: 'auth.session.revoked_all',
        entityType: 'user',
        entityId: me(ctx).id,
        after: { revoked: n },
        actor: actorOf(ctx),
      },
      tx,
    );
    return { revoked: n };
  });
}

// ------------------------------------------------------------------ mobile and email (8.28)
export async function startMobileChange(
  ctx: Ctx,
  input: { newMobile: string; channel: 'SMS' | 'WHATSAPP' },
): Promise<OtpSendResult> {
  const app = requireApp(ctx.clientApp);
  const u = await lockedLess(me(ctx).id);
  if (u.mobile === input.newMobile)
    throw new UnprocessableError('MOBILE_UNCHANGED', 'That is already your number');
  if (await User.findOne({ where: { mobile: input.newMobile } }))
    throw new ConflictError('MOBILE_IN_USE', 'This number belongs to another account');
  await assertNotLocked('OTP', input.newMobile);
  const row = await sequelize.transaction(tx =>
    createOtpChallenge(ctx, tx, {
      mobile: input.newMobile,
      userId: u.id!,
      purpose: 'CHANGE_MOBILE',
      channel: input.channel,
      deliverable: true,
      sessionId: ctx.session!.id,
      host: appHost(app),
    }),
  );
  return {
    challengeId: row.challengeId,
    maskedMobile: mask(row.mobile),
    channel: row.channel,
    expiresAt: row.expiresAt.toISOString(),
    resendAvailableAt: row.resendAvailableAt.toISOString(),
    resendsLeft: 3,
  };
}

const lockedLess = async (id: number) => (await User.findByPk(id))!;

export async function confirmMobileChange(
  ctx: Ctx,
  input: { challengeId: string; code: string },
): Promise<AuthUserView> {
  return txOutcome<AuthUserView>(async tx => {
    const v = await verifyOtpChallenge(ctx, tx, {
      challengeId: input.challengeId,
      code: input.code,
      purposes: ['CHANGE_MOBILE'],
      sessionId: ctx.session!.id,
    });
    if (isError(v)) return v;
    const u = await lockUser(me(ctx).id, tx);
    const newMobile = v.challenge.mobile;
    if (await User.findOne({ where: { mobile: newMobile, id: { [Op.ne]: u.id! } }, transaction: tx }))
      return { error: new ConflictError('MOBILE_IN_USE', 'This number belongs to another account') };
    const old = u.mobile!;
    u.mobile = newMobile;
    u.mobileVerifiedAt = now();
    u.version += 1;
    await u.save({ transaction: tx });
    await revokeUserSessionsInternal(
      ctx,
      u.id!,
      { reason: 'MOBILE_CHANGED', exceptSessionId: ctx.session!.id },
      tx,
    );
    await audit(
      ctx,
      {
        action: 'auth.user.mobile_changed',
        entityType: 'user',
        entityId: u.id!,
        before: { mobile: old },
        after: { mobile: newMobile },
        actor: actorOf(ctx),
      },
      tx,
    );
    await ports().residentsHooks.onUserMobileChanged(u.id!, old, newMobile, tx);
    safeAfterCommit(tx, () => notify('auth.mobile_changed', [{ mobile: old }], {}));
    profileUpdated(tx, u.id!, u.version);
    return buildUserView(u);
  });
}

export async function startEmailChange(ctx: Ctx, newEmail: string): Promise<void> {
  const app = requireApp(ctx.clientApp);
  const u = await lockedLess(me(ctx).id);
  if (u.email === newEmail) throw new UnprocessableError('EMAIL_UNCHANGED', 'That is already your email');
  if (await User.findOne({ where: { email: newEmail } }))
    throw new ConflictError('EMAIL_IN_USE', 'This email belongs to another account');
  const raw = await sequelize.transaction(async tx => {
    const t = await issueToken(ctx, tx, {
      purpose: 'EMAIL_VERIFY',
      userId: u.id!,
      payload: { newEmail },
      expiresAt: ttl(24 * 3_600_000),
      revokeOlder: true,
    });
    return t.raw;
  });
  await notify('auth.email_verify', [{ email: newEmail }], {
    link: appUrl(app, `/verify-email?token=${raw}`),
  });
}

// ------------------------------------------------------------------ deletion (8.29)
export async function requestDeletion(ctx: Ctx, reason?: string): Promise<{ deletionScheduledFor: string }> {
  return sequelize.transaction(async tx => {
    const u = await lockUser(me(ctx).id, tx);
    if (u.status === 'PENDING_DELETION')
      throw new ConflictError('DELETION_ALREADY_REQUESTED', 'Deletion is already requested');
    if (u.status !== 'ACTIVE') throw new AppError(409, 'INVALID_STATE', 'This account cannot be deleted now');
    const blockers = await ports().authAccess.deletionBlockers(u.id!);
    if (blockers.length)
      throw new AppError(
        409,
        'ACCOUNT_DELETION_BLOCKED',
        'Your account cannot be deleted yet',
        blockers.map(b => ({ field: 'blocker', message: b })),
      );
    const t = now();
    u.status = 'PENDING_DELETION';
    u.deletionRequestedAt = t;
    u.deletionScheduledFor = addDays(t, DELETION_GRACE_DAYS);
    u.version += 1;
    await u.save({ transaction: tx });
    await revokeUserSessionsInternal(
      ctx,
      u.id!,
      { reason: 'DELETION_REQUESTED', exceptSessionId: ctx.session?.id },
      tx,
    );
    await audit(
      ctx,
      {
        action: 'auth.account.deletion_requested',
        entityType: 'user',
        entityId: u.id!,
        after: { scheduledFor: u.deletionScheduledFor },
        reason: reason ?? null,
        actor: actorOf(ctx),
      },
      tx,
    );
    safeAfterCommit(tx, () =>
      notify('auth.account_deletion_requested', [{ userId: u.id! }], {
        date: u.deletionScheduledFor!.toISOString().slice(0, 10),
      }),
    );
    profileUpdated(tx, u.id!, u.version);
    return { deletionScheduledFor: u.deletionScheduledFor!.toISOString() };
  });
}

export async function cancelDeletion(ctx: Ctx): Promise<void> {
  await sequelize.transaction(async tx => {
    const u = await lockUser(me(ctx).id, tx);
    if (u.status !== 'PENDING_DELETION')
      throw new ConflictError('DELETION_NOT_REQUESTED', 'There is no deletion to cancel');
    u.status = 'ACTIVE';
    u.deletionRequestedAt = null;
    u.deletionScheduledFor = null;
    u.version += 1;
    await u.save({ transaction: tx });
    await audit(
      ctx,
      { action: 'auth.account.deletion_cancelled', entityType: 'user', entityId: u.id!, actor: actorOf(ctx) },
      tx,
    );
    safeAfterCommit(tx, () => notify('auth.account_deletion_cancelled', [{ userId: u.id! }], {}));
    profileUpdated(tx, u.id!, u.version);
  });
}

// ------------------------------------------------------------------ step-up (8.16)
export async function reauthOtp(ctx: Ctx, channel: 'SMS' | 'WHATSAPP'): Promise<OtpSendResult> {
  const app = requireApp(ctx.clientApp);
  const u = await lockedLess(me(ctx).id);
  if (u.mfaEnabledAt || ctx.session?.amr.includes('PIN') || !u.mobile)
    throw new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'Use your authenticator or a passkey to confirm');
  await assertNotLocked('OTP', u.mobile);
  const row = await sequelize.transaction(tx =>
    createOtpChallenge(ctx, tx, {
      mobile: u.mobile!,
      userId: u.id!,
      purpose: 'REAUTH',
      channel,
      deliverable: true,
      sessionId: ctx.session!.id,
      host: appHost(app),
    }),
  );
  return {
    challengeId: row.challengeId,
    maskedMobile: mask(row.mobile),
    channel: row.channel,
    expiresAt: row.expiresAt.toISOString(),
    resendAvailableAt: row.resendAvailableAt.toISOString(),
    resendsLeft: 3,
  };
}

export async function reauth(
  ctx: Ctx,
  input: { method: 'TOTP' | 'OTP' | 'PASSKEY'; code?: string; challengeId?: string; credential?: any },
): Promise<{ authTime: string }> {
  if (ctx.session!.amr.includes('PIN'))
    throw new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'Step-up is not available for this session');
  const u0 = await lockedLess(me(ctx).id);
  const notAllowed = () =>
    new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'That method is not available for your account');
  if (input.method === 'TOTP') {
    if (!u0.mfaEnabledAt) throw notAllowed();
    await assertNotLocked('MFA', String(u0.id));
  }
  if (input.method === 'OTP' && u0.mfaEnabledAt) throw notAllowed();

  return txOutcome<{ authTime: string }>(async tx => {
    if (input.method === 'TOTP') {
      const u = await userWithSecrets(u0.id!, tx);
      const step = totpStepFor(u, input.code!, now().getTime());
      if (step === null) return { error: await mfaFailure(ctx, u, 'TOTP_INVALID', 'TOTP', { tx }) };
      if (!(await consumeTotpStep(tx, u.id!, step)))
        return { error: await mfaFailure(ctx, u, 'TOTP_REUSED', 'TOTP', { tx }) };
      await resetLock('MFA', String(u.id), tx);
    } else if (input.method === 'OTP') {
      const v = await verifyOtpChallenge(ctx, tx, {
        challengeId: input.challengeId!,
        code: input.code!,
        purposes: ['REAUTH'],
        sessionId: ctx.session!.id,
      });
      if (isError(v)) return v;
    } else {
      const v = await verifyReauthPasskey(ctx, tx, {
        challengeId: input.challengeId!,
        credential: input.credential,
      });
      if (isError(v)) return v;
    }
    const s = (await Session.findByPk(ctx.session!.id, { transaction: tx, lock: tx.LOCK.UPDATE }))!;
    const t = now();
    s.authTime = t;
    const method = input.method === 'PASSKEY' ? 'PASSKEY' : input.method;
    s.amr = [...new Set([...s.amr, method])] as typeof s.amr;
    await s.save({ transaction: tx });
    await audit(
      ctx,
      {
        action: 'auth.session.reauthenticated',
        entityType: 'session',
        entityId: s.id!,
        after: { method },
        actor: actorOf(ctx),
      },
      tx,
    );
    return { authTime: t.toISOString() };
  });
}
