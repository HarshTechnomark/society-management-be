import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { FEATURE3 } from './residents.part3.constants';
import { permitController as pc } from './residents.renovations.controller';
import { permitSchemas as ps } from './residents.renovations.validation';
import { transferController as tc } from './residents.transfers.controller';
import { transferSchemas as ts } from './residents.transfers.validation';

/**
 * Module 09 part 3 routes (sections 8.16 and 8.17): renovation permits and ownership transfers, their resident-app (`/me`)
 * and gate variants. Order on a route: society marker, permission, entitlement, validate, step-up, idempotency. Mounted by
 * `residents.routes.ts` with one `use` line. No route is allow-listed for a suspended or closed society (BR-09-74).
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const P = FEATURE3.permits;
const T = FEATURE3.transfers;
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });

export const part3Routes = Router();
const r = part3Routes;
const edit = 'residents.requests.edit';

// ---- renovation permits (admin)
r.get(
  '/renovation-permits',
  society(),
  can('residents.requests.view'),
  feature(P, read),
  validate({ query: ps.list }),
  pc.list,
);
r.post(
  '/renovation-permits',
  society(),
  can('residents.requests.create'),
  feature(P),
  validate({ body: ps.create }),
  idempotency(),
  pc.create('ADMIN'),
);
r.get(
  '/renovation-permits/:id',
  society(),
  can('residents.requests.view'),
  feature(P, read),
  validate({ params: ps.idParam }),
  pc.get,
);
r.patch(
  '/renovation-permits/:id',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.patch }),
  pc.patch,
);
r.post(
  '/renovation-permits/:id/start',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.versionOnly }),
  pc.start,
);
r.post(
  '/renovation-permits/:id/extend',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.extend }),
  pc.extend,
);
r.post(
  '/renovation-permits/:id/violations',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.violation }),
  idempotency(),
  pc.violation,
);
r.post(
  '/renovation-permits/:id/suspend',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.suspend }),
  pc.suspend,
);
r.post(
  '/renovation-permits/:id/resume',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.resume }),
  pc.resume,
);
r.post(
  '/renovation-permits/:id/work-done',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.workDone }),
  pc.workDone('ADMIN'),
);
r.post(
  '/renovation-permits/:id/inspect',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.inspect }),
  idempotency(),
  pc.inspect,
);
r.post(
  '/renovation-permits/:id/cancel',
  society(),
  can(edit),
  feature(P),
  validate({ params: ps.idParam, body: ps.cancel }),
  pc.cancel('ADMIN'),
);

// ---- renovation permits (resident app and gate)
r.get(
  '/me/renovation-permits',
  society(),
  can('resident.requests.view'),
  feature(P, read),
  validate({ query: ps.list }),
  pc.listMine,
);
r.post(
  '/me/renovation-permits',
  society(),
  can('resident.requests.create'),
  feature(P),
  validate({ body: ps.create }),
  idempotency(),
  pc.create('RESIDENT'),
);
r.patch(
  '/me/renovation-permits/:id',
  society(),
  can('resident.requests.create'),
  feature(P),
  validate({ params: ps.idParam, body: ps.resubmit }),
  pc.resubmit,
);
r.post(
  '/me/renovation-permits/:id/work-done',
  society(),
  can('resident.requests.create'),
  feature(P),
  validate({ params: ps.idParam, body: ps.workDone }),
  pc.workDone('RESIDENT'),
);
r.post(
  '/me/renovation-permits/:id/cancel',
  society(),
  can('resident.requests.create'),
  feature(P),
  validate({ params: ps.idParam, body: ps.cancel }),
  pc.cancel('RESIDENT'),
);
r.get(
  '/gate/renovation-permits',
  society(),
  can('gate.visitors.view'),
  feature(P, read),
  validate({ query: ps.gate }),
  pc.gate,
);

// ---- ownership transfers (admin)
r.get(
  '/ownership-transfers',
  society(),
  can('residents.requests.view'),
  feature(T, read),
  validate({ query: ts.list }),
  tc.list,
);
r.post(
  '/ownership-transfers',
  society(),
  can('residents.requests.create'),
  feature(T),
  validate({ body: ts.create }),
  idempotency(),
  tc.create('ADMIN'),
);
r.get(
  '/ownership-transfers/:id',
  society(),
  can('residents.requests.view'),
  feature(T, read),
  validate({ params: ts.idParam }),
  tc.get,
);
r.patch(
  '/ownership-transfers/:id',
  society(),
  can(edit),
  feature(T),
  validate({ params: ts.idParam, body: ts.patch }),
  tc.patch('ADMIN'),
);
r.post(
  '/ownership-transfers/:id/submit',
  society(),
  can(edit),
  feature(T),
  validate({ params: ts.idParam, body: ts.versionOnly }),
  tc.submit('ADMIN'),
);
r.post(
  '/ownership-transfers/:id/complete',
  society(),
  can('residents.requests.approve'),
  feature(T),
  validate({ params: ts.idParam, body: ts.versionOnly }),
  stepUp(),
  idempotency(),
  tc.complete,
);
r.post(
  '/ownership-transfers/:id/cancel',
  society(),
  can(edit, 'residents.requests.approve'),
  feature(T),
  validate({ params: ts.idParam, body: ts.cancel }),
  tc.cancel('ADMIN'),
);

// ---- ownership transfers (resident app)
r.get(
  '/me/ownership-transfers',
  society(),
  can('resident.requests.view'),
  feature(T, read),
  validate({ query: ts.list }),
  tc.listMine,
);
r.post(
  '/me/ownership-transfers',
  society(),
  can('resident.requests.create'),
  feature(T),
  validate({ body: ts.create }),
  idempotency(),
  tc.create('RESIDENT'),
);
r.patch(
  '/me/ownership-transfers/:id',
  society(),
  can('resident.requests.create'),
  feature(T),
  validate({ params: ts.idParam, body: ts.patch }),
  tc.patch('RESIDENT'),
);
r.post(
  '/me/ownership-transfers/:id/submit',
  society(),
  can('resident.requests.create'),
  feature(T),
  validate({ params: ts.idParam, body: ts.versionOnly }),
  tc.submit('RESIDENT'),
);
r.post(
  '/me/ownership-transfers/:id/cancel',
  society(),
  can('resident.requests.create'),
  feature(T),
  validate({ params: ts.idParam, body: ts.cancel }),
  tc.cancel('RESIDENT'),
);
