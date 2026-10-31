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
}

export class MemoryKv implements KvStore {
  private windows = new Map<string, number[]>();
  private lists = new Map<string, string[]>();

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
