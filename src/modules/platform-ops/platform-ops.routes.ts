import { Router, type Request, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { platformMiddleware, societyMiddleware } from '../../middlewares/society.middleware';
import {
  requirePermission as can,
  requirePlatformPermission as canPlatform,
} from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { routeMeta } from '../societies/societies.guard';
import { platformOpsController as c } from './platform-ops.controller';
import { opsSchemas as s } from './platform-ops.validation';
import { isSettingKey, settingDef } from './platform-ops.settings-registry';
import { operationsRoutes } from './platform-ops.operations.routes';

/**
 * Module 07 routes, part 1: support tickets (8.3, 8.4), settings (8.10) and organizations (8.12). Order on a route:
 * state policy, society or platform marker, permission, validate, step-up, idempotency, controller. The platform IP
 * allowlist (BR-07-43) is mounted for the whole `/platform` prefix in `app.ts`.
 */
const platform = () => platformMiddleware();
const society = () => societyMiddleware();
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const stepUpWhen = (pred: (req: Request) => boolean): RequestHandler => {
  const inner = requireRecentAuth();
  return tag((req, res, next) => (pred(req) ? inner(req, res, next) : next()), { stepUp: true });
};
/** Support routes work for a suspended society too, so it can ask for reactivation (BR-07-18). */
const supportRoute = () => routeMeta({ suspended: 'allow' });

export const platformOpsRoutes = Router();
const r = platformOpsRoutes;
r.use(operationsRoutes); // part 2 (8.2, 8.5 to 8.9)

// ---- 8.3 platform support tickets
r.get(
  '/platform/tickets',
  platform(),
  canPlatform('platform.tickets.view'),
  validate({ query: s.ticketList }),
  c.listTickets,
);
r.get(
  '/platform/tickets/:id',
  platform(),
  canPlatform('platform.tickets.view'),
  validate({ params: s.idParam }),
  c.getTicket,
);
r.post(
  '/platform/tickets',
  platform(),
  canPlatform('platform.tickets.create'),
  validate({ body: s.platformTicketCreate }),
  idempotency(),
  c.createTicket,
);
r.patch(
  '/platform/tickets/:id',
  platform(),
  canPlatform('platform.tickets.edit'),
  validate({ params: s.idParam, body: s.ticketPatch }),
  c.patchTicket,
);
r.post(
  '/platform/tickets/:id/messages',
  platform(),
  canPlatform('platform.tickets.edit'),
  validate({ params: s.idParam, body: s.platformMessage }),
  idempotency(),
  c.platformMessage,
);

// ---- 8.4 society support tickets
r.get(
  '/support-tickets',
  supportRoute(),
  society(),
  can('settings.support.view'),
  validate({ query: s.societyTicketList }),
  c.listSocietyTickets,
);
r.post(
  '/support-tickets',
  supportRoute(),
  society(),
  can('settings.support.create'),
  validate({ body: s.societyTicketCreate }),
  idempotency(),
  c.createSocietyTicket,
);
r.get(
  '/support-tickets/:id',
  supportRoute(),
  society(),
  can('settings.support.view'),
  validate({ params: s.idParam }),
  c.getSocietyTicket,
);
r.post(
  '/support-tickets/:id/messages',
  supportRoute(),
  society(),
  can('settings.support.create'),
  validate({ params: s.idParam, body: s.societyMessage }),
  idempotency(),
  c.societyMessage,
);
r.post(
  '/support-tickets/:id/reopen',
  supportRoute(),
  society(),
  can('settings.support.create'),
  validate({ params: s.idParam, body: s.reopen }),
  c.reopen,
);
r.post(
  '/support-tickets/:id/close',
  supportRoute(),
  society(),
  can('settings.support.create'),
  validate({ params: s.idParam, body: s.close }),
  c.close,
);
r.post(
  '/support-tickets/:id/rating',
  supportRoute(),
  society(),
  can('settings.support.create'),
  validate({ params: s.idParam, body: s.rating }),
  c.rate,
);

// ---- 8.10 settings
r.get('/platform/settings', platform(), canPlatform('platform.settings.view'), c.listSettings);
r.patch(
  '/platform/settings',
  platform(),
  canPlatform('platform.settings.edit'),
  validate({ body: s.settingsPatch }),
  stepUpWhen(req =>
    ((req.valid.body?.changes ?? []) as { key: string }[]).some(
      ch => isSettingKey(ch.key) && settingDef(ch.key).category === 'SECURITY',
    ),
  ),
  c.patchSettings,
);

// ---- 8.12 organizations
r.get(
  '/platform/organizations',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ query: s.organizationList }),
  c.listOrganizations,
);
r.get(
  '/platform/organizations/:id',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.idParam }),
  c.getOrganization,
);
r.post(
  '/platform/organizations',
  platform(),
  canPlatform('platform.societies.create'),
  validate({ body: s.organizationCreate }),
  idempotency(),
  c.createOrganization,
);
r.patch(
  '/platform/organizations/:id',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.idParam, body: s.organizationUpdate }),
  c.updateOrganization,
);
r.post(
  '/platform/organizations/:id/status',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.idParam, body: s.organizationStatus }),
  stepUp(),
  c.organizationStatus,
);
