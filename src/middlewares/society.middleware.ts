import type { RequestHandler } from 'express';
import { Role, User } from '../models';
import { AppError, ForbiddenError } from '../utils/errors';
import {
  computeAccess,
  getPlatformRoleKeys,
  getSocietyInfo,
  supportPermissions,
} from '../modules/access-control/access-control.access';
import { accessPorts } from '../modules/access-control/access-control.ports';
import { tag } from '../modules/access-control/access-control.registry';

export interface SocietyOptions {
  allowWhenSuspended?: boolean;
  allowWhenClosed?: boolean;
}
const READ = new Set(['GET', 'HEAD']);

/**
 * BR-03-17: the society comes only from `session.activeSocietyId`, never from a header, query or body. Fills
 * `ctx.society`, `ctx.membership`, `ctx.permissions`, `ctx.unitIds`, `ctx.unitLinks`, `ctx.supportGrant`. Reads the cache and
 * falls back to the database; it never skips a check.
 */
export const societyMiddleware = (opts: SocietyOptions = {}): RequestHandler =>
  tag(
    async (req, _res, next) => {
      try {
        const ctx = req.ctx;
        if (!ctx.user || !ctx.session)
          return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue'));
        const societyId = ctx.session.activeSocietyId;
        if (!societyId) return next(new ForbiddenError('SOCIETY_NOT_SELECTED', 'Select a society first'));
        const society = await getSocietyInfo(societyId);
        if (!society) return next(new ForbiddenError('NOT_A_MEMBER', 'You are not a member of this society'));
        const write = !READ.has(req.method);
        if (society.status === 'CLOSED' && !opts.allowWhenClosed)
          return next(new AppError(423, 'SOCIETY_CLOSED', 'This society is closed'));
        if (society.status === 'SUSPENDED' && write && !opts.allowWhenSuspended)
          return next(
            new AppError(423, 'SOCIETY_SUSPENDED', 'This society is suspended. You can only view it.'),
          );

        const access = await computeAccess(societyId, ctx.user.id);
        if (access.status === 'SUSPENDED' || access.status === 'ENDED')
          return next(
            new ForbiddenError('MEMBERSHIP_INACTIVE', 'Your membership in this society is not active'),
          );

        if (access.status === 'ACTIVE') {
          ctx.society = society;
          ctx.membership = {
            id: access.memberId!,
            roleId: access.roleId!,
            roleKey: access.roleKey!,
            roleScope: access.roleScope!,
            status: 'ACTIVE',
            requiresMfa: access.requiresMfa,
          };
          ctx.permissions = new Set(access.permissions);
          ctx.unitLinks = access.unitLinks;
          ctx.unitIds = access.unitLinks.map(l => l.unitId);
          ctx.actorRoleKey = access.roleKey!;
          return next();
        }

        // no membership: a platform user acting under a support grant (BR-03-19)
        const grant =
          ctx.user.platformRoleId && ctx.session.supportGrantId
            ? await accessPorts().support.getActiveGrant(ctx.user.id, societyId)
            : null;
        if (!grant) return next(new ForbiddenError('NOT_A_MEMBER', 'You are not a member of this society'));
        if (grant.scope === 'READ_ONLY' && write)
          return next(
            new ForbiddenError(
              'SUPPORT_GRANT_READ_ONLY',
              'This support access is read only. Writes are blocked.',
            ),
          );
        ctx.society = society;
        ctx.supportGrant = grant;
        ctx.permissions = new Set(await supportPermissions(societyId, grant.scope));
        ctx.unitLinks = [];
        ctx.unitIds = [];
        ctx.actorRoleKey = 'support';
        next();
      } catch (err) {
        next(err);
      }
    },
    { kind: 'society', allowWhenClosed: opts.allowWhenClosed, allowWhenSuspended: opts.allowWhenSuspended },
  );

/** BR-03-18: platform routes need a platform role. Fills `ctx.platformPermissions` and `ctx.actorRoleKey`. */
export const platformMiddleware = (): RequestHandler =>
  tag(
    async (req, _res, next) => {
      try {
        const ctx = req.ctx;
        if (!ctx.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue'));
        const u = await User.findByPk(ctx.user.id, { attributes: ['id', 'platformRoleId'] });
        if (!u?.platformRoleId)
          return next(new ForbiddenError('PLATFORM_ACCESS_REQUIRED', 'Platform access is required'));
        ctx.platformPermissions = new Set(await getPlatformRoleKeys(u.platformRoleId));
        ctx.actorRoleKey = await platformRoleKey(u.platformRoleId);
        next();
      } catch (err) {
        next(err);
      }
    },
    { kind: 'platform' },
  );

async function platformRoleKey(roleId: number): Promise<string> {
  return (await Role.findByPk(roleId, { attributes: ['key'] }))?.key ?? 'platform';
}
