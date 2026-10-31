import type { RequestHandler } from 'express';
import { env } from '../lib/env';
import { AppError } from '../utils/errors';
import { isPublicRoute, isRefreshRoute } from '../modules/auth/public.routes';
import { csrfTokenFor, safeEqual } from '../modules/auth/auth.crypto';
import { sessionIdFromRefresh } from '../modules/auth/auth.sessions';
import { COOKIES, verifyAccessToken } from '../modules/auth/auth.tokens';
import { originOf } from '../modules/auth/auth.apps';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const fail = (message: string) => new AppError(403, 'CSRF_FAILED', message);

/**
 * CSRF double-submit and Origin check (BR-02-35). Runs before `authMiddleware` on POST, PUT, PATCH and DELETE, except
 * webhooks. The Origin (or Referer origin) must be an app origin. For cookie-authenticated routes `X-CSRF-Token` must
 * equal the `sa_csrf` cookie and the HMAC of the session id. A request that carries no session cookie at all has nothing
 * a forged page could ride on, so it passes here and is refused by `authMiddleware` with 401.
 */
export const csrfMiddleware: RequestHandler = (req, _res, next) => {
  // /dev/* exists only outside production (fake inbox for tools and tests) and carries no session
  if (!UNSAFE.has(req.method) || req.path.startsWith('/webhooks/') || req.path.startsWith('/dev/'))
    return next();
  const origin = originOf(req.get('origin')) ?? originOf(req.get('referer'));
  if (!origin || !env().appOrigins.includes(origin)) return next(fail('Request origin is not allowed'));
  if (isPublicRoute(req.method, req.path)) return next();

  const access = req.cookies?.[COOKIES.access] as string | undefined;
  const refresh = req.cookies?.[COOKIES.refresh] as string | undefined;
  if (!access && !refresh) return next();

  const fromAccess = access ? verifyAccessToken(access, undefined, { ignoreExpiration: true }) : null;
  const accessSid = fromAccess ? Number(fromAccess.sid) : null;
  const refreshSid = sessionIdFromRefresh(refresh);
  // two cookies naming different sessions never belong together; the refresh route trusts only its own cookie
  if (accessSid !== null && refreshSid !== null && accessSid !== refreshSid)
    return next(fail('CSRF token is missing or wrong'));
  const sid = isRefreshRoute(req.method, req.path) ? refreshSid : (accessSid ?? refreshSid);
  const header = req.get('x-csrf-token');
  const cookie = req.cookies?.[COOKIES.csrf] as string | undefined;
  if (!sid || !header || !cookie || !safeEqual(header, cookie) || !safeEqual(header, csrfTokenFor(sid)))
    return next(fail('CSRF token is missing or wrong'));
  next();
};
