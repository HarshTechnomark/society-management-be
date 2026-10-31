import { QueryTypes, type Transaction } from 'sequelize';
import { AuthToken, User, sequelize } from '../../models';
import { addMs, now } from '../../lib/clock';
import { notify } from '../../lib/notify';
import { AppError, ForbiddenError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import {
  getDummyHash,
  hashPassword,
  hashToken,
  passwordNeedsRehash,
  randomToken,
  sha256Hex,
  verifyPassword,
} from './auth.crypto';
import { assertNotLocked, lockedError, lockRemainingSeconds, recordFailure, resetLock } from './auth.lockout';
import {
  consumeRecoveryCode,
  consumeTotpStep,
  generateRecoveryCodes,
  mfaFailure,
  setRecoveryCodeSession,
  startTotpSetup,
  totpStepFor,
  userWithSecrets,
  type TotpSetupView,
} from './auth.mfa';
import { assertMethod, requireApp } from './auth.apps';
import { ports } from './auth.ports';
import { createSession, userRequiresMfa } from './auth.sessions';
import type { SessionCookies } from './auth.tokens';
import { type Amr, type ClientApp, type SignInResult } from './auth.types';
import { rateLimitHit, safeAfterCommit, txOutcome } from './auth.util';

export type FirstFactor = 'OTP' | 'PASSWORD' | 'PASSKEY';
export interface SignInOutcome {
  result: SignInResult;
  cookies?: SessionCookies;
  message: string;
}
export type OrError<T> = T | { error: AppError };
export const isError = (x: unknown): x is { error: AppError } =>
  typeof x === 'object' && x !== null && 'error' in x && (x as { error: unknown }).error instanceof AppError;

const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;

export async function createLoginChallenge(
  ctx: Ctx,
  tx: Transaction,
  user: User,
  v: { clientApp: ClientApp; firstFactor: FirstFactor; next: 'MFA' | 'MFA_ENROLL' },
): Promise<{ raw: string; expiresAt: Date }> {
  const raw = randomToken('lc_');
  const expiresAt = addMs(now(), LOGIN_CHALLENGE_TTL_MS);
  await AuthToken.create(
    {
      tokenHash: hashToken(raw),
      purpose: 'LOGIN_CHALLENGE',
      userId: user.id!,
      sessionId: null,
      payload: {
        clientApp: v.clientApp,
        firstFactor: v.firstFactor,
        next: v.next,
        deviceIdHash: ctx.deviceId ? sha256Hex(ctx.deviceId) : null,
      },
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
  return { raw, expiresAt };
}

/**
 * Steps 5 and 6 of 8.3 shared by OTP, password and passkey: disabled check, app access (BR-02-42), then the second step
 * (BR-02-23) or the session. Returns `{ error }` so the caller commits what it already wrote.
 */
export async function completeFirstFactor(
  ctx: Ctx,
  tx: Transaction,
  user: User,
  firstFactor: FirstFactor,
): Promise<OrError<SignInOutcome>> {
  const app = requireApp(ctx.clientApp);
  if (user.status === 'DISABLED')
    return { error: new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled') };
  if (!(await ports().authAccess.hasAppAccess(user.id!, app)))
    return { error: new ForbiddenError('NO_ACCESS_FOR_APP', 'This account has no access to this app') };

  const mfaOn = user.mfaEnabledAt !== null;
  const mfaRequired = await userRequiresMfa(user);
  if (firstFactor === 'PASSKEY') {
    if (mfaRequired && !mfaOn) return enrolmentChallenge(ctx, tx, user, app, firstFactor);
    return signedIn(ctx, tx, user, app, ['PASSKEY'], true);
  }
  if (mfaOn) {
    const c = await createLoginChallenge(ctx, tx, user, { clientApp: app, firstFactor, next: 'MFA' });
    return {
      message: 'Enter your authenticator code',
      result: {
        status: 'MFA_REQUIRED',
        challengeToken: c.raw,
        methods: ['TOTP', 'RECOVERY_CODE'],
        expiresAt: c.expiresAt.toISOString(),
      },
    };
  }
  if (mfaRequired) return enrolmentChallenge(ctx, tx, user, app, firstFactor);
  return signedIn(ctx, tx, user, app, [firstFactor], false);
}

async function enrolmentChallenge(
  ctx: Ctx,
  tx: Transaction,
  user: User,
  app: ClientApp,
  firstFactor: FirstFactor,
): Promise<SignInOutcome> {
  const c = await createLoginChallenge(ctx, tx, user, { clientApp: app, firstFactor, next: 'MFA_ENROLL' });
  return {
    message: 'Set up your authenticator to continue',
    result: {
      status: 'MFA_ENROLL_REQUIRED',
      challengeToken: c.raw,
      methods: ['TOTP_ENROLL'],
      expiresAt: c.expiresAt.toISOString(),
    },
  };
}

async function signedIn(
  ctx: Ctx,
  tx: Transaction,
  user: User,
  app: ClientApp,
  amr: Amr[],
  mfaVerified: boolean,
  extra: { recoveryCodes?: string[] } = {},
): Promise<SignInOutcome & { sessionId: number }> {
  const c = await createSession(ctx, tx, { userId: user.id!, clientApp: app, amr, mfaVerified });
  return {
    message: 'Signed in',
    cookies: c.cookies,
    sessionId: c.sessionId,
    result: { status: 'SIGNED_IN', me: c.me, ...extra },
  };
}

// ------------------------------------------------------------------ password (8.5)
export async function passwordLogin(
  ctx: Ctx,
  input: { email: string; password: string },
): Promise<SignInOutcome> {
  const app = requireApp(ctx.clientApp);
  assertMethod(app, 'password');
  await assertNotLocked('PASSWORD', input.email);
  await rateLimitHit('login-email', input.email, 10, 900);
  return txOutcome<SignInOutcome>(async tx => {
    const user = await User.scope('withSecrets').findOne({ where: { email: input.email }, transaction: tx });
    const usable =
      user &&
      user.passwordHash &&
      user.emailVerifiedAt &&
      user.status !== 'SYSTEM' &&
      user.status !== 'DELETED';
    // BR-02-16: always run a verify, against a dummy hash when there is nothing real to check
    const good = await verifyPassword(usable ? user.passwordHash! : await getDummyHash(), input.password);
    if (!usable || !good) {
      const f = await recordFailure('PASSWORD', input.email, { userId: user?.id ?? null, ctx, tx });
      if (f.alreadyLocked) return { error: lockedError(f.retryAfterSeconds) };
      if (user)
        await audit(
          ctx,
          {
            action: 'auth.login.failed',
            entityType: 'user',
            entityId: user.id!,
            after: { method: 'PASSWORD' },
            actor: { userId: user.id!, name: user.name ?? 'User', role: 'user' },
          },
          tx,
        );
      return { error: new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is not correct') };
    }
    await resetLock('PASSWORD', input.email, tx);
    if (passwordNeedsRehash(user.passwordHash!)) {
      user.passwordHash = await hashPassword(input.password);
      await user.save({ transaction: tx, fields: ['passwordHash', 'updatedAt'] });
    }
    return completeFirstFactor(ctx, tx, user, 'PASSWORD');
  });
}

// ------------------------------------------------------------------ MFA challenge (8.8 to 8.10)
interface LoadedChallenge {
  token: AuthToken;
  user: User;
  firstFactor: FirstFactor;
}

/**
 * Finds a `LOGIN_CHALLENGE` by its raw value. The MFA lock is checked before validity so that a token revoked by the
 * fifth wrong code still answers `429 ACCOUNT_LOCKED` while the lock lasts (T02-38).
 */
async function loadLoginChallenge(
  ctx: Ctx,
  tx: Transaction,
  raw: string,
  next: 'MFA' | 'MFA_ENROLL',
  checkLock: boolean,
): Promise<OrError<LoadedChallenge>> {
  const invalid = {
    error: new AppError(401, 'CHALLENGE_INVALID', 'Your sign-in took too long. Start again.'),
  };
  const token = await AuthToken.findOne({
    where: { tokenHash: hashToken(raw), purpose: 'LOGIN_CHALLENGE' },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!token || !token.userId) return invalid;
  const p = token.payload ?? {};
  if (p.next !== next || p.clientApp !== ctx.clientApp) return invalid;
  if (checkLock) {
    const s = await lockRemainingSeconds('MFA', String(token.userId), tx);
    if (s > 0) return { error: lockedError(s) };
  }
  if (token.consumedAt || token.revokedAt || token.expiresAt <= now()) return invalid;
  const user = await userWithSecrets(token.userId, tx);
  return { token, user, firstFactor: p.firstFactor as FirstFactor };
}

async function consumeToken(tx: Transaction, id: number): Promise<boolean> {
  const [, affected] = (await sequelize.query(
    'UPDATE auth_tokens SET consumedAt = :t, updatedAt = :t WHERE id = :id AND consumedAt IS NULL AND revokedAt IS NULL',
    { replacements: { t: now(), id }, transaction: tx, type: QueryTypes.UPDATE },
  )) as unknown as [unknown, number];
  return affected > 0;
}
export { consumeToken };

export async function verifyMfa(
  ctx: Ctx,
  input: { challengeToken: string; method: 'TOTP' | 'RECOVERY_CODE'; code: string },
): Promise<SignInOutcome> {
  requireApp(ctx.clientApp);
  return txOutcome<SignInOutcome>(async tx => {
    const ch = await loadLoginChallenge(ctx, tx, input.challengeToken, 'MFA', true);
    if (isError(ch)) return ch;
    const { token, user, firstFactor } = ch;
    if (user.status === 'DISABLED')
      return { error: new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled') };
    const fail = async (kind: 'TOTP_INVALID' | 'TOTP_REUSED' | 'RECOVERY_CODE_INVALID') => {
      token.attemptCount += 1;
      if (token.attemptCount >= 5) token.revokedAt = now();
      await token.save({ transaction: tx });
      return {
        error: await mfaFailure(ctx, user, kind, input.method, {
          otherAttemptsLeft: 5 - token.attemptCount,
          tx,
        }),
      };
    };
    let recoveryUsed = false;
    if (input.method === 'TOTP') {
      const step = user.mfaEnabledAt ? totpStepFor(user, input.code, now().getTime()) : null;
      if (step === null) return fail('TOTP_INVALID');
      if (!(await consumeTotpStep(tx, user.id!, step))) return fail('TOTP_REUSED');
    } else {
      if (!(await consumeRecoveryCode(tx, user.id!, input.code, null))) return fail('RECOVERY_CODE_INVALID');
      recoveryUsed = true;
    }
    if (!(await consumeToken(tx, token.id!)))
      return { error: new AppError(401, 'CHALLENGE_INVALID', 'Your sign-in took too long. Start again.') };
    await resetLock('MFA', String(user.id), tx);
    const out = await signedIn(ctx, tx, user, requireApp(ctx.clientApp), [firstFactor, input.method], true);
    if (recoveryUsed) {
      await setRecoveryCodeSession(tx, user.id!, input.code, out.sessionId);
      await audit(
        ctx,
        {
          action: 'auth.recovery_code.used',
          entityType: 'user',
          entityId: user.id!,
          actor: { userId: user.id!, name: user.name ?? 'User', role: 'user' },
        },
        tx,
      );
      safeAfterCommit(tx, () => notify('auth.recovery_code_used', [{ userId: user.id! }], {}));
    }
    return out;
  });
}

export async function mfaEnrollStart(ctx: Ctx, input: { challengeToken: string }): Promise<TotpSetupView> {
  requireApp(ctx.clientApp);
  return txOutcome<TotpSetupView>(async tx => {
    const ch = await loadLoginChallenge(ctx, tx, input.challengeToken, 'MFA_ENROLL', false);
    if (isError(ch)) return ch;
    return startTotpSetup(ch.user, tx);
  });
}

export async function mfaEnrollConfirm(
  ctx: Ctx,
  input: { challengeToken: string; code: string },
): Promise<SignInOutcome> {
  requireApp(ctx.clientApp);
  return txOutcome<SignInOutcome>(async tx => {
    const ch = await loadLoginChallenge(ctx, tx, input.challengeToken, 'MFA_ENROLL', true);
    if (isError(ch)) return ch;
    const { token, user, firstFactor } = ch;
    if (!user.totpSecretEnc || user.mfaEnabledAt)
      return { error: new AppError(409, 'MFA_SETUP_NOT_STARTED', 'Start the authenticator setup first') };
    const step = totpStepFor(user, input.code, now().getTime());
    if (step === null) return { error: await mfaFailure(ctx, user, 'TOTP_INVALID', 'TOTP', { tx }) };
    if (!(await consumeTotpStep(tx, user.id!, step)))
      return { error: await mfaFailure(ctx, user, 'TOTP_REUSED', 'TOTP', { tx }) };
    user.mfaEnabledAt = now();
    await user.save({ transaction: tx, fields: ['mfaEnabledAt', 'updatedAt'] });
    const recoveryCodes = await generateRecoveryCodes(user.id!, tx);
    if (!(await consumeToken(tx, token.id!)))
      return { error: new AppError(401, 'CHALLENGE_INVALID', 'Your sign-in took too long. Start again.') };
    await resetLock('MFA', String(user.id), tx);
    const actor = { userId: user.id!, name: user.name ?? 'User', role: 'user' };
    await audit(ctx, { action: 'auth.mfa.enabled', entityType: 'user', entityId: user.id!, actor }, tx);
    await audit(
      ctx,
      { action: 'auth.recovery_codes.generated', entityType: 'user', entityId: user.id!, actor },
      tx,
    );
    safeAfterCommit(tx, () => notify('auth.mfa_enabled', [{ userId: user.id! }], {}));
    return signedIn(ctx, tx, user, requireApp(ctx.clientApp), [firstFactor, 'TOTP'], true, { recoveryCodes });
  });
}
