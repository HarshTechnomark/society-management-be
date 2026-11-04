import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { FEATURES, PERMISSIONS as P } from './billing.constants';
import { duesController as c } from './billing.dues.controller';
import { duesSchemas as s } from './billing.dues.validation';

/**
 * Sub-module 11.5 admin routes: dues summary and defaulters (8.22), reminders (8.18) and billing notes reads (8.19). Order on a
 * route: society marker, permission, entitlement, validate, idempotency. The defaulter CSV also needs `finance.billing.export`
 * (checked in the controller) and is limited to 10 downloads an hour.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const csvLimit = rateLimit({
  name: 'billing-defaulters-csv',
  limit: 10,
  windowSeconds: 3600,
  key: req => (req.query.format === 'csv' ? String(req.ctx.user?.id) : null),
});

export const billingDuesRoutes = Router();
const r = billingDuesRoutes;

r.get('/billing/summary', society(), can(P.view), validate({ query: s.summaryQuery }), c.summary);
r.get(
  '/billing/defaulters',
  society(),
  can(P.view),
  feature(FEATURES.defaulterList, read),
  validate({ query: s.defaultersQuery }),
  csvLimit as RequestHandler,
  c.defaulters,
);
r.post(
  '/invoices/:id/remind',
  society(),
  can(P.edit),
  validate({ params: s.idParam, body: s.remindBody }),
  c.remind,
);
r.post(
  '/billing/reminders',
  society(),
  can(P.edit),
  validate({ body: s.bulkRemindBody }),
  idempotency(),
  c.bulkRemind,
);
