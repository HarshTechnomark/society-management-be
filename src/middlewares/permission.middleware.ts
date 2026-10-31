import type { RequestHandler } from 'express';
import { kv } from '../lib/kv';
import { logger } from '../lib/logger';
import { AppError, ForbiddenError } from '../utils/errors';
import { tag } from '../modules/access-control/access-control.registry';

/** Records a denial: info for every one, warn when a user is denied more than 20 times in 10 minutes (section 9.3). */
async function logDenial(userId: number | undefined, route: string, keys: string[]): Promise<void> {
  logger.info({ userId, route, permissions: keys }, 'permission denied');
  if (!userId) return;
  try {
    const r = await kv().slidingWindowHit(`acl-deny:${userId}`, 600_000, 20);
    if (!r.allowed) logger.warn({ userId, route }, 'repeated permission denials');
  } catch {
    /* logging only */
  }
}

/** `403 PERMISSION_DENIED` unless the caller holds at least one of the keys (any-of). Needs `societyMiddleware` first. */
export const requirePermission = (...anyOf: string[]): RequestHandler =>
  tag(
    (req, _res, next) => {
      if (anyOf.some(k => req.ctx.permissions.has(k))) return next();
      void logDenial(req.ctx.user?.id, `${req.method} ${req.baseUrl}${req.path}`, anyOf);
      next(new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to do this'));
    },
    { permissions: anyOf },
  );

/** Same for platform routes. Needs `platformMiddleware` first. */
export const requirePlatformPermission = (...anyOf: string[]): RequestHandler =>
  tag(
    (req, _res, next) => {
      if (anyOf.some(k => req.ctx.platformPermissions.has(k))) return next();
      void logDenial(req.ctx.user?.id, `${req.method} ${req.baseUrl}${req.path}`, anyOf);
      next(new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to do this'));
    },
    { permissions: anyOf },
  );

/** Marks a route that needs no sign-in (it must also be listed in `public.routes.ts`). */
export const publicRoute = (): RequestHandler => tag((_req, _res, next) => next(), { kind: 'public' });

/** Marks a route for any signed-in user, with no society context (`authMiddleware` already ran). */
export const authenticatedOnly = (): RequestHandler =>
  tag(
    (req, _res, next) =>
      req.ctx.user ? next() : next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue')),
    { kind: 'auth' },
  );

/** Tags a whole mounted area (for example `/auth`) as authenticated-or-public-by-list without checking anything itself. */
export const authArea = (): RequestHandler => tag((_req, _res, next) => next(), { kind: 'auth' });
