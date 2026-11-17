import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { tag } from '../access-control/access-control.registry';
import { ENT, PERM } from './accounts.constants';
import { depositController as c } from './accounts.deposits.controller';
import { depositSchemas as s } from './accounts.deposits.validation';

/** Section 8.17 routes (52 to 59). Order on a route: society marker, permission, entitlement, validate, step-up, idempotency. */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });

export const accountsDepositsRoutes = Router();
const r = accountsDepositsRoutes;

r.get(
  '/accounts/deposits',
  society(),
  can(PERM.accountsView),
  feature(ENT.deposits, read),
  validate({ query: s.list }),
  c.list,
);
r.get(
  '/accounts/deposits/summary',
  society(),
  can(PERM.accountsView),
  feature(ENT.deposits, read),
  c.summary,
);
r.get(
  '/accounts/deposits/:id',
  society(),
  can(PERM.accountsView),
  feature(ENT.deposits, read),
  validate({ params: s.idParam }),
  c.get,
);
r.post(
  '/accounts/deposits',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.deposits),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.post(
  '/accounts/deposits/:id/deduct',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.deposits),
  validate({ params: s.idParam, body: s.deduct }),
  idempotency(),
  c.deduct,
);
r.post(
  '/accounts/deposits/:id/forfeit',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.deposits),
  validate({ params: s.idParam, body: s.forfeit }),
  idempotency(),
  c.forfeit,
);
r.post(
  '/accounts/deposits/:id/refund-request',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.deposits),
  validate({ params: s.idParam, body: s.refundRequest }),
  idempotency(),
  c.refundRequest,
);
r.post(
  '/accounts/deposits/:id/refund-paid',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.deposits),
  validate({ params: s.idParam, body: s.refundPaid }),
  stepUp(),
  idempotency(),
  c.refundPaid,
);
r.post(
  '/accounts/deposits/:id/cancel',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.deposits),
  validate({ params: s.idParam, body: s.cancel }),
  c.cancel,
);
r.get('/me/deposits', society(), can(PERM.residentDuesView), feature(ENT.deposits, read), c.mine);
