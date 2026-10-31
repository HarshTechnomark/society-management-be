import { kv } from './kv';
import { RateLimitedError } from '../utils/errors';

/** Counts a hit against a sliding window and throws `429 RATE_LIMITED` when over the limit. */
export async function rateLimitHit(
  name: string,
  subject: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const r = await kv().slidingWindowHit(`${name}:${subject}`, windowSeconds * 1000, limit);
  if (!r.allowed) throw new RateLimitedError(r.retryAfterSeconds);
}
