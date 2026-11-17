import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { tag } from '../access-control/access-control.registry';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './accounts.constants';
import { bankController as c } from './accounts.bank.controller';
import { bankSchemas as s } from './accounts.bank.validation';

/**
 * 13.2 bank account routes (section 8.14). Order on a route: society marker, permission, entitlement, validate, step-up,
 * idempotency (create only). Reads use the plan's read grace.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const revealLimit = rateLimit({
  name: 'bank-reveal',
  limit: 10,
  windowSeconds: 3600,
  key: req => (req.ctx.user ? String(req.ctx.user.id) : null),
});

export const accountsBankRoutes = Router();
const r = accountsBankRoutes;

r.get(
  '/accounts/bank-accounts',
  society(),
  can(PERM.bankView),
  feature(ENT.cashBook, read),
  validate({ query: s.list }),
  c.list,
);
r.post(
  '/accounts/bank-accounts',
  society(),
  can(PERM.bankEdit),
  feature(ENT.cashBook),
  validate({ body: s.create }),
  stepUp(),
  idempotency(),
  c.create,
);
r.get(
  '/accounts/bank-accounts/:id',
  society(),
  can(PERM.bankView),
  feature(ENT.cashBook, read),
  validate({ params: s.idParam }),
  c.get,
);
r.patch(
  '/accounts/bank-accounts/:id',
  society(),
  can(PERM.bankEdit),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.patch }),
  stepUp(),
  c.patch,
);
r.post(
  '/accounts/bank-accounts/:id/verify',
  society(),
  can(PERM.bankApprove),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.versionBody }),
  c.verify,
);
r.post(
  '/accounts/bank-accounts/:id/set-collection',
  society(),
  can(PERM.bankApprove),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.versionBody }),
  stepUp(),
  c.setCollection,
);
r.post(
  '/accounts/bank-accounts/:id/close',
  society(),
  can(PERM.bankApprove),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.close }),
  stepUp(),
  c.close,
);
r.get(
  '/accounts/bank-accounts/:id/reveal',
  routeMeta({ noSupportAccess: true }),
  society(),
  can(PERM.bankEdit),
  feature(ENT.cashBook, read),
  validate({ params: s.idParam }),
  stepUp(),
  revealLimit,
  c.reveal,
);
