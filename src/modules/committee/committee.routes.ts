import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { committeeController as c } from './committee.controller';
import { committeeSchemas as s } from './committee.validation';
import { FEATURE as F } from './committee.constants';

/**
 * Module 10 routes, sub-module 10.1 (section 8.1 to 8.6): the committee overview, terms and seats. Order on a route: society
 * marker, permission, entitlement, validate, idempotency. Reads use the plan's read grace. `governance.office_bearers` is
 * checked in the service (only a seat other than MEMBER needs it), so a MEMBER-only draft works without it. The data-dependent
 * step-up of PATCH (end date or strength of a current term) is checked in the service too. Activation, changes, hand-over,
 * seat usage and the `/me` routes come with 10.2 and 10.3 and mount on this router.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

export const committeeRoutes = Router();
const r = committeeRoutes;

r.get('/committee', society(), can('settings.members.view'), feature(F.terms, read), c.overview);
r.get(
  '/committee/terms',
  society(),
  can('settings.members.view'),
  feature(F.terms, read),
  validate({ query: s.termList }),
  c.list,
);
r.post(
  '/committee/terms',
  society(),
  can('settings.members.create'),
  feature(F.terms),
  validate({ body: s.termCreate }),
  idempotency(),
  c.create,
);
r.get(
  '/committee/terms/:id',
  society(),
  can('settings.members.view'),
  feature(F.terms, read),
  validate({ params: s.idParam }),
  c.get,
);
r.patch(
  '/committee/terms/:id',
  society(),
  can('settings.members.edit'),
  feature(F.terms),
  validate({ params: s.idParam, body: s.termPatch }),
  c.update,
);
r.delete(
  '/committee/terms/:id',
  society(),
  can('settings.members.delete'),
  feature(F.terms),
  validate({ params: s.idParam, body: s.termDelete }),
  c.remove,
);
r.patch(
  '/committee/terms/:id/seats/:seatId',
  society(),
  can('settings.members.edit'),
  feature(F.terms),
  validate({ params: s.seatParam, body: s.seatPatch }),
  c.patchSeat,
);
