import type { Request, RequestHandler } from 'express';
import { env } from '../lib/env';
import { appForOrigin, originOf } from '../modules/auth/auth.apps';
import { COOKIES } from '../modules/auth/auth.tokens';

/** Origin of the caller: `Origin`, else the `Referer` origin, else the request host when it is an app host. */
export function requestOrigin(req: Request): string | undefined {
  const origin = originOf(req.get('origin'));
  if (origin) return origin;
  const ref = originOf(req.get('referer'));
  if (ref) return ref;
  const host = req.get('x-forwarded-host') ?? req.get('host');
  if (!host) return undefined;
  return env().appOrigins.find(o => new URL(o).host === host);
}

/** Puts the app (BR-02-43) and the device cookie on `req.ctx`. */
export const appContext: RequestHandler = (req, _res, next) => {
  const origin = requestOrigin(req);
  const app = appForOrigin(origin);
  if (app) {
    req.ctx.clientApp = app;
    req.ctx.origin = origin;
  }
  const device = req.cookies?.[COOKIES.device];
  if (typeof device === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(device)) req.ctx.deviceId = device;
  next();
};
