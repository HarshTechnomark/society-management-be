import type { Request, RequestHandler } from 'express';
import { kv } from '../lib/kv';
import { logger } from '../lib/logger';
import { AppError, RateLimitedError } from '../utils/errors';

export interface RateLimitOptions {
  /** Short stable name, part of the counter key. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Subject of the limit (IP, mobile, user id). Return null to skip the limit for this request. */
  key: (req: Request) => string | null | undefined;
  /** When the store is down: true answers 429, false lets the request through (OTP send and password sign-in fail closed). */
  failClosed?: boolean;
}

/** Sliding-window limiter (BR-01-6). Exceeding the limit gives `429 RATE_LIMITED` with `Retry-After`. */
export const rateLimit =
  (o: RateLimitOptions): RequestHandler =>
  async (req, res, next) => {
    const subject = o.key(req);
    if (!subject) return next();
    try {
      const r = await kv().slidingWindowHit(`${o.name}:${subject}`, o.windowSeconds * 1000, o.limit);
      if (!r.allowed) return next(new RateLimitedError(r.retryAfterSeconds));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, o.limit - r.count)));
      next();
    } catch (err) {
      logger.warn({ err, limiter: o.name }, 'rate limit store unavailable');
      if (o.failClosed)
        return next(
          new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', undefined, {
            'Retry-After': '30',
          }),
        );
      next();
    }
  };

/** Test helper: forget every counter. */
export const resetRateLimits = (): Promise<void> => kv().slidingWindowReset('');
