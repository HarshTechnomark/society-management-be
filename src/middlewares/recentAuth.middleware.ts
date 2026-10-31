import type { RequestHandler } from 'express';
import { nowMs } from '../lib/clock';
import { AppError } from '../utils/errors';
import { stepUpMinutesFor } from '../modules/auth/auth.sessions';

/**
 * Step-up (BR-02-40): `401 REAUTH_REQUIRED` when the last authentication is older than the window. The window is 5
 * minutes by default, comes from the platform or society settings for PLATFORM and ADMIN, and `minutes` overrides it.
 */
export const requireRecentAuth =
  (minutes?: number): RequestHandler =>
  async (req, _res, next) => {
    try {
      const s = req.ctx.session;
      if (!s) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue'));
      const window = minutes ?? (await stepUpMinutesFor(s.clientApp, s.activeSocietyId));
      if (s.amr.includes('PIN') || nowMs() - s.authTime.getTime() > window * 60_000)
        return next(new AppError(401, 'REAUTH_REQUIRED', 'Confirm it is you to continue'));
      next();
    } catch (err) {
      next(err);
    }
  };
