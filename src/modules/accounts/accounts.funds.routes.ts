import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { ENT, PERM } from './accounts.constants';
import { fundsController as c } from './accounts.funds.controller';
import { fundSchemas as s } from './accounts.funds.validation';

/**
 * 13.2 fund routes (section 8.13). Order on a route: society marker, permission, entitlement, validate, idempotency (create only).
 * `POST /accounts/funds` checks `accounting.funds` in the service only for `fundType CUSTOM`.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

export const accountsFundsRoutes = Router();
const r = accountsFundsRoutes;

r.get(
  '/accounts/funds',
  society(),
  can(PERM.accountsView),
  feature(ENT.fundBalances, read),
  validate({ query: s.list }),
  c.list,
);
r.post(
  '/accounts/funds',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.fundBalances),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.get(
  '/accounts/funds/:id/statement',
  society(),
  can(PERM.accountsView),
  feature(ENT.fundBalances, read),
  validate({ params: s.idParam, query: s.statement }),
  c.statement,
);
r.patch(
  '/accounts/funds/:id',
  society(),
  can(PERM.accountsEdit),
  feature(ENT.funds),
  validate({ params: s.idParam, body: s.patch }),
  c.patch,
);
r.post(
  '/accounts/fund-transfers',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.funds),
  validate({ body: s.transfer }),
  idempotency(),
  c.transfer,
);
