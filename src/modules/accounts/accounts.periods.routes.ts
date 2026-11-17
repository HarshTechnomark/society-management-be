import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { tag } from '../access-control/access-control.registry';
import { ENT, PERM } from './accounts.constants';
import { periodController as c } from './accounts.periods.controller';
import { periodSchemas as s } from './accounts.periods.validation';

/** Section 8.18 routes (60 to 64). Order on a route: society marker, permission, entitlement, validate, step-up, idempotency. */
const society = () => societyMiddleware();
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });

export const accountsPeriodsRoutes = Router();
const r = accountsPeriodsRoutes;

r.get('/accounts/periods', society(), can(PERM.accountsView), c.get);
r.post(
  '/accounts/period-lock',
  society(),
  can(PERM.accountsApprove),
  feature(ENT.periodsAndLocking),
  validate({ body: s.lock }),
  stepUp(),
  c.lock,
);
r.post(
  '/accounts/period-lock/unlock-requests',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.periodsAndLocking),
  validate({ body: s.unlock }),
  idempotency(),
  c.unlock,
);
r.post(
  '/accounts/period-lock/relock',
  society(),
  can(PERM.accountsApprove),
  feature(ENT.periodsAndLocking),
  validate({ body: s.relock }),
  c.relock,
);
r.post(
  '/accounts/financial-years/:fy/close',
  society(),
  can(PERM.accountsApprove),
  feature(ENT.yearEndClosing),
  validate({ params: s.fyParam, body: s.close }),
  stepUp(),
  c.close,
);
