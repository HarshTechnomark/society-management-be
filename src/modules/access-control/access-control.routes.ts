import { Router, type Request, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { platformMiddleware, societyMiddleware } from '../../middlewares/society.middleware';
import {
  authenticatedOnly,
  publicRoute,
  requirePermission as can,
  requirePlatformPermission as canPlatform,
} from '../../middlewares/permission.middleware';
import { accessController as c } from './access-control.controller';
import { accessSchemas as s } from './access-control.validation';
import { tag } from './access-control.registry';

/** Step-up (`401 REAUTH_REQUIRED`), tagged so the registry knows the route needs it. */
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
/** Step-up only when the request changes a role (PATCH /members/:id with `roleId`). */
const stepUpWhen = (pred: (req: Request) => boolean): RequestHandler => {
  const inner = requireRecentAuth();
  return tag((req, res, next) => (pred(req) ? inner(req, res, next) : next()), { stepUp: true });
};

const society = () => societyMiddleware();
const platform = () => platformMiddleware();
const ip = (req: Request) => req.ip ?? 'unknown';

/**
 * Every route declares a marker (`societyMiddleware` + `requirePermission`, `platformMiddleware` +
 * `requirePlatformPermission`, `publicRoute` or `authenticatedOnly`); `listRoutes()` reads them for the permission matrix and
 * tenant isolation tests. Order on a route: society, permission, validate, step-up, idempotency, controller.
 */
export const accessControlRoutes = Router();
const r = accessControlRoutes;

// ---- catalogue and roles (8.1 to 8.6)
r.get(
  '/permissions',
  society(),
  can('settings.roles.view'),
  validate({ query: s.catalogueQuery }),
  c.permissions,
);
r.get(
  '/roles',
  society(),
  can('settings.roles.view', 'settings.members.view'),
  validate({ query: s.rolesQuery }),
  c.listRoles,
);
r.get(
  '/roles/:id',
  society(),
  can('settings.roles.view', 'settings.members.view'),
  validate({ params: s.idParam }),
  c.getRole,
);
r.post(
  '/roles',
  society(),
  can('settings.roles.create'),
  validate({ body: s.createRole }),
  idempotency(),
  c.createRole,
);
r.patch(
  '/roles/:id',
  society(),
  can('settings.roles.edit'),
  validate({ params: s.idParam, body: s.updateRole }),
  stepUp(),
  c.updateRole,
);
r.post(
  '/roles/:id/reset',
  society(),
  can('settings.roles.edit'),
  validate({ params: s.idParam, body: s.versionReason }),
  stepUp(),
  c.resetRole,
);
r.delete(
  '/roles/:id',
  society(),
  can('settings.roles.delete'),
  validate({ params: s.idParam, body: s.versionReason }),
  stepUp(),
  c.deleteRole,
);

// ---- members (8.7 to 8.12a)
r.get(
  '/members',
  society(),
  can('settings.members.view'),
  validate({ query: s.membersQuery }),
  c.listMembers,
);
r.get(
  '/members/export',
  society(),
  can('settings.members.export'),
  validate({ query: s.exportQuery }),
  rateLimit({ name: 'members-export', limit: 10, windowSeconds: 3600, key: req => String(req.ctx.user?.id) }),
  c.exportMembers,
);
r.get('/members/:id', society(), can('settings.members.view'), validate({ params: s.idParam }), c.getMember);
r.post(
  '/members/invite',
  society(),
  can('settings.members.create'),
  validate({ body: s.invite }),
  rateLimit({
    name: 'members-invite',
    limit: 50,
    windowSeconds: 3600,
    key: req => String(req.ctx.society?.id),
  }),
  idempotency(),
  c.invite,
);
r.patch(
  '/members/:id',
  society(),
  can('settings.members.edit'),
  validate({ params: s.idParam, body: s.patchMember }),
  stepUpWhen(req => req.valid.body?.roleId !== undefined),
  c.patchMember,
);
r.post(
  '/members/:id/suspend',
  society(),
  can('settings.members.edit'),
  validate({ params: s.idParam, body: s.versionReason }),
  stepUp(),
  c.suspend,
);
r.post(
  '/members/:id/reactivate',
  society(),
  can('settings.members.edit'),
  validate({ params: s.idParam, body: s.versionReason }),
  c.reactivate,
);
r.delete(
  '/members/:id',
  society(),
  can('settings.members.delete'),
  validate({ params: s.idParam, body: s.versionReason }),
  stepUp(),
  c.endMember,
);
r.post(
  '/members/:id/reset-mfa',
  society(),
  can('settings.members.edit'),
  validate({ params: s.idParam, body: s.reasonOnly }),
  stepUp(),
  c.resetMfa,
);
r.post(
  '/members/:id/revoke-sessions',
  society(),
  can('settings.members.edit'),
  validate({ params: s.idParam, body: s.reasonOnly }),
  stepUp(),
  c.revokeSessions,
);

// ---- admin grants (8.15)
r.get(
  '/members/:id/grants',
  society(),
  can('settings.members.view'),
  validate({ params: s.idParam, query: s.grantsQuery }),
  c.listGrants,
);
r.post(
  '/members/:id/grants',
  society(),
  can('settings.members.edit'),
  validate({ params: s.idParam, body: s.createGrant }),
  stepUp(),
  idempotency(),
  c.createGrant,
);
r.delete(
  '/members/:id/grants/:grantId',
  society(),
  can('settings.members.edit'),
  validate({ params: s.memberGrantParams, body: s.revokeGrant }),
  c.revokeGrant,
);

// ---- invitations (8.13, 8.14, 8.16, 8.17)
r.get(
  '/invitations',
  society(),
  can('settings.members.view'),
  validate({ query: s.invitationsQuery }),
  c.listInvitations,
);
r.post(
  '/invitations/:id/resend',
  society(),
  can('settings.members.create'),
  validate({ params: s.idParam, body: s.emptyBody }),
  idempotency(),
  c.resend,
);
r.post(
  '/invitations/:id/revoke',
  society(),
  can('settings.members.create'),
  validate({ params: s.idParam, body: s.reasonOnly }),
  c.revoke,
);
r.get(
  '/public/invitations/:token',
  publicRoute(),
  rateLimit({ name: 'invitation-public', limit: 30, windowSeconds: 60, key: ip }),
  validate({ params: s.tokenParam }),
  c.preview,
);
r.post(
  '/public/invitations/:token/decline',
  publicRoute(),
  rateLimit({ name: 'invitation-public', limit: 30, windowSeconds: 60, key: ip }),
  validate({ params: s.tokenParam, body: s.decline }),
  c.decline,
);
r.post(
  '/invitations/:token/accept',
  authenticatedOnly(),
  validate({ params: s.tokenParam, body: s.emptyBody }),
  idempotency(),
  c.accept,
);

// ---- household (8.18)
r.get(
  '/me/household/:memberId/grants',
  society(),
  can('resident.household.view'),
  validate({ params: s.householdParams }),
  c.householdGet,
);
r.patch(
  '/me/household/:memberId/grants',
  society(),
  can('resident.household.edit'),
  validate({ params: s.householdParams, body: s.householdPatch }),
  c.householdSet,
);

// ---- platform (8.19, 8.20)
r.get('/platform/permissions', platform(), canPlatform('platform.team.view'), c.platformPermissions);
r.get('/platform/roles', platform(), canPlatform('platform.team.view'), c.platformRoles);
r.get(
  '/platform/team',
  platform(),
  canPlatform('platform.team.view'),
  validate({ query: s.teamQuery }),
  c.platformTeam,
);
r.post(
  '/platform/team/invite',
  platform(),
  canPlatform('platform.team.create'),
  validate({ body: s.platformInvite }),
  stepUp(),
  idempotency(),
  c.platformInvite,
);
r.post(
  '/platform/invitations/:id/resend',
  platform(),
  canPlatform('platform.team.create'),
  validate({ params: s.idParam, body: s.emptyBody }),
  stepUp(),
  idempotency(),
  c.platformResend,
);
r.post(
  '/platform/invitations/:id/revoke',
  platform(),
  canPlatform('platform.team.create'),
  validate({ params: s.idParam, body: s.reasonOnly }),
  stepUp(),
  c.platformRevoke,
);
r.patch(
  '/platform/team/:userId',
  platform(),
  canPlatform('platform.team.edit'),
  validate({ params: s.userIdParam, body: s.platformChangeRole }),
  stepUp(),
  c.platformChangeRole,
);
r.post(
  '/platform/team/:userId/disable',
  platform(),
  canPlatform('platform.team.edit'),
  validate({ params: s.userIdParam, body: s.reasonOnly }),
  stepUp(),
  c.platformDisable,
);
r.post(
  '/platform/team/:userId/enable',
  platform(),
  canPlatform('platform.team.edit'),
  validate({ params: s.userIdParam, body: s.reasonOnly }),
  stepUp(),
  c.platformEnable,
);
r.post(
  '/platform/team/:userId/reset-mfa',
  platform(),
  canPlatform('platform.team.edit'),
  validate({ params: s.userIdParam, body: s.reasonOnly }),
  stepUp(),
  c.platformResetMfa,
);
r.delete(
  '/platform/team/:userId',
  platform(),
  canPlatform('platform.team.delete'),
  validate({ params: s.userIdParam, body: s.reasonOnly }),
  stepUp(),
  c.platformRemove,
);
r.get(
  '/platform/societies/:id/roles',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.platformSocietyParams, query: s.rolesQuery }),
  c.platformSocietyRoles,
);
r.get(
  '/platform/societies/:id/members',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.platformSocietyParams, query: s.membersQuery }),
  c.platformSocietyMembers,
);
r.patch(
  '/platform/societies/:id/roles/:roleId',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.platformRoleParams, body: s.platformEditRole }),
  stepUp(),
  c.platformEditRole,
);
r.post(
  '/platform/societies/:id/members/:memberId/reset-mfa',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.platformMemberParams, body: s.platformReasonLong }),
  stepUp(),
  c.platformSocietyResetMfa,
);
