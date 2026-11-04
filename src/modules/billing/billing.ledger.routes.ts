import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { tag } from '../access-control/access-control.registry';
import { FEATURES, PERMISSIONS as P } from './billing.constants';
import { ledgerController as c } from './billing.ledger.controller';
import { ledgerSchemas as s } from './billing.ledger.validation';

/**
 * Sub-module 11.2 routes: the statement of account (section 8.20) and opening balances (section 8.23). Order on a route:
 * society marker, permission, entitlement, validate, step-up (post and reverse), idempotency. Reads use the plan's read grace.
 * The statement CSV needs `finance.billing.export` too (checked in the controller) and is limited to 10 downloads an hour.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });
const csvLimit = rateLimit({
  name: 'billing-statement-csv',
  limit: 10,
  windowSeconds: 3600,
  key: req => (req.query.format === 'csv' ? String(req.ctx.user?.id) : null),
});

export const billingLedgerRoutes = Router();
const r = billingLedgerRoutes;

r.get(
  '/billing/units/:unitId/statement',
  society(),
  can(P.view),
  feature(FEATURES.statement, read),
  validate({ params: s.unitParam, query: s.statementQuery }),
  csvLimit as RequestHandler,
  c.statement,
);

r.get(
  '/billing/opening-balances',
  society(),
  can(P.view),
  feature(FEATURES.openingBalances, read),
  validate({ query: s.openingList }),
  c.openingList,
);
r.get(
  '/billing/opening-balances/template',
  society(),
  can(P.view),
  feature(FEATURES.openingBalances, read),
  c.openingTemplate,
);
r.post(
  '/billing/opening-balances/import',
  society(),
  can(P.import),
  feature(FEATURES.openingBalances),
  validate({ body: s.openingImport }),
  idempotency(),
  c.openingImport,
);
r.post(
  '/billing/opening-balances/post',
  society(),
  can(P.import),
  feature(FEATURES.openingBalances),
  validate({ body: s.openingPost }),
  stepUp(),
  idempotency(),
  c.openingPost,
);
r.post(
  '/billing/opening-balances/:id/reverse',
  society(),
  can(P.import),
  feature(FEATURES.openingBalances),
  validate({ params: s.idParam, body: s.openingReverse }),
  stepUp(),
  c.openingReverse,
);
r.delete(
  '/billing/opening-balances/:id',
  society(),
  can(P.import),
  feature(FEATURES.openingBalances),
  validate({ params: s.idParam, body: s.openingDelete }),
  c.openingDelete,
);
