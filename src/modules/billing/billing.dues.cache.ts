import type { Transaction } from 'sequelize';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { billingPorts } from './billing.ports';

/**
 * Section 8.26 and the 30 second cache of `GET /billing/summary` (8.22). The cache is the module 01 key-value store (Redis
 * when `REDIS_URL` is set, memory otherwise). `touchDues` is called after every write that changes dues data: it clears the
 * society's cached summaries and calls the module 24 port `reportsCache.touch(societyId, 'dues')`. It never throws.
 */
export const SUMMARY_TTL_SECONDS = 30;
const summaryKey = (societyId: number, month: string): string => `billing:summary:${societyId}:${month}`;

export async function cachedSummary<T>(societyId: number, month: string, load: () => Promise<T>): Promise<T> {
  const key = summaryKey(societyId, month);
  try {
    const hit = await kv().cacheGet(key);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn({ err }, 'billing summary cache read failed');
  }
  const value = await load();
  try {
    await kv().cacheSet(key, JSON.stringify(value), SUMMARY_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, 'billing summary cache write failed');
  }
  return value;
}

async function touchNow(societyId: number): Promise<void> {
  try {
    await kv().cacheDelPrefix(`billing:summary:${societyId}:`);
    await billingPorts().reports.touch(societyId, 'dues');
  } catch (err) {
    logger.warn({ err, societyId }, 'reportsCache.touch failed');
  }
}

/** With a transaction the touch runs after commit (a rolled-back write never touches); without one it runs now. */
export function touchDues(societyId: number, t?: Transaction): void {
  if (t) t.afterCommit(() => touchNow(societyId));
  else void touchNow(societyId);
}

/** Awaitable form for jobs that touch once per committed batch. */
export const touchDuesAfterBatch = (societyId: number): Promise<void> => touchNow(societyId);
