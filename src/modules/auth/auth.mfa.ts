import { QueryTypes, type Transaction } from 'sequelize';
import { User, UserRecoveryCode, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { AppError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import {
  decryptSecret,
  encryptSecret,
  groupSecret,
  hashRecoveryCode,
  matchTotpStep,
  newRecoveryCode,
  newTotpSecret,
  newUlid,
  normaliseRecoveryCode,
} from './auth.crypto';
import { lockedError, recordFailure } from './auth.lockout';
import { mask } from './auth.types';

export type MfaFailureKind = 'TOTP_INVALID' | 'TOTP_REUSED' | 'RECOVERY_CODE_INVALID';

const MESSAGES: Record<MfaFailureKind, string> = {
  TOTP_INVALID: 'That code is not correct. Check the time on your phone and try again.',
  TOTP_REUSED: 'That code was already used. Wait for the next one.',
  RECOVERY_CODE_INVALID: 'That recovery code is not valid or was already used.',
};

/**
 * Counts a wrong or reused second-factor code against the `MFA` lock (own transaction) and returns the error to throw:
 * `429 ACCOUNT_LOCKED` when the subject was already locked, else the 401 with `attemptsLeft` (BR-02-30).
 */
export async function mfaFailure(
  ctx: Ctx,
  user: Pick<User, 'id' | 'name'>,
  kind: MfaFailureKind,
  method: string,
  extra: { otherAttemptsLeft?: number; tx?: Transaction } = {},
): Promise<AppError> {
  const f = await recordFailure('MFA', String(user.id), { userId: user.id!, ctx, tx: extra.tx });
  if (f.alreadyLocked) return lockedError(f.retryAfterSeconds);
  await audit(
    ctx,
    {
      action: 'auth.login.failed',
      entityType: 'user',
      entityId: user.id!,
      after: { method, reason: kind },
      actor: { userId: user.id!, name: user.name ?? 'User', role: 'user' },
    },
    extra.tx,
  );
  const left = Math.min(f.attemptsLeft, extra.otherAttemptsLeft ?? f.attemptsLeft);
  return new AppError(401, kind, MESSAGES[kind], [{ field: 'attemptsLeft', message: String(left) }]);
}

/** Loads the user with the secret columns. */
export async function userWithSecrets(userId: number, tx?: Transaction, lock = false): Promise<User> {
  const u = await User.scope('withSecrets').findByPk(userId, {
    transaction: tx,
    ...(lock && tx ? { lock: tx.LOCK.UPDATE } : {}),
  });
  if (!u) throw new AppError(404, 'NOT_FOUND', 'User not found');
  return u;
}

/** The matching step of a TOTP code for this user, or null (BR-02-20: steps current-1 to current+1). */
export function totpStepFor(user: User, code: string, atMs: number): number | null {
  if (!user.totpSecretEnc) return null;
  return matchTotpStep(decryptSecret(user.totpSecretEnc), code, atMs);
}

/**
 * BR-02-20: accept a step only if it is newer than `totpLastUsedStep`. Returns false (replay) when 0 rows change.
 */
export async function consumeTotpStep(tx: Transaction, userId: number, step: number): Promise<boolean> {
  const [, affected] = (await sequelize.query(
    'UPDATE users SET totpLastUsedStep = :step, updatedAt = :t WHERE id = :id AND (totpLastUsedStep IS NULL OR totpLastUsedStep < :step)',
    { replacements: { step, id: userId, t: now() }, transaction: tx, type: QueryTypes.UPDATE },
  )) as unknown as [unknown, number];
  return affected > 0;
}

/** BR-02-25: single-use consume. Returns false for an unknown or used code. */
export async function consumeRecoveryCode(
  tx: Transaction,
  userId: number,
  rawCode: string,
  sessionId: number | null,
): Promise<boolean> {
  const hash = hashRecoveryCode(userId, normaliseRecoveryCode(rawCode));
  const [, affected] = (await sequelize.query(
    'UPDATE user_recovery_codes SET usedAt = :t, usedSessionId = :sid, updatedAt = :t WHERE userId = :userId AND codeHash = :hash AND usedAt IS NULL',
    { replacements: { t: now(), sid: sessionId, userId, hash }, transaction: tx, type: QueryTypes.UPDATE },
  )) as unknown as [unknown, number];
  return affected > 0;
}

/** Records which session a just-used recovery code produced. */
export async function setRecoveryCodeSession(
  tx: Transaction,
  userId: number,
  rawCode: string,
  sessionId: number,
): Promise<void> {
  await sequelize.query(
    'UPDATE user_recovery_codes SET usedSessionId = :sid WHERE userId = :userId AND codeHash = :hash',
    {
      replacements: {
        sid: sessionId,
        userId,
        hash: hashRecoveryCode(userId, normaliseRecoveryCode(rawCode)),
      },
      transaction: tx,
    },
  );
}

/** Deletes the old batch and creates ten new codes. Returns the plain codes, shown exactly once (BR-02-24). */
export async function generateRecoveryCodes(userId: number, tx: Transaction): Promise<string[]> {
  await UserRecoveryCode.destroy({ where: { userId }, transaction: tx });
  const batchId = newUlid(now().getTime());
  const codes = new Set<string>();
  while (codes.size < 10) codes.add(newRecoveryCode());
  const list = [...codes];
  await UserRecoveryCode.bulkCreate(
    list.map(c => ({
      userId,
      batchId,
      codeHash: hashRecoveryCode(userId, c),
      usedAt: null,
      usedSessionId: null,
    })),
    { transaction: tx },
  );
  return list;
}

export interface TotpSetupView {
  secret: string;
  otpauthUri: string;
  accountLabel: string;
}

/** Generates a new secret, replacing any unconfirmed one; MFA stays off until confirm (section 8.9). */
export async function startTotpSetup(user: User, tx: Transaction): Promise<TotpSetupView> {
  const secret = newTotpSecret();
  user.totpSecretEnc = encryptSecret(secret);
  await user.save({ transaction: tx, fields: ['totpSecretEnc', 'updatedAt'] });
  const label = user.email ?? (user.mobile ? mask(user.mobile) : String(user.id));
  return {
    secret: groupSecret(secret),
    otpauthUri: `otpauth://totp/SocietyApp:${encodeURIComponent(label)}?secret=${secret}&issuer=SocietyApp&algorithm=SHA1&digits=6&period=30`,
    accountLabel: label,
  };
}
