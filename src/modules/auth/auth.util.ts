import type { Transaction } from 'sequelize';
import { sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/errors';
import { rateLimitHit } from '../../lib/kv-limit';

/** Minimum response time for enumeration-sensitive routes (BR-02-12). Real wall-clock time, so frozen test clocks do not hang. */
let minResponseMs = 400;
export const setMinResponseMs = (ms: number): void => {
  minResponseMs = ms;
};

export async function withMinDuration<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const pad = async () => {
    const left = minResponseMs - (Date.now() - start);
    if (left > 0) await new Promise(r => setTimeout(r, left));
  };
  try {
    const r = await fn();
    await pad();
    return r;
  } catch (e) {
    await pad();
    throw e;
  }
}

/**
 * Runs `fn` in a transaction. When `fn` returns `{ error }` the transaction is committed (so audit rows and counters
 * written before the failure stay) and the error is thrown afterwards.
 */
export async function txOutcome<T>(fn: (t: Transaction) => Promise<T | { error: AppError }>): Promise<T> {
  const r = await sequelize.transaction(fn as (t: Transaction) => Promise<T | { error: AppError }>);
  if (
    r &&
    typeof r === 'object' &&
    'error' in (r as object) &&
    (r as { error: unknown }).error instanceof AppError
  )
    throw (r as { error: AppError }).error;
  return r as T;
}

/** Service-level rate limit for keys that are only known after the request body is read. */
export { rateLimitHit };

export const safeAfterCommit = (t: Transaction, fn: () => Promise<unknown> | unknown): void => {
  t.afterCommit(async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, 'after-commit action failed');
    }
  });
};
