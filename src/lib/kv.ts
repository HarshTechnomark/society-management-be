import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { env } from './env';
import { logger } from './logger';
import { nowMs } from './clock';

/**
 * Small key-value store behind everything the spec puts on Redis: rate-limit counters and the dev inbox.
 * Two implementations: Redis (used when REDIS_URL is set) and an in-process memory one (development and tests).
 */
export interface HitResult {
  allowed: boolean;
  count: number;
  /** Seconds until the oldest hit leaves the window; 0 when allowed. */
  retryAfterSeconds: number;
}

export interface KvStore {
  /** Sliding window: counts the hit when under the limit; a denied attempt is not counted. */
  slidingWindowHit(key: string, windowMs: number, limit: number): Promise<HitResult>;
  slidingWindowReset(keyPrefix: string): Promise<void>;
  /** Newest first, capped at `max` entries. */
  listPush(key: string, value: string, max: number): Promise<void>;
  listAll(key: string): Promise<string[]>;
  listClear(key: string): Promise<void>;
  /** Plain cache (module 03 permission cache). A missing or expired key returns null. */
  cacheGet(key: string): Promise<string | null>;
  cacheSet(key: string, value: string, ttlSeconds: number): Promise<void>;
  cacheDel(...keys: string[]): Promise<void>;
  /** Deletes every key that starts with the prefix (SCAN on Redis). */
  cacheDelPrefix(prefix: string): Promise<void>;
  /** Integer counter without expiry (module 04 cache generations `ent:gen:<id>`, `ff:gen`). Missing reads as 0. */
  counterGet(key: string): Promise<number>;
  /** Atomic `INCR`; returns the new value. */
  counterIncr(key: string): Promise<number>;
  /** Set with a TTL on the whole key (module 07 banner dismissals `pn:dismissed:<id>`). The TTL is refreshed on every add. */
  setAdd(key: string, member: string, ttlSeconds: number): Promise<void>;
  setHas(key: string, member: string): Promise<boolean>;
  /** Hash of integer fields (module 07 request metrics and provider day counters); the TTL is refreshed on every call. */
  hashIncr(key: string, field: string, by: number, ttlSeconds: number): Promise<void>;
  hashGetAll(key: string): Promise<Record<string, number>>;
  /** Hash keys that start with the prefix (module 07 metrics trim). */
  hashKeys(prefix: string): Promise<string[]>;
  hashDel(...keys: string[]): Promise<void>;
}

export class MemoryKv implements KvStore {
  private windows = new Map<string, number[]>();
  private lists = new Map<string, string[]>();
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private counters = new Map<string, number>();
  private sets = new Map<string, { members: Set<string>; expiresAt: number }>();
  private hashes = new Map<string, { fields: Map<string, number>; expiresAt: number }>();

  async slidingWindowHit(key: string, windowMs: number, limit: number): Promise<HitResult> {
    const t = nowMs();
    const hits = (this.windows.get(key) ?? []).filter(x => x > t - windowMs);
    if (hits.length >= limit) {
      this.windows.set(key, hits);
      return {
        allowed: false,
        count: hits.length,
        retryAfterSeconds: Math.ceil((hits[0] + windowMs - t) / 1000),
      };
    }
    hits.push(t);
    this.windows.set(key, hits);
    return { allowed: true, count: hits.length, retryAfterSeconds: 0 };
  }

  async slidingWindowReset(keyPrefix: string): Promise<void> {
    for (const k of [...this.windows.keys()]) if (k.startsWith(keyPrefix)) this.windows.delete(k);
  }

  async listPush(key: string, value: string, max: number): Promise<void> {
    const l = this.lists.get(key) ?? [];
    l.unshift(value);
    this.lists.set(key, l.slice(0, max));
  }
  async listAll(key: string): Promise<string[]> {
    return [...(this.lists.get(key) ?? [])];
  }
  async listClear(key: string): Promise<void> {
    this.lists.delete(key);
  }

  async cacheGet(key: string): Promise<string | null> {
    const e = this.cache.get(key);
    if (!e) return null;
    if (e.expiresAt <= nowMs()) {
      this.cache.delete(key);
      return null;
    }
    return e.value;
  }
  async cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.cache.set(key, { value, expiresAt: nowMs() + ttlSeconds * 1000 });
  }
  async cacheDel(...keys: string[]): Promise<void> {
    for (const k of keys) this.cache.delete(k);
  }
  async cacheDelPrefix(prefix: string): Promise<void> {
    for (const m of [this.cache, this.sets, this.hashes] as Map<string, unknown>[])
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
  }
  async counterGet(key: string): Promise<number> {
    return this.counters.get(key) ?? 0;
  }
  async counterIncr(key: string): Promise<number> {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }
  async setAdd(key: string, member: string, ttlSeconds: number): Promise<void> {
    const e = this.sets.get(key);
    const live = e && e.expiresAt > nowMs() ? e : { members: new Set<string>(), expiresAt: 0 };
    live.members.add(member);
    live.expiresAt = nowMs() + ttlSeconds * 1000;
    this.sets.set(key, live);
  }
  async setHas(key: string, member: string): Promise<boolean> {
    const e = this.sets.get(key);
    return Boolean(e && e.expiresAt > nowMs() && e.members.has(member));
  }
  async hashIncr(key: string, field: string, by: number, ttlSeconds: number): Promise<void> {
    const e = this.hashes.get(key);
    const live = e && e.expiresAt > nowMs() ? e : { fields: new Map<string, number>(), expiresAt: 0 };
    live.fields.set(field, (live.fields.get(field) ?? 0) + by);
    live.expiresAt = nowMs() + ttlSeconds * 1000;
    this.hashes.set(key, live);
  }
  async hashGetAll(key: string): Promise<Record<string, number>> {
    const e = this.hashes.get(key);
    return e && e.expiresAt > nowMs() ? Object.fromEntries(e.fields) : {};
  }
  async hashKeys(prefix: string): Promise<string[]> {
    return [...this.hashes.keys()].filter(k => k.startsWith(prefix));
  }
  async hashDel(...keys: string[]): Promise<void> {
    for (const k of keys) this.hashes.delete(k);
  }
}

const SLIDING_WINDOW_LUA = `
local now = tonumber(ARGV[1]); local win = tonumber(ARGV[2]); local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - win)
local c = redis.call('ZCARD', KEYS[1])
if c >= limit then
  local o = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, c, tonumber(o[2])}
end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], win)
return {1, c + 1, 0}
`;

export class RedisKv implements KvStore {
  constructor(private readonly redis: Redis) {}

  async slidingWindowHit(key: string, windowMs: number, limit: number): Promise<HitResult> {
    const t = nowMs();
    const member = `${t}:${randomBytes(6).toString('hex')}`;
    const [allowed, count, oldest] = (await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      `rl:${key}`,
      t,
      windowMs,
      limit,
      member,
    )) as [number, number, number];
    return {
      allowed: allowed === 1,
      count,
      retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)),
    };
  }

  async slidingWindowReset(keyPrefix: string): Promise<void> {
    const keys = await this.redis.keys(`rl:${keyPrefix}*`);
    if (keys.length) await this.redis.del(...keys);
  }

  async listPush(key: string, value: string, max: number): Promise<void> {
    await this.redis
      .multi()
      .lpush(`list:${key}`, value)
      .ltrim(`list:${key}`, 0, max - 1)
      .exec();
  }
  async listAll(key: string): Promise<string[]> {
    return this.redis.lrange(`list:${key}`, 0, -1);
  }
  async listClear(key: string): Promise<void> {
    await this.redis.del(`list:${key}`);
  }

  async cacheGet(key: string): Promise<string | null> {
    return this.redis.get(`cache:${key}`);
  }
  async cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`cache:${key}`, value, 'EX', ttlSeconds);
  }
  async cacheDel(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys.map(k => `cache:${k}`));
  }
  async cacheDelPrefix(prefix: string): Promise<void> {
    for (const ns of ['cache', 'set', 'hash']) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${ns}:${prefix}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== '0');
    }
  }
  async setAdd(key: string, member: string, ttlSeconds: number): Promise<void> {
    await this.redis.multi().sadd(`set:${key}`, member).expire(`set:${key}`, ttlSeconds).exec();
  }
  async setHas(key: string, member: string): Promise<boolean> {
    return (await this.redis.sismember(`set:${key}`, member)) === 1;
  }
  async hashIncr(key: string, field: string, by: number, ttlSeconds: number): Promise<void> {
    await this.redis.multi().hincrby(`hash:${key}`, field, by).expire(`hash:${key}`, ttlSeconds).exec();
  }
  async hashGetAll(key: string): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(`hash:${key}`);
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
  }
  async hashKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `hash:${prefix}*`, 'COUNT', 500);
      cursor = next;
      out.push(...keys.map(k => k.slice('hash:'.length)));
    } while (cursor !== '0');
    return out;
  }
  async hashDel(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys.map(k => `hash:${k}`));
  }
  async counterGet(key: string): Promise<number> {
    return Number((await this.redis.get(`ctr:${key}`)) ?? 0);
  }
  async counterIncr(key: string): Promise<number> {
    return this.redis.incr(`ctr:${key}`);
  }
}

let redisClient: Redis | undefined;
/** The shared Redis connection, or undefined when REDIS_URL is not set. */
export function redis(): Redis | undefined {
  const url = env().REDIS_URL;
  if (!url) return undefined;
  if (!redisClient) {
    redisClient = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    redisClient.on('error', err => logger.warn({ err }, 'redis error'));
  }
  return redisClient;
}

let store: KvStore | undefined;
export function kv(): KvStore {
  if (!store) {
    const r = redis();
    store = r ? new RedisKv(r) : new MemoryKv();
  }
  return store;
}

/** Test helper: replace the store (for example with a store that throws, to test fail-closed limiting). */
export function setKv(s: KvStore | undefined): void {
  store = s;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) await redisClient.quit();
  redisClient = undefined;
}
