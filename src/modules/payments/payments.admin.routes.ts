import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { tag } from '../access-control/access-control.registry';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './payments.constants';
import { paymentsAdminController as c } from './payments.admin.controller';
import { adminSchemas as s } from './payments.admin.validation';

/**
 * Sub-module 12.3 routes: payments list and detail (8.10), summary and live feed (8.13), reverse (8.14), reallocate (8.15),
 * receipts, review flag (8.16), export (8.17), resident payments (8.5) and advances (8.7). Order on a route: state policy,
 * society marker, permission, entitlement, validate, step-up, idempotency. The fixed paths (`summary`, `live-feed`, `export`)
 * come before `/payments/:id`.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });
const exportLimit = rateLimit({
  name: 'payments-export',
  limit: 10,
  windowSeconds: 3600,
  key: req => String(req.ctx.user?.id),
});

export const paymentsAdminRoutes = Router();
const r = paymentsAdminRoutes;

r.get('/payments', society(), can(PERM.paymentsView), validate({ query: s.listQuery }), c.list);
r.get(
  '/payments/summary',
  society(),
  can(PERM.paymentsView),
  feature(ENT.liveBalance, read),
  validate({ query: s.summaryQuery }),
  c.summary,
);
r.get(
  '/payments/live-feed',
  society(),
  can(PERM.paymentsView),
  feature(ENT.liveBalance, read),
  validate({ query: s.feedQuery }),
  c.feed,
);
r.get(
  '/payments/export',
  routeMeta({ noSupportAccess: true }),
  society(),
  can(PERM.paymentsExport),
  validate({ query: s.exportQuery }),
  exportLimit as RequestHandler,
  c.export,
);
r.get('/payments/:id', society(), can(PERM.paymentsView), validate({ params: s.idParam }), c.get);
r.get(
  '/payments/:id/receipt-url',
  society(),
  can(PERM.paymentsView),
  feature(ENT.receipts, read),
  validate({ params: s.idParam }),
  c.receiptUrl,
);
r.post(
  '/payments/:id/receipt/resend',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.receipts),
  validate({ params: s.idParam, body: s.resendBody }),
  idempotency(),
  c.resend,
);
r.post(
  '/payments/:id/review-done',
  society(),
  can(PERM.paymentsEdit),
  validate({ params: s.idParam, body: s.reviewDoneBody }),
  c.reviewDone,
);
r.post(
  '/payments/:id/reverse',
  society(),
  can(PERM.paymentsApprove),
  feature(ENT.refunds),
  validate({ params: s.idParam, body: s.reverseBody }),
  stepUp(),
  idempotency(),
  c.reverse,
);
r.post(
  '/payments/:id/reallocate',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.allocationEngine),
  validate({ params: s.idParam, body: s.reallocateBody }),
  idempotency(),
  c.reallocate,
);

// ---- resident
r.get(
  '/me/payments',
  society(),
  can(PERM.residentPaymentsView),
  validate({ query: s.myListQuery }),
  c.myList,
);
r.get(
  '/me/payments/:id',
  society(),
  can(PERM.residentPaymentsView),
  validate({ params: s.idParam }),
  c.myGet,
);
r.get(
  '/me/payments/:id/receipt-url',
  society(),
  can(PERM.residentPaymentsView),
  feature(ENT.receipts, read),
  validate({ params: s.idParam }),
  c.myReceiptUrl,
);
r.get(
  '/me/advances',
  society(),
  can(PERM.residentPaymentsView),
  feature(ENT.unitWallet, read),
  validate({ query: s.myAdvancesQuery }),
  c.myAdvances,
);
r.get(
  '/units/:unitId/advances',
  society(),
  can(PERM.paymentsView),
  feature(ENT.unitWallet, read),
  validate({ params: s.unitParam, query: s.advancesQuery }),
  c.unitAdvances,
);
