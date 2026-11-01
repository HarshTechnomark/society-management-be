import { createHash } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { UniqueConstraintError } from 'sequelize';
import { IdempotencyKey } from '../models';
import { addHours, now } from '../lib/clock';
import { logger } from '../lib/logger';
import { AppError, ValidationError } from '../utils/errors';
import { tag } from '../modules/access-control/access-control.registry';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Canonical JSON: keys sorted, so two clients that order keys differently send the same request. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * `Idempotency-Key` handling (module 01 section 6.3), for create and approval routes. The same key with the same body
 * replays the first response (`Idempotent-Replay: true`); the same key with another body is `409 IDEMPOTENCY_KEY_REUSED`; a key
 * still running is `409 REQUEST_IN_PROGRESS`. Failed requests free the key so the client can retry.
 * Place it after `validate` and after step-up, so a request that is refused for those reasons does not use up the key.
 */
export interface IdempotencyOptions {
  /**
   * Public routes (no user): returns the scope of the key, e.g. the mobile of a sign-up token (module 05 8.1). The key is
   * stored under user id 0 as a UUID derived from SHA-256(scope, key), so two callers never share a key. Returning null
   * skips idempotency and lets the route refuse the request itself.
   */
  publicScope?: (req: import('express').Request) => Promise<string | null>;
}

const scopedKey = (scope: string, key: string): string => {
  const h = createHash('sha256').update(`${scope}:${key.toLowerCase()}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export const idempotency = (opts: IdempotencyOptions = {}): RequestHandler =>
  tag(
    async (req, res, next) => {
      try {
        const key0 = req.get('idempotency-key');
        if (!key0 || !UUID.test(key0))
          return next(
            new ValidationError([
              { field: 'Idempotency-Key', message: 'A UUID Idempotency-Key header is required' },
            ]),
          );
        let userId = req.ctx.user?.id;
        let key = key0;
        if (!userId && opts.publicScope) {
          const scope = await opts.publicScope(req);
          if (!scope) return next();
          userId = 0;
          key = scopedKey(scope, key0);
        }
        if (userId === undefined) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue'));
        const hash = createHash('sha256')
          .update(`${req.method}${req.originalUrl.split('?')[0]}${canonical(req.body)}`)
          .digest('hex');
        const t = now();
        let row: IdempotencyKey | null = null;
        for (let attempt = 0; attempt < 2 && !row; attempt++) {
          try {
            row = await IdempotencyKey.create({
              userId,
              idemKey: key.toLowerCase(),
              societyId: req.ctx.society?.id ?? null,
              method: req.method,
              path: `${req.baseUrl}${req.route?.path ?? ''}`.slice(0, 200),
              requestHash: hash,
              status: 'IN_PROGRESS',
              responseStatus: null,
              responseBody: null,
              expiresAt: addHours(t, 24),
            });
          } catch (err) {
            if (!(err instanceof UniqueConstraintError)) throw err;
            const existing = await IdempotencyKey.findOne({ where: { userId, idemKey: key.toLowerCase() } });
            if (!existing) continue;
            if (existing.expiresAt <= t) {
              await existing.destroy();
              continue;
            }
            if (existing.requestHash !== hash)
              return next(
                new AppError(
                  409,
                  'IDEMPOTENCY_KEY_REUSED',
                  'This Idempotency-Key was used with a different request',
                ),
              );
            if (existing.status === 'COMPLETED') {
              res.setHeader('Idempotent-Replay', 'true');
              if (existing.responseStatus === 204 || existing.responseBody === null)
                return res.status(existing.responseStatus ?? 200).end();
              return res.status(existing.responseStatus ?? 200).json(existing.responseBody);
            }
            return next(
              new AppError(409, 'REQUEST_IN_PROGRESS', 'The same request is still being processed'),
            );
          }
        }
        if (!row)
          return next(new AppError(409, 'REQUEST_IN_PROGRESS', 'The same request is still being processed'));

        // Persist the outcome before the response leaves, so an immediate retry always finds the final state.
        let persisted = false;
        const persist = async (body: unknown): Promise<void> => {
          persisted = true;
          try {
            if (res.statusCode >= 200 && res.statusCode < 300)
              await row!.update({
                status: 'COMPLETED',
                responseStatus: res.statusCode,
                responseBody: (body ?? null) as never,
              });
            else await row!.destroy();
          } catch (err) {
            logger.error({ err }, 'idempotency key update failed');
          }
        };
        const json = res.json.bind(res);
        const end = res.end.bind(res) as (...a: unknown[]) => Response;
        res.json = (b: unknown) => {
          if (persisted) return json(b);
          void persist(b).then(() => json(b));
          return res;
        };
        res.end = ((...args: unknown[]) => {
          if (persisted) return end(...args);
          void persist(null).then(() => end(...args));
          return res;
        }) as typeof res.end;
        next();
      } catch (err) {
        next(err);
      }
    },
    { idempotent: true },
  );
