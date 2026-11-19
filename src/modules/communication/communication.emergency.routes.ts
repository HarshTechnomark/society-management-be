import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { anyActiveMember, requirePermission as can } from '../../middlewares/permission.middleware';
import { routeMeta } from '../societies/societies.guard';
import { PERM } from './communication.constants';
import { emergencyController as c } from './communication.emergency.controller';
import { emergencySchemas as s } from './communication.emergency.validation';

/**
 * Part 16.3 emergency routes (8.25 to 8.30). Emergency is never plan-gated (BR-16-37). Every write is open while the society is SUSPENDED (module 05 allow-list);
 * CLOSED is refused by the state guard. Order on a route: routeMeta, society marker, permission, validate, rate limit, idempotency.
 */
export const emergencyRoutes = Router();
const r = emergencyRoutes;
const society = () => societyMiddleware();
const open = () => routeMeta({ suspended: 'allow' });
const viewers = [PERM.emergencyCreate, PERM.incidentsView];

r.post(
  '/emergency-broadcasts',
  open(),
  society(),
  can(PERM.emergencyCreate),
  validate({ body: s.start }),
  rateLimit({
    name: 'emergency-start',
    limit: 5,
    windowSeconds: 3600,
    key: req => (req.valid?.body?.isDrill ? null : String(req.ctx.user?.id)),
  }),
  rateLimit({
    name: 'emergency-drill',
    limit: 10,
    windowSeconds: 86_400,
    key: req => (req.valid?.body?.isDrill ? String(req.ctx.society?.id) : null),
  }),
  idempotency(),
  c.start,
);
r.get('/emergency-broadcasts', society(), can(...viewers), validate({ query: s.list }), c.list);
r.get('/emergency-broadcasts/:id', society(), can(...viewers), validate({ params: s.idParam }), c.detail);
r.get(
  '/emergency-broadcasts/:id/roll-call',
  society(),
  can(...viewers),
  validate({ params: s.idParam, query: s.rollCall }),
  c.rollCall(false),
);
for (const [path, schema, fn] of [
  ['updates', s.update, c.update],
  ['realert', s.realert, c.realert],
  ['resolve', s.resolve, c.resolve],
  ['cancel', s.cancel, c.cancel],
] as const)
  r.post(
    `/emergency-broadcasts/:id/${path}`,
    open(),
    society(),
    can(PERM.emergencyCreate),
    validate({ params: s.idParam, body: schema }),
    fn,
  );
r.post(
  '/emergency-broadcasts/:id/responses',
  open(),
  society(),
  anyActiveMember(),
  validate({ params: s.idParam, body: s.response }),
  idempotency(),
  c.respond('APP'),
);
r.post(
  '/emergency-broadcasts/:id/responses/:responseId/attend',
  open(),
  society(),
  can(PERM.emergencyCreate),
  validate({ params: s.attendParam, body: s.attend }),
  c.attend,
);
r.get('/me/emergency-broadcasts/active', society(), anyActiveMember(), c.active('me'));
r.get('/gate/emergency-broadcasts/active', society(), can(PERM.gateSosCreate), c.active('gate'));
r.get(
  '/gate/emergency-broadcasts/:id/roll-call',
  society(),
  can(PERM.gateSosCreate),
  validate({ params: s.idParam, query: s.rollCall }),
  c.rollCall(true),
);
r.post(
  '/gate/emergency-broadcasts/:id/responses',
  open(),
  society(),
  can(PERM.gateSosCreate),
  validate({ params: s.idParam, body: s.response }),
  idempotency(),
  c.respond('GATE'),
);
