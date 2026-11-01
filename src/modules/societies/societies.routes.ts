import { Router, type Request, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { platformMiddleware, societyMiddleware } from '../../middlewares/society.middleware';
import {
  anyActiveMember,
  publicRoute,
  requirePermission as can,
  requirePlatformPermission as canPlatform,
} from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { findToken } from '../auth/auth.links';
import { societiesController as c } from './societies.controller';
import { societySchemas as s } from './societies.validation';
import { routeMeta } from './societies.guard';

/**
 * Module 05 routes (section 8.0). Order on a route: routeMeta (state policy), society or platform marker, permission,
 * validate, step-up, idempotency, controller. Fixed paths (`/export`, `/slug-availability`, `/current`, `/settings`) are
 * registered before `/:id`.
 */
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const stepUpWhen = (pred: (req: Request) => boolean): RequestHandler => {
  const inner = requireRecentAuth();
  return tag((req, res, next) => (pred(req) ? inner(req, res, next) : next()), { stepUp: true });
};
const platform = () => platformMiddleware();
const society = () => societyMiddleware();
const perUser = (name: string, limit: number, windowSeconds: number) =>
  rateLimit({ name, limit, windowSeconds, key: req => String(req.ctx.user?.id) });
/** Society routes a support grant holder must never call (6.4). */
const noSupport = () => routeMeta({ noSupportAccess: true });

export const societiesRoutes = Router();
const r = societiesRoutes;

// ---- public sign-up (8.1): 5 per hour per IP; 3 per day per mobile is checked in the service
r.post(
  '/public/signups',
  publicRoute(),
  rateLimit({ name: 'signup-ip', limit: 5, windowSeconds: 3600, key: req => req.ip ?? 'unknown' }),
  validate({ body: s.signup }),
  idempotency({
    publicScope: async req => {
      const t = await findToken(String(req.valid.body.signupToken), 'SIGNUP');
      const mobile = t?.payload?.mobile;
      return typeof mobile === 'string' ? mobile : null;
    },
  }),
  c.signup,
);

// ---- platform societies (8.2 to 8.15)
r.get(
  '/platform/societies',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ query: s.list }),
  c.list,
);
r.get(
  '/platform/societies/export',
  platform(),
  canPlatform('platform.societies.export'),
  validate({ query: s.exportList }),
  perUser('societies-list-export', 10, 3600),
  c.exportList,
);
r.get(
  '/platform/societies/slug-availability',
  platform(),
  canPlatform('platform.societies.create'),
  validate({ query: s.slugQuery }),
  c.slugAvailability,
);
r.post(
  '/platform/societies',
  platform(),
  canPlatform('platform.societies.create'),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.get(
  '/platform/societies/:id',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.idParam }),
  c.detail,
);
r.patch(
  '/platform/societies/:id',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.idParam, body: s.update }),
  c.update,
);
r.get(
  '/platform/societies/:id/lifecycle-events',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.idParam, query: s.events }),
  c.events,
);
r.post(
  '/platform/societies/:id/extend-trial',
  platform(),
  canPlatform('platform.societies.approve'),
  validate({ params: s.idParam, body: s.extendTrial }),
  c.extendTrial,
);
r.post(
  '/platform/societies/:id/convert',
  platform(),
  canPlatform('platform.societies.approve'),
  validate({ params: s.idParam, body: s.convert }),
  stepUp(),
  idempotency(),
  c.convert,
);
r.post(
  '/platform/societies/:id/suspend',
  platform(),
  canPlatform('platform.societies.approve'),
  validate({ params: s.idParam, body: s.suspend }),
  stepUp(),
  c.suspend,
);
r.post(
  '/platform/societies/:id/reactivate',
  platform(),
  canPlatform('platform.societies.approve'),
  validate({ params: s.idParam, body: s.reactivate }),
  stepUp(),
  c.reactivate,
);
r.post(
  '/platform/societies/:id/close',
  platform(),
  canPlatform('platform.societies.delete'),
  validate({ params: s.idParam, body: s.close }),
  stepUp(),
  c.close,
);
r.post(
  '/platform/societies/:id/reopen',
  platform(),
  canPlatform('platform.societies.approve'),
  validate({ params: s.idParam, body: s.reopen }),
  stepUp(),
  idempotency(),
  c.reopen,
);
r.put(
  '/platform/societies/:id/purge-hold',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.idParam, body: s.purgeHold }),
  stepUp(),
  c.setPurgeHold,
);
r.delete(
  '/platform/societies/:id/purge-hold',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.idParam, body: s.purgeHold }),
  stepUp(),
  c.clearPurgeHold,
);
r.post(
  '/platform/societies/:id/nudge',
  platform(),
  canPlatform('platform.societies.edit', 'platform.tickets.edit'),
  validate({ params: s.idParam, body: s.nudge }),
  c.nudge,
);

// ---- notes (8.16)
r.get(
  '/platform/societies/:id/notes',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.idParam, query: s.notesQuery }),
  c.listNotes,
);
r.post(
  '/platform/societies/:id/notes',
  platform(),
  canPlatform('platform.societies.edit', 'platform.tickets.edit'),
  validate({ params: s.idParam, body: s.createNote }),
  idempotency(),
  c.createNote,
);
r.patch(
  '/platform/societies/:id/notes/:noteId',
  platform(),
  canPlatform('platform.societies.edit', 'platform.tickets.edit'),
  validate({ params: s.noteParam, body: s.updateNote }),
  c.updateNote,
);
r.delete(
  '/platform/societies/:id/notes/:noteId',
  platform(),
  canPlatform('platform.societies.edit', 'platform.tickets.edit'),
  validate({ params: s.noteParam }),
  c.deleteNote,
);

// ---- platform data exports (8.17)
r.get(
  '/platform/societies/:id/data-exports',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.idParam, query: s.exportsQuery }),
  c.platformExports,
);
r.post(
  '/platform/societies/:id/data-exports',
  platform(),
  canPlatform('platform.societies.export'),
  validate({ params: s.idParam, body: s.platformExport }),
  idempotency(),
  c.platformCreateExport,
);

// ---- platform support access (8.18 to 8.21)
r.get(
  '/platform/support-access',
  platform(),
  canPlatform('platform.support_access.view'),
  validate({ query: s.grantsQuery }),
  c.listGrants,
);
r.get(
  '/platform/support-access/current',
  platform(),
  canPlatform('platform.support_access.create'),
  c.currentGrant,
);
r.get(
  '/platform/support-access/:id',
  platform(),
  canPlatform('platform.support_access.view'),
  validate({ params: s.idParam }),
  c.getGrant,
);
r.post(
  '/platform/support-access',
  platform(),
  canPlatform('platform.support_access.create'),
  validate({ body: s.requestGrant }),
  stepUpWhen(req => req.valid.body.scope === 'READ_WRITE' || req.valid.body.isEmergency === true),
  idempotency(),
  c.requestGrant,
);
r.post(
  '/platform/support-access/:id/end',
  platform(),
  canPlatform('platform.support_access.create'),
  validate({ params: s.idParam, body: s.empty }),
  c.endGrant,
);
r.post(
  '/platform/support-access/:id/cancel',
  platform(),
  canPlatform('platform.support_access.create'),
  validate({ params: s.idParam, body: s.empty }),
  c.cancelGrant,
);
r.post(
  '/platform/support-access/:id/revoke',
  platform(),
  canPlatform('platform.support_access.approve'),
  validate({ params: s.idParam, body: s.revokeGrant }),
  c.revokeGrantPlatform,
);

// ---- society status (8.22): every status, any active member or support grant holder
r.get('/society-status', routeMeta({ closed: 'allow' }), society(), anyActiveMember(), c.societyStatus);

// ---- society support access (8.23): never through a support session
r.get(
  '/support-access',
  noSupport(),
  society(),
  can('settings.support_access.view'),
  validate({ query: s.societyGrantsQuery }),
  c.societyGrants,
);
r.get(
  '/support-access/settings',
  noSupport(),
  society(),
  can('settings.support_access.view'),
  c.consentSetting,
);
r.patch(
  '/support-access/settings',
  noSupport(),
  society(),
  can('settings.support_access.approve'),
  validate({ body: s.consentSetting }),
  stepUp(),
  c.setConsentSetting,
);
r.get(
  '/support-access/:id',
  noSupport(),
  society(),
  can('settings.support_access.view'),
  validate({ params: s.idParam }),
  c.societyGrant,
);
r.post(
  '/support-access/:id/approve',
  routeMeta({ suspended: 'allow', noSupportAccess: true }),
  society(),
  can('settings.support_access.approve'),
  validate({ params: s.idParam, body: s.approveGrant }),
  stepUp(),
  c.approveGrant,
);
r.post(
  '/support-access/:id/deny',
  routeMeta({ suspended: 'allow', noSupportAccess: true }),
  society(),
  can('settings.support_access.approve'),
  validate({ params: s.idParam, body: s.denyGrant }),
  c.denyGrant,
);
r.post(
  '/support-access/:id/revoke',
  routeMeta({ suspended: 'allow', noSupportAccess: true }),
  society(),
  can('settings.support_access.approve'),
  validate({ params: s.idParam, body: s.revokeGrant }),
  stepUp(),
  c.revokeGrantSociety,
);

// ---- society data exports (8.24)
r.get(
  '/data-exports',
  routeMeta({ closed: 'allow', noSupportAccess: true }),
  society(),
  can('settings.data_export.view'),
  validate({ query: s.exportsQuery }),
  c.societyExports,
);
r.post(
  '/data-exports',
  routeMeta({ suspended: 'allow', noSupportAccess: true }),
  society(),
  can('settings.data_export.create'),
  validate({ body: s.societyExport }),
  stepUp(),
  idempotency(),
  c.societyCreateExport,
);
r.get(
  '/data-exports/:id',
  routeMeta({ closed: 'allow', noSupportAccess: true }),
  society(),
  can('settings.data_export.view'),
  validate({ params: s.idParam }),
  c.societyExport,
);
r.get(
  '/data-exports/:id/download-url',
  routeMeta({ closed: 'allow', noSupportAccess: true }),
  society(),
  can('settings.data_export.view'),
  validate({ params: s.idParam, query: s.downloadQuery }),
  stepUp(),
  c.downloadUrl,
);
