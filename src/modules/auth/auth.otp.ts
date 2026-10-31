import type { Transaction } from 'sequelize';
import { AuthOtp, AuthToken, User, sequelize } from '../../models';
import type { OtpChannel, OtpPurpose } from '../../models/auth-otp.model';
import { addMs, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { notify } from '../../lib/notify';
import { AppError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { hashOtp, hashToken, newChallengeId, newOtpCode, randomToken, safeEqual } from './auth.crypto';
import { appHost, assertMethod, requireApp } from './auth.apps';
import { assertNotLocked, lockedError, lockRemainingSeconds, recordFailure, resetLock } from './auth.lockout';
import { completeFirstFactor, isError, type OrError, type SignInOutcome } from './auth.signin';
import { activateInvited } from './auth.users';
import { OTP_MAX_ATTEMPTS, OTP_MAX_RESENDS, OTP_RESEND_AFTER_MS, OTP_TTL_MS, mask } from './auth.types';
import { rateLimitHit, safeAfterCommit, txOutcome, withMinDuration } from './auth.util';

export interface OtpSendResult {
  challengeId: string;
  maskedMobile: string;
  channel: OtpChannel;
  expiresAt: string;
  resendAvailableAt: string;
  resendsLeft: number;
}

const view = (c: AuthOtp): OtpSendResult => ({
  challengeId: c.challengeId,
  maskedMobile: mask(c.mobile),
  channel: c.channel,
  expiresAt: c.expiresAt.toISOString(),
  resendAvailableAt: c.resendAvailableAt.toISOString(),
  resendsLeft: OTP_MAX_RESENDS - c.resendCount,
});

/** Creates a challenge row and, when deliverable, sends the code after commit (BR-02-7, BR-02-10, BR-02-11). */
export async function createOtpChallenge(
  ctx: Ctx,
  tx: Transaction,
  v: {
    mobile: string;
    userId: number | null;
    purpose: OtpPurpose;
    channel: OtpChannel;
    deliverable: boolean;
    sessionId?: number | null;
    resendCount?: number;
    host: string;
  },
): Promise<AuthOtp> {
  const challengeId = newChallengeId();
  const code = newOtpCode();
  const t = now();
  const row = await AuthOtp.create(
    {
      challengeId,
      userId: v.userId,
      mobile: v.mobile,
      purpose: v.purpose,
      channel: v.channel,
      codeHash: hashOtp(challengeId, code),
      isDeliverable: v.deliverable,
      status: 'PENDING',
      attemptCount: 0,
      resendCount: v.resendCount ?? 0,
      sessionId: v.sessionId ?? null,
      expiresAt: addMs(t, OTP_TTL_MS),
      resendAvailableAt: addMs(t, OTP_RESEND_AFTER_MS),
      verifiedAt: null,
      ip: ctx.ip || null,
      userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 255) : null,
    },
    { transaction: tx },
  );
  if (v.deliverable)
    safeAfterCommit(tx, () =>
      notify('auth.otp', [{ mobile: v.mobile }], { code, host: v.host, minutes: 5 }, { channel: v.channel }),
    );
  return row;
}

type Deliverability = { deliverable: boolean; user: User | null; existingForSignup?: boolean };

async function decideDeliverability(
  mobile: string,
  purpose: 'LOGIN' | 'SIGNUP',
  app: ReturnType<typeof requireApp>,
): Promise<Deliverability> {
  const user = await User.findOne({ where: { mobile } });
  if (purpose === 'SIGNUP') return { deliverable: !user, user, existingForSignup: Boolean(user) };
  if (!user) return { deliverable: app === 'RESIDENT', user: null }; // BR-02-5, BR-02-12
  const ok = user.status === 'ACTIVE' || user.status === 'INVITED' || user.status === 'PENDING_DELETION';
  return { deliverable: ok, user };
}

/** Section 8.1. Same response and timing for every mobile (BR-02-12). */
export async function sendOtp(
  ctx: Ctx,
  input: { mobile: string; purpose: 'LOGIN' | 'SIGNUP'; channel: OtpChannel },
): Promise<OtpSendResult> {
  const app = requireApp(ctx.clientApp);
  if (input.purpose === 'SIGNUP') {
    if (app !== 'ADMIN') throw new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'Sign-up is not available here');
  } else assertMethod(app, 'otp');
  return withMinDuration(async () => {
    await assertNotLocked('OTP', input.mobile);
    const d = await decideDeliverability(input.mobile, input.purpose, app);
    if (d.existingForSignup) {
      const hit = await kv().slidingWindowHit(`signup-existing:${input.mobile}`, 24 * 3_600_000, 1);
      if (hit.allowed)
        void notify(
          'auth.signup_existing_account',
          [{ mobile: input.mobile }],
          {},
          { channel: input.channel },
        );
    }
    const row = await sequelize.transaction(tx =>
      createOtpChallenge(ctx, tx, {
        mobile: input.mobile,
        userId: d.user?.id ?? null,
        purpose: input.purpose,
        channel: input.channel,
        deliverable: d.deliverable,
        host: appHost(app),
      }),
    );
    return view(row);
  });
}

/** Section 8.2. */
export async function resendOtp(
  ctx: Ctx,
  input: { challengeId: string; channel?: OtpChannel },
): Promise<OtpSendResult> {
  const app = requireApp(ctx.clientApp);
  return txOutcome<OtpSendResult>(async tx => {
    const old = await AuthOtp.findOne({
      where: { challengeId: input.challengeId },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    const t = now();
    if (
      !old ||
      old.status !== 'PENDING' ||
      (old.purpose !== 'LOGIN' && old.purpose !== 'SIGNUP') ||
      old.expiresAt < t
    )
      return { error: new AppError(401, 'OTP_EXPIRED', 'Request a new code') };
    if (old.purpose === 'SIGNUP') {
      if (app !== 'ADMIN')
        return { error: new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'Sign-up is not available here') };
    } else assertMethod(app, 'otp');
    const lock = await lockRemainingSeconds('OTP', old.mobile, tx);
    if (lock > 0) return { error: lockedError(lock) };
    if (t < old.resendAvailableAt)
      return {
        error: new AppError(429, 'OTP_RESEND_TOO_SOON', 'Wait before requesting another code', [
          {
            field: 'retryAfterSeconds',
            message: String(Math.ceil((old.resendAvailableAt.getTime() - t.getTime()) / 1000)),
          },
        ]),
      };
    if (old.resendCount >= OTP_MAX_RESENDS)
      return {
        error: new AppError(429, 'OTP_RESEND_LIMIT_REACHED', 'You have used all resends. Try again later.'),
      };
    await rateLimitHit('otp-send-mobile', old.mobile, 5, 900);
    old.status = 'SUPERSEDED';
    await old.save({ transaction: tx });
    const row = await createOtpChallenge(ctx, tx, {
      mobile: old.mobile,
      userId: old.userId,
      purpose: old.purpose,
      channel: input.channel ?? old.channel,
      deliverable: old.isDeliverable,
      resendCount: old.resendCount + 1,
      host: appHost(app),
    });
    return view(row);
  });
}

/**
 * Steps 1 to 4 of 8.3, shared by login, step-up and mobile change: state and expiry, lock, code check with attempts,
 * VERIFIED and lock reset. Failures return `{ error }` so the caller commits the attempt count and audit row.
 */
export async function verifyOtpChallenge(
  ctx: Ctx,
  tx: Transaction,
  v: { challengeId: string; code: string; purposes: OtpPurpose[]; sessionId?: number; auditUserId?: number },
): Promise<OrError<{ challenge: AuthOtp }>> {
  const expired = { error: new AppError(401, 'OTP_EXPIRED', 'Request a new code') };
  const ch = await AuthOtp.findOne({
    where: { challengeId: v.challengeId },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!ch || !v.purposes.includes(ch.purpose) || ch.status !== 'PENDING') return expired;
  if (v.sessionId !== undefined && ch.sessionId !== v.sessionId) return expired;
  const t = now();
  if (t > ch.expiresAt) {
    ch.status = 'EXPIRED';
    await ch.save({ transaction: tx });
    return expired;
  }
  const lock = await lockRemainingSeconds('OTP', ch.mobile, tx);
  if (lock > 0) return { error: lockedError(lock) };
  const matches = ch.isDeliverable && safeEqual(hashOtp(ch.challengeId, v.code), ch.codeHash);
  if (!matches) {
    ch.attemptCount += 1;
    if (ch.attemptCount >= OTP_MAX_ATTEMPTS) ch.status = 'FAILED';
    await ch.save({ transaction: tx });
    const f = await recordFailure('OTP', ch.mobile, { userId: ch.userId, ctx, tx });
    if (f.alreadyLocked) return { error: lockedError(f.retryAfterSeconds) };
    if (ch.userId && ch.purpose === 'LOGIN')
      await audit(
        ctx,
        {
          action: 'auth.login.failed',
          entityType: 'user',
          entityId: ch.userId,
          after: { method: 'OTP', reason: 'BAD_CODE' },
          actor: { userId: ch.userId, name: 'User', role: 'user' },
        },
        tx,
      );
    return {
      error: new AppError(401, 'OTP_INVALID', 'That code is not correct', [
        {
          field: 'attemptsLeft',
          message: String(Math.max(0, Math.min(OTP_MAX_ATTEMPTS - ch.attemptCount, f.attemptsLeft))),
        },
      ]),
    };
  }
  ch.status = 'VERIFIED';
  ch.verifiedAt = t;
  await ch.save({ transaction: tx });
  await resetLock('OTP', ch.mobile, tx);
  return { challenge: ch };
}

export type VerifyOtpResult =
  | { kind: 'LOGIN'; outcome: SignInOutcome }
  | { kind: 'SIGNUP'; signupToken: string; mobile: string; expiresAt: string };

const maskedMobileFor = mask;

/** Section 8.3. */
export async function verifyOtp(
  ctx: Ctx,
  input: { challengeId: string; code: string },
): Promise<VerifyOtpResult> {
  const app = requireApp(ctx.clientApp);
  return txOutcome<VerifyOtpResult>(async tx => {
    const v = await verifyOtpChallenge(ctx, tx, {
      challengeId: input.challengeId,
      code: input.code,
      purposes: ['LOGIN', 'SIGNUP'],
    });
    if (isError(v)) return v;
    const ch = v.challenge;
    if (ch.purpose === 'LOGIN') assertMethod(app, 'otp');
    if (ch.purpose === 'SIGNUP') {
      if (app !== 'ADMIN')
        return { error: new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'Sign-up is not available here') };
      if (await User.findOne({ where: { mobile: ch.mobile }, transaction: tx }))
        return {
          error: new AppError(409, 'MOBILE_IN_USE', 'This number already has an account. Sign in instead.'),
        };
      const raw = randomToken('su_');
      const expiresAt = addMs(now(), 15 * 60_000);
      await revokeOlderSignupTokens(tx, ch.mobile);
      await AuthToken.create(
        {
          tokenHash: hashToken(raw),
          purpose: 'SIGNUP',
          userId: null,
          sessionId: null,
          payload: { mobile: ch.mobile, clientApp: 'ADMIN', otpChallengeId: ch.challengeId },
          attemptCount: 0,
          expiresAt,
          consumedAt: null,
          revokedAt: null,
          ip: ctx.ip || null,
          userAgent: ctx.userAgent || null,
          createdBy: null,
        },
        { transaction: tx },
      );
      await audit(
        ctx,
        {
          action: 'auth.signup.mobile_verified',
          entityType: 'mobile',
          entityId: maskedMobileFor(ch.mobile),
          actor: { userId: null, name: 'Visitor', role: 'anonymous' },
        },
        tx,
      );
      return { kind: 'SIGNUP', signupToken: raw, mobile: ch.mobile, expiresAt: expiresAt.toISOString() };
    }
    // LOGIN
    let user = await User.scope('withSecrets').findOne({
      where: { mobile: ch.mobile },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!user) {
      if (app !== 'RESIDENT')
        return {
          error: new AppError(401, 'OTP_INVALID', 'That code is not correct', [
            { field: 'attemptsLeft', message: '0' },
          ]),
        };
      user = await createResidentUser(ctx, tx, ch.mobile);
    } else if (user.status === 'INVITED') await activateInvited(user, tx, ctx);
    if (!user.mobileVerifiedAt) {
      user.mobileVerifiedAt = now();
      await user.save({ transaction: tx, fields: ['mobileVerifiedAt', 'updatedAt'] });
    }
    const out = await completeFirstFactor(ctx, tx, user, 'OTP');
    if (isError(out)) return out;
    return { kind: 'LOGIN', outcome: out };
  });
}

async function revokeOlderSignupTokens(tx: Transaction, mobile: string): Promise<void> {
  const open = await AuthToken.findAll({
    where: { purpose: 'SIGNUP', consumedAt: null, revokedAt: null },
    transaction: tx,
  });
  for (const t of open)
    if (t.payload?.mobile === mobile) {
      t.revokedAt = now();
      await t.save({ transaction: tx });
    }
}

async function createResidentUser(ctx: Ctx, tx: Transaction, mobile: string): Promise<User> {
  const t = now();
  const u = await User.create({ mobile, status: 'ACTIVE', mobileVerifiedAt: t, name: null } as never, {
    transaction: tx,
  });
  await audit(
    ctx,
    {
      action: 'auth.user.created',
      entityType: 'user',
      entityId: u.id!,
      after: { source: 'RESIDENT_SIGNUP' },
      actor: { userId: u.id!, name: 'New resident', role: 'user' },
    },
    tx,
  );
  return (await User.scope('withSecrets').findByPk(u.id!, { transaction: tx }))!;
}
