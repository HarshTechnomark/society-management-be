import type { Transaction } from 'sequelize';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';

/**
 * Cache keys and invalidation (BR-03-20, section 9.2). Everything goes through `lib/kv` (Redis, or memory without Redis).
 * A cache failure never skips a check: callers fall back to the database.
 */
export const TTL = { role: 300, member: 300, society: 60 } as const;
export const keys = {
  role: (roleId: number) => `acl:role:${roleId}`,
  member: (societyId: number, userId: number) => `acl:member:${societyId}:${userId}`,
  society: (societyId: number) => `acl:society:${societyId}`,
  platformRole: (roleId: number) => `acl:platform-role:${roleId}`,
};

/** Reads through the cache; on a miss or a store error loads from the database and tries to store. */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T | null>,
): Promise<T | null> {
  try {
    const hit = await kv().cacheGet(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn({ err, key }, 'acl cache read failed, using the database');
  }
  const value = await load();
  if (value !== null) {
    try {
      await kv().cacheSet(key, JSON.stringify(value), ttlSeconds);
    } catch (err) {
      logger.warn({ err, key }, 'acl cache write failed');
    }
  }
  return value;
}

export async function del(...ks: string[]): Promise<void> {
  try {
    await kv().cacheDel(...ks);
  } catch (err) {
    logger.error({ err, keys: ks }, 'acl cache delete failed');
  }
}

/** Deletes the keys once the transaction has committed (BR-03-20). Without a transaction deletes now. */
export function delAfterCommit(tx: Transaction | undefined, ...ks: string[]): void {
  if (!tx) {
    void del(...ks);
    return;
  }
  tx.afterCommit(async () => del(...ks));
}

export const invalidateRoleKeys = (tx: Transaction | undefined, roleId: number) =>
  delAfterCommit(tx, keys.role(roleId), keys.platformRole(roleId));
export const invalidateMemberKey = (tx: Transaction | undefined, societyId: number, userId: number) =>
  delAfterCommit(tx, keys.member(societyId, userId));
export const invalidateSocietyKey = (tx: Transaction | undefined, societyId: number) =>
  delAfterCommit(tx, keys.society(societyId));

/** Catalogue sync: SCAN and delete `acl:*`. */
export async function flushAcl(): Promise<void> {
  try {
    await kv().cacheDelPrefix('acl:');
  } catch (err) {
    logger.error({ err }, 'acl cache flush failed');
  }
}
