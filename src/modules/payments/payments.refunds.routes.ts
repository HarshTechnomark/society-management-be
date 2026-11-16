import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { ENT, PERM } from './payments.constants';
import { refundController as c } from './payments.refunds.controller';
import { refundSchemas as s } from './payments.refunds.validation';

/**
 * Section 8.19 refund routes. Order on a route: society marker, permission, entitlement, validate, idempotency (creates).
 * Refunds are blocked while the society is suspended (default state policy). The spec has no refund cancel route: a requester
 * withdraws through module 14, which calls `onCancelled`.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

export const paymentsRefundRoutes = Router();
const r = paymentsRefundRoutes;

r.get(
  '/refunds',
  society(),
  can(PERM.paymentsView),
  feature(ENT.refunds, read),
  validate({ query: s.list }),
  c.list,
);
r.get(
  '/refunds/:id',
  society(),
  can(PERM.paymentsView),
  feature(ENT.refunds, read),
  validate({ params: s.idParam }),
  c.get,
);
r.post(
  '/refunds',
  society(),
  can(PERM.paymentsCreate),
  feature(ENT.refunds),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.post(
  '/refunds/:id/complete',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.refunds),
  validate({ params: s.idParam, body: s.complete }),
  c.complete,
);
