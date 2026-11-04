import type { Request, RequestHandler } from 'express';
import { Session, User } from '../models';
import { nowMs, now } from '../lib/clock';
import { AppError } from '../utils/errors';
import { isPublicRoute, isRefreshRoute } from '../modules/auth/public.routes';
import { COOKIES, verifyAccessToken } from '../modules/auth/auth.tokens';
import { isExpiredIdle, revokeSessionById } from '../modules/auth/auth.sessions';
import { ports } from '../modules/auth/auth.ports';
import { childLogger } from '../lib/logger';

const unauth = () => new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
const BUMP_EVERY_MS = 60_000;

/**
 * Who is this person and is the session still valid (BR-02-38). Public routes pass through. Everything else needs a
 * valid `sa_access` cookie for this host's app, a live session and a user who may hold one.
 */
export const authMiddleware: RequestHandler = async (req, res, next) => {
  try {
    if (isPublicRoute(req.method, req.path) || isRefreshRoute(req.method, req.path)) return next();
    const token = req.cookies?.[COOKIES.access] as string | undefined;
    if (!token) return next(unauth());
    const claims = verifyAccessToken(token, req.ctx.clientApp);
    if (!claims || !req.ctx.clientApp) return next(unauth());

    const session = await Session.findByPk(Number(claims.sid));
    const user =
      session && session.userId === Number(claims.sub) ? await User.findByPk(session.userId) : null;
    if (
      !session ||
      !user ||
      session.revokedAt ||
      (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION')
    )
      return next(new AppError(401, 'SESSION_REVOKED', 'Your session was ended'));

    const t = now();
    if (t >= session.absoluteExpiresAt) {
      await revokeSessionById(session.id!, session.supportGrantId ? 'SUPPORT_GRANT_ENDED' : 'EXPIRED');
      return next(
        new AppError(401, 'SESSION_EXPIRED', 'Your session has expired', [
          { field: 'reason', message: 'ABSOLUTE' },
        ]),
      );
    }
    if (isExpiredIdle(session, t)) {
      await revokeSessionById(session.id!, 'IDLE_TIMEOUT');
      return next(
        new AppError(401, 'SESSION_EXPIRED', 'You were signed out for inactivity', [
          { field: 'reason', message: 'IDLE' },
        ]),
      );
    }
    if (session.supportGrantId && !(await ports().supportAccess.isGrantActive(session.supportGrantId))) {
      await revokeSessionById(session.id!, 'SUPPORT_GRANT_ENDED');
      return next(new AppError(401, 'SESSION_REVOKED', 'Support access has ended'));
    }

    // BR-02-37: at most once a minute, and never for background polls
    if (req.get('x-user-activity') !== '0' && nowMs() - session.lastSeenAt.getTime() >= BUMP_EVERY_MS) {
      session.lastSeenAt = t;
      if (req.ctx.ip) session.ipLast = req.ctx.ip.slice(0, 45);
      await session.save({ fields: ['lastSeenAt', 'ipLast', 'updatedAt'] });
    }

    req.ctx.user = {
      id: user.id!,
      name: user.name,
      mobile: user.mobile,
      email: user.email,
      platformRoleId: user.platformRoleId,
      status: user.status,
    };
    req.ctx.session = {
      id: session.id!,
      authTime: session.authTime,
      clientApp: session.clientApp,
      activeSocietyId: session.activeSocietyId,
      mfaVerified: session.mfaVerified,
      amr: session.amr,
      supportGrantId: session.supportGrantId,
      idleTimeoutMinutes: session.idleTimeoutMinutes,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
    res.locals.log = childLogger({ requestId: req.ctx.requestId, userId: user.id! });
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * For public routes that may act for a signed-in person when one is present (the development approvals page): the user
 * and session of a valid `sa_access` cookie, or `null`. Read-only: it never revokes, bumps or refuses, so a missing,
 * expired or revoked session simply means "no session" and the route keeps its public behaviour.
 */
export async function readOptionalSession(
  req: Request,
): Promise<{ user: NonNullable<Request['ctx']['user']>; activeSocietyId: number | null } | null> {
  const token = req.cookies?.[COOKIES.access] as string | undefined;
  if (!token || !req.ctx.clientApp) return null;
  const claims = verifyAccessToken(token, req.ctx.clientApp);
  if (!claims) return null;
  const session = await Session.findByPk(Number(claims.sid));
  if (!session || session.userId !== Number(claims.sub) || session.revokedAt) return null;
  const t = now();
  if (t >= session.absoluteExpiresAt || isExpiredIdle(session, t)) return null;
  const user = await User.findByPk(session.userId);
  if (!user || (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION')) return null;
  return {
    user: {
      id: user.id!,
      name: user.name,
      mobile: user.mobile,
      email: user.email,
      platformRoleId: user.platformRoleId,
      status: user.status,
    },
    activeSocietyId: session.activeSocietyId,
  };
}
