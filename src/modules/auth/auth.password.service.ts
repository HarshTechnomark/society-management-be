import { Op, type Transaction } from 'sequelize';
import { AuthToken, User, sequelize } from '../../models';
import { addDays, now } from '../../lib/clock';
import { notify } from '../../lib/notify';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { hashPassword } from './auth.crypto';
import { appUrl, assertMethod, requireApp } from './auth.apps';
import { resetLock } from './auth.lockout';
import {
  classify,
  consumeOrThrow,
  findToken,
  issueToken,
  requireValidToken,
  ttl,
  type LinkProblem,
} from './auth.links';
import { assertPasswordPolicy } from './auth.password';
import { revokeUserSessionsInternal } from './auth.sessions';
import { activateInvited, lockUser } from './auth.users';
import type { ClientApp } from './auth.types';
import { safeAfterCommit, withMinDuration } from './auth.util';

const RESET_TTL = 15 * 60_000;
const SETUP_NO_INVITE_TTL = 72 * 3_600_000;

/** Section 8.17. Same response for every email; nothing happens for unknown, system or unverified accounts. */
export async function forgotPassword(ctx: Ctx, email: string): Promise<void> {
  const app = requireApp(ctx.clientApp);
  assertMethod(app, 'password');
  await withMinDuration(async () => {
    const user = await User.findOne({ where: { email } });
    if (!user || !user.emailVerifiedAt || (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION'))
      return;
    const raw = await sequelize.transaction(async tx => {
      const t = await issueToken(ctx, tx, {
        purpose: 'PASSWORD_RESET',
        userId: user.id!,
        expiresAt: ttl(RESET_TTL),
        revokeOlder: true,
      });
      await audit(
        ctx,
        {
          action: 'auth.password.reset_requested',
          entityType: 'user',
          entityId: user.id!,
          actor: { userId: user.id!, name: user.name ?? 'User', role: 'user' },
        },
        tx,
      );
      return t.raw;
    });
    await notify('auth.password_reset', [{ email: user.email }], {
      link: appUrl(app, `/reset?token=${raw}`),
    });
  });
}

export interface LinkStatus {
  valid: boolean;
  email?: string | null;
  expiresAt?: string;
  reason?: LinkProblem;
}

/** Section 8.18. */
export async function linkStatus(
  raw: string,
  purpose: 'PASSWORD_RESET' | 'ACCOUNT_SETUP',
): Promise<LinkStatus> {
  const token = await findToken(raw, purpose);
  const problem = classify(token);
  if (problem) return { valid: false, reason: problem };
  const user = token!.userId ? await User.findByPk(token!.userId) : null;
  return { valid: true, email: user?.email ?? null, expiresAt: token!.expiresAt.toISOString() };
}

async function setPasswordViaLink(
  ctx: Ctx,
  rawToken: string,
  password: string,
  purpose: 'PASSWORD_RESET' | 'ACCOUNT_SETUP',
) {
  const token0 = await requireValidToken(rawToken, purpose);
  const user0 = await User.findByPk(token0.userId!);
  if (!user0) throw new AppError(400, 'LINK_INVALID', 'This link is not valid');
  if (user0.status === 'DISABLED') throw new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled');
  await assertPasswordPolicy(password, { email: user0.email });
  const hash = await hashPassword(password);
  await sequelize.transaction(async tx => {
    const token = await requireValidToken(rawToken, purpose, tx, true);
    const user = await lockUser(token.userId!, tx);
    if (user.status === 'DISABLED') throw new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled');
    if (user.status === 'SYSTEM' || user.status === 'DELETED')
      throw new AppError(400, 'LINK_INVALID', 'This link is not valid');
    await consumeOrThrow(tx, token);
    const actor = { userId: user.id!, name: user.name ?? 'User', role: 'user' };
    user.passwordHash = hash;
    user.passwordChangedAt = now();
    if (purpose === 'ACCOUNT_SETUP') {
      user.emailVerifiedAt = user.emailVerifiedAt ?? now();
      if (user.status === 'INVITED') await activateInvited(user, tx, ctx);
    }
    await user.save({ transaction: tx });
    if (purpose === 'PASSWORD_RESET') {
      await revokeUserSessionsInternal(ctx, user.id!, { reason: 'PASSWORD_RESET' }, tx);
      if (user.email) await resetLock('PASSWORD', user.email, tx);
      await audit(ctx, { action: 'auth.password.reset', entityType: 'user', entityId: user.id!, actor }, tx);
    } else {
      await audit(ctx, { action: 'auth.password.set', entityType: 'user', entityId: user.id!, actor }, tx);
    }
    safeAfterCommit(tx, () => notify('auth.password_changed', [{ userId: user.id! }], {}));
  });
}

/** Section 8.19. */
export const resetPassword = (ctx: Ctx, token: string, password: string) =>
  setPasswordViaLink(ctx, token, password, 'PASSWORD_RESET');

/** Section 8.20. Does not sign in. */
export const setupPassword = (ctx: Ctx, token: string, password: string) =>
  setPasswordViaLink(ctx, token, password, 'ACCOUNT_SETUP');

/** Section 8.21. */
export async function verifyEmail(ctx: Ctx, rawToken: string): Promise<{ email: string }> {
  return sequelize.transaction(async tx => {
    const token = await requireValidToken(rawToken, 'EMAIL_VERIFY', tx, true);
    const newEmail = String(token.payload?.newEmail ?? '');
    const user = await lockUser(token.userId!, tx);
    if (!newEmail) throw new AppError(400, 'LINK_INVALID', 'This link is not valid');
    const taken = await User.findOne({
      where: { email: newEmail, id: { [Op.ne]: user.id! } },
      transaction: tx,
    });
    if (taken) throw new ConflictError('EMAIL_IN_USE', 'This email already belongs to another account');
    await consumeOrThrow(tx, token);
    const old = user.email;
    user.email = newEmail;
    user.emailVerifiedAt = now();
    user.version += 1;
    await user.save({ transaction: tx });
    await audit(
      ctx,
      {
        action: 'auth.user.email_changed',
        entityType: 'user',
        entityId: user.id!,
        before: { email: old },
        after: { email: newEmail },
        actor: { userId: user.id!, name: user.name ?? 'User', role: 'user' },
      },
      tx,
    );
    if (old) safeAfterCommit(tx, () => notify('auth.email_changed', [{ email: old }], { newEmail }));
    return { email: newEmail };
  });
}

/** Section 8.30 `auth.issueAccountSetupToken` (BR-02-19). */
export async function issueAccountSetupToken(
  ctx: Ctx,
  userId: number,
  opts: { invitationId?: number; expiresAt?: Date },
  tx: Transaction,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const user = await lockUser(userId, tx);
  if (user.status !== 'INVITED')
    throw new AppError(409, 'INVALID_STATE', 'Only invited users get a setup link');
  let expiresAt: Date;
  if (opts.invitationId !== undefined) {
    const t = now();
    if (!opts.expiresAt || opts.expiresAt <= t || opts.expiresAt > addDays(t, 30))
      throw new ValidationError([
        { field: 'expiresAt', message: 'Must be in the future and at most 30 days ahead' },
      ]);
    expiresAt = opts.expiresAt;
  } else expiresAt = ttl(SETUP_NO_INVITE_TTL);
  const t = await issueToken(ctx, tx, {
    purpose: 'ACCOUNT_SETUP',
    userId,
    payload: opts.invitationId !== undefined ? { invitationId: opts.invitationId } : {},
    expiresAt,
    createdBy: ctx.user?.id ?? null,
    revokeOlder: true,
  });
  return { rawToken: t.raw, expiresAt: t.expiresAt };
}

/** Section 8.30 `auth.revokeAccountSetupTokens`: the invitation was cancelled or expired. */
export async function revokeAccountSetupTokens(
  userId: number,
  invitationId: number,
  tx: Transaction,
): Promise<number> {
  const open = await AuthToken.findAll({
    where: { userId, purpose: 'ACCOUNT_SETUP', consumedAt: null, revokedAt: null },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  let n = 0;
  for (const t of open)
    if (t.payload?.invitationId === invitationId) {
      t.revokedAt = now();
      await t.save({ transaction: tx });
      n += 1;
    }
  return n;
}

/** Section 8.30 `auth.consumeSignupToken` (BR-02-54). */
export async function consumeSignupToken(
  tx: Transaction,
  rawToken: string,
  opts: { clientApp: ClientApp },
): Promise<{ mobile: string }> {
  const token = await findToken(rawToken, 'SIGNUP', tx, true);
  const problem = classify(token);
  if (!token || token.revokedAt) throw new AppError(400, 'LINK_INVALID', 'This link is not valid');
  if (token.payload?.clientApp !== opts.clientApp)
    throw new AppError(400, 'LINK_INVALID', 'This link is not valid');
  if (problem)
    throw new AppError(
      400,
      `LINK_${problem}`,
      problem === 'USED' ? 'This link was already used' : 'This link has expired',
    );
  await consumeOrThrow(tx, token);
  const mobile = String(token.payload?.mobile);
  await audit(
    { requestId: 'service', ip: '', userAgent: '' },
    {
      action: 'auth.signup.token_consumed',
      entityType: 'mobile',
      entityId: `${mobile.slice(0, 2)}XXXXX${mobile.slice(-3)}`,
      actor: { userId: null, name: 'Visitor', role: 'anonymous' },
    },
    tx,
  );
  return { mobile };
}
