import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { tag } from '../access-control/access-control.registry';
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
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });

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

// 10.2 (8.7 to 8.9): activation and mid-term changes. Order: society marker, permission, both entitlements, validate, step-up
// (activate and changes only), idempotency (the same two).
r.get(
  '/committee/terms/:id/activation-preview',
  society(),
  can('settings.members.edit'),
  feature(F.terms),
  feature(F.officeBearers),
  validate({ params: s.idParam }),
  c.activationPreview,
);
r.post(
  '/committee/terms/:id/activate',
  society(),
  can('settings.members.edit'),
  feature(F.terms),
  feature(F.officeBearers),
  validate({ params: s.idParam, body: s.activate }),
  stepUp(),
  idempotency(),
  c.activate,
);
r.post(
  '/committee/terms/:id/changes/preview',
  society(),
  can('settings.members.edit'),
  feature(F.terms),
  feature(F.officeBearers),
  validate({ params: s.idParam, body: s.changesPreview }),
  c.changesPreview,
);
r.post(
  '/committee/terms/:id/changes',
  society(),
  can('settings.members.edit'),
  feature(F.terms),
  feature(F.officeBearers),
  validate({ params: s.idParam, body: s.changesApply }),
  stepUp(),
  idempotency(),
  c.applyChanges,
);
