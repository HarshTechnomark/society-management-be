import { QueryTypes, type Transaction } from 'sequelize';
import { AuthLockout, sequelize } from '../../models';
import type { LockoutScope } from '../../models/auth-lockout.model';
import { addMs, now } from '../../lib/clock';
import { AppError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import { systemCtx, type Ctx } from '../../types/context';
import { lockoutSubjectHash } from './auth.crypto';

/** BR-02-28: thresholds, windows and lock durations per scope. */
export const LOCKOUT_POLICY: Record<LockoutScope, { threshold: number; windowMs: number; lockMs: number }> = {
  OTP: { threshold: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  MFA: { threshold: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  PASSWORD: { threshold: 10, windowMs: 30 * 60_000, lockMs: 30 * 60_000 },
};

/** `429 ACCOUNT_LOCKED` with `Retry-After` and `errors[retryAfterSeconds]` (BR-02-30). */
export const lockedError = (retryAfterSeconds: number): AppError =>
  new AppError(
    429,
    'ACCOUNT_LOCKED',
    'Too many attempts. Try again later.',
    [{ field: 'retryAfterSeconds', message: String(retryAfterSeconds) }],
    { 'Retry-After': String(retryAfterSeconds) },
  );

export const subjectKey = (scope: LockoutScope, subject: string): string =>
  lockoutSubjectHash(scope, scope === 'PASSWORD' ? subject.toLowerCase() : subject);

/** Seconds left on an active lock, or 0. */
export async function lockRemainingSeconds(
  scope: LockoutScope,
  subject: string,
  tx?: Transaction,
): Promise<number> {
  const row = await AuthLockout.findOne({
    where: { scope, subjectHash: subjectKey(scope, subject) },
    transaction: tx,
  });
  if (!row?.lockedUntil) return 0;
  const ms = row.lockedUntil.getTime() - now().getTime();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

export async function assertNotLocked(scope: LockoutScope, subject: string, tx?: Transaction): Promise<void> {
  const s = await lockRemainingSeconds(scope, subject, tx);
  if (s > 0) throw lockedError(s);
}

export interface FailureResult {
  /** The subject was already locked before this failure (the failure is not counted). */
  alreadyLocked: boolean;
  /** This failure started a lock. */
  newlyLocked: boolean;
  attemptsLeft: number;
  retryAfterSeconds: number;
}

const isDeadlock = (e: unknown): boolean => {
  const code = (e as { parent?: { code?: string } })?.parent?.code;
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
};

/**
 * Records one failure in its own transaction, so a rejected sign-in still leaves a trace (BR-02-28, section 9.2).
 * The row is re-read FOR UPDATE, so parallel wrong attempts cannot exceed the threshold without locking.
 */
export async function recordFailure(
  scope: LockoutScope,
  subject: string,
  opts: { userId?: number | null; ctx?: Ctx } = {},
): Promise<FailureResult> {
  const p = LOCKOUT_POLICY[scope];
  const hash = subjectKey(scope, subject);
  for (let attempt = 0; ; attempt++) {
    try {
      let notifyUser = false;
      const result = await sequelize.transaction(async t => {
        const t0 = now();
        await sequelize.query(
          `INSERT INTO auth_lockouts (scope, subjectHash, userId, failedCount, windowStartedAt, lastFailedAt, lockCount, createdAt, updatedAt)
           VALUES (:scope, :hash, :userId, 0, :t0, :t0, 0, :t0, :t0) ON DUPLICATE KEY UPDATE id = id`,
          { replacements: { scope, hash, userId: opts.userId ?? null, t0 }, transaction: t },
        );
        const row = (await AuthLockout.findOne({
          where: { scope, subjectHash: hash },
          transaction: t,
          lock: t.LOCK.UPDATE,
        }))!;
        if (row.lockedUntil && row.lockedUntil > t0) {
          return {
            alreadyLocked: true,
            newlyLocked: false,
            attemptsLeft: 0,
            retryAfterSeconds: Math.ceil((row.lockedUntil.getTime() - t0.getTime()) / 1000),
          };
        }
        const windowOver =
          t0.getTime() - row.windowStartedAt.getTime() > p.windowMs || row.lockedUntil !== null;
        if (windowOver || row.failedCount === 0) {
          row.failedCount = 0;
          row.windowStartedAt = t0;
          row.lockedUntil = null;
        }
        row.failedCount += 1;
        row.lastFailedAt = t0;
        if (opts.userId && !row.userId) row.userId = opts.userId;
        let newlyLocked = false;
        if (row.failedCount >= p.threshold) {
          row.lockedUntil = addMs(t0, p.lockMs);
          row.lockCount += 1;
          newlyLocked = true;
        }
        await row.save({ transaction: t });
        if (newlyLocked) {
          if (row.userId) {
            await audit(
              opts.ctx ?? systemCtx(),
              {
                action: 'auth.lockout.started',
                entityType: 'user',
                entityId: row.userId,
                after: { scope, retryAfterSeconds: Math.round(p.lockMs / 1000) },
                actor: { userId: row.userId, name: 'User', role: 'user' },
              },
              t,
            );
          }
          notifyUser = scope !== 'OTP' && Boolean(row.userId);
        }
        return {
          alreadyLocked: false,
          newlyLocked,
          attemptsLeft: Math.max(0, p.threshold - row.failedCount),
          retryAfterSeconds: newlyLocked ? Math.round(p.lockMs / 1000) : 0,
        };
      });
      if (result.newlyLocked && notifyUser && opts.userId)
        void notify('auth.account_locked', [{ userId: opts.userId }], {
          scope,
          minutes: Math.round(p.lockMs / 60000),
        });
      return result;
    } catch (err) {
      if (isDeadlock(err) && attempt < 5) continue;
      logger.error({ err, scope }, 'failed to record lockout failure');
      throw err;
    }
  }
}

/** A success for this scope and subject resets the count (BR-02-28). */
export async function resetLock(scope: LockoutScope, subject: string, tx?: Transaction): Promise<void> {
  await sequelize.query(
    `UPDATE auth_lockouts SET failedCount = 0, lockedUntil = NULL, updatedAt = :t WHERE scope = :scope AND subjectHash = :hash`,
    {
      replacements: { scope, hash: subjectKey(scope, subject), t: now() },
      transaction: tx,
      type: QueryTypes.UPDATE,
    },
  );
}
