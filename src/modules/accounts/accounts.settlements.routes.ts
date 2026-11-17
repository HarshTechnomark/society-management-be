import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { tag } from '../access-control/access-control.registry';
import { ENT, PERM } from './accounts.constants';
import { settlementController as c } from './accounts.settlements.controller';
import { settlementSchemas as s } from './accounts.settlements.validation';

/** Section 8.15 (routes 39 to 42). Order: society, permission, entitlement, validate, step-up, idempotency. */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });

export const accountsSettlementRoutes = Router();
const r = accountsSettlementRoutes;

r.get(
  '/accounts/settlements',
  society(),
  can(PERM.bankView),
  feature(ENT.settlements, read),
  validate({ query: s.list }),
  c.list,
);
r.get(
  '/accounts/settlements/:id',
  society(),
  can(PERM.bankView),
  feature(ENT.settlements, read),
  validate({ params: s.idParam }),
  c.get,
);
r.post(
  '/accounts/settlements/import',
  society(),
  can(PERM.bankImport),
  feature(ENT.settlements),
  validate({ body: s.import }),
  idempotency(),
  c.import,
);
r.post(
  '/accounts/settlements/:id/reconcile',
  society(),
  can(PERM.bankImport),
  feature(ENT.settlements),
  validate({ params: s.idParam }),
  c.reconcile,
);
r.post(
  '/accounts/settlements/:id/accept-difference',
  society(),
  can(PERM.bankApprove),
  feature(ENT.settlements),
  validate({ params: s.idParam, body: s.accept }),
  stepUp(),
  idempotency(),
  c.accept,
);
