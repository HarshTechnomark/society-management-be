import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { platformMiddleware, societyMiddleware } from '../../middlewares/society.middleware';
import {
  publicRoute,
  requirePermission as can,
  requirePlatformPermission as canPlatform,
} from '../../middlewares/permission.middleware';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { tag } from '../access-control/access-control.registry';
import { routeMeta } from '../societies/societies.guard';
import { isFlagOn } from '../subscriptions/flags.service';
import { platformBillingController as c } from './platform-billing.controller';
import { platformBillingSchemas as s } from './platform-billing.validation';

/**
 * Module 06 routes (section 8). Order on a route: routeMeta (state policy), society or platform marker, permission,
 * validate, step-up, idempotency, controller. Fixed paths (`/invoices/export`) come before `/invoices/:id`.
 * Society payment routes are allowed while the society is suspended or closed (6.5); autopay is not.
 */
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const society = () => societyMiddleware();
const platform = () => platformMiddleware();
/** 6.5: paying and reading billing stays possible for SUSPENDED and CLOSED societies. */
const allow = () => routeMeta({ suspended: 'allow', closed: 'allow' });
const view = 'settings.subscription.view';
const edit = 'settings.subscription.edit';

/** Flag `platform.autopay` off hides the routes with `404 NOT_FOUND` (8.11); after the permission check. */
const autopayFlag = (): RequestHandler => async (req, _res, next) => {
  try {
    if (await isFlagOn('platform.autopay', { societyId: req.ctx.society!.id })) return next();
    next(new NotFoundError('NOT_FOUND', 'Not found'));
  } catch (err) {
    next(err);
  }
};

/** `format=csv` of a report also needs `platform.billing.export` (8.27); the view permission was checked before. */
const csvNeedsExport = (): RequestHandler => (req, _res, next) =>
  req.valid?.query?.format === 'csv' && !req.ctx.platformPermissions.has('platform.billing.export')
    ? next(new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to do this'))
    : next();

export const platformBillingRoutes = Router();
const r = platformBillingRoutes;

// ---- society (8.1 to 8.11)
r.get('/subscription/billing-summary', allow(), society(), can(view), c.summary);
r.get(
  '/subscription/invoices',
  allow(),
  society(),
  can(view),
  validate({ query: s.societyInvoices }),
  c.societyInvoices,
);
r.get(
  '/subscription/invoices/:id',
  allow(),
  society(),
  can(view),
  validate({ params: s.idParam }),
  c.societyInvoice,
);
r.get(
  '/subscription/invoices/:id/pdf-url',
  allow(),
  society(),
  can(view),
  validate({ params: s.idParam }),
  c.societyPdf,
);
r.post(
  '/subscription/invoices/:id/payment-orders',
  allow(),
  society(),
  can(edit),
  validate({ params: s.idParam, body: s.paymentOrder }),
  idempotency(),
  c.paymentOrder,
);
r.post(
  '/subscription/payments/:id/verify',
  allow(),
  society(),
  can(edit),
  validate({ params: s.idParam, body: s.verify }),
  c.verify,
);
r.get(
  '/subscription/payments',
  allow(),
  society(),
  can(view),
  validate({ query: s.societyPayments }),
  c.societyPayments,
);
r.get(
  '/subscription/credits',
  allow(),
  society(),
  can(view),
  validate({ query: s.credits }),
  c.societyCredits,
);
r.post(
  '/subscription/invoices/:id/tds-claims',
  allow(),
  society(),
  can(edit),
  validate({ params: s.idParam, body: s.tdsClaim }),
  idempotency(),
  c.societyTds,
);
r.patch(
  '/subscription/tds-claims/:id',
  allow(),
  society(),
  can(edit),
  validate({ params: s.idParam, body: s.tdsPatch }),
  c.attachCertificate,
);
r.post(
  '/subscription/autopay',
  society(),
  can(edit),
  autopayFlag(),
  validate({ body: s.autopay }),
  c.requestAutopay,
);
r.delete('/subscription/autopay', society(), can(edit), autopayFlag(), c.cancelAutopay);

// ---- platform invoices (8.2, 8.3, 8.4, 8.9, 8.12 to 8.14)
r.get(
  '/platform/invoices',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ query: s.platformInvoices }),
  c.platformInvoices,
);
r.get(
  '/platform/invoices/export',
  platform(),
  canPlatform('platform.billing.export'),
  validate({ query: s.exportInvoices }),
  rateLimit({
    name: 'platform-invoices-export',
    limit: 10,
    windowSeconds: 3600,
    key: req => String(req.ctx.user?.id),
  }),
  c.exportInvoices,
);
r.get(
  '/platform/invoices/:id',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ params: s.idParam }),
  c.platformInvoice,
);
r.get(
  '/platform/invoices/:id/pdf-url',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ params: s.idParam }),
  c.platformPdf,
);
r.post(
  '/platform/invoices',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ body: s.manualInvoice }),
  idempotency(),
  c.manualInvoice,
);
r.post(
  '/platform/invoices/:id/credit-notes',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.idParam, body: s.creditNote }),
  idempotency(),
  c.creditNote,
);
r.post(
  '/platform/invoices/:id/approve',
  platform(),
  canPlatform('platform.billing.approve'),
  validate({ params: s.idParam, body: s.approve }),
  stepUp(),
  c.approveInvoice,
);
r.post(
  '/platform/invoices/:id/reject',
  platform(),
  canPlatform('platform.billing.approve'),
  validate({ params: s.idParam, body: s.reject }),
  c.rejectInvoice,
);
r.post(
  '/platform/invoices/:id/tds-claims',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.idParam, body: s.tdsClaim }),
  idempotency(),
  c.platformTds,
);

// ---- collections (8.15 to 8.17)
r.post(
  '/platform/invoices/:id/remind',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.idParam, body: s.remind }),
  c.remind,
);
r.post(
  '/platform/invoices/:id/extend-grace',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.idParam, body: s.extendGrace }),
  c.extendGrace,
);
r.post(
  '/platform/invoices/:id/write-off',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.idParam, body: s.writeOffRequest }),
  stepUp(),
  c.requestWriteOff,
);
r.post(
  '/platform/invoices/:id/write-off/approve',
  platform(),
  canPlatform('platform.billing.approve'),
  validate({ params: s.idParam, body: s.approve }),
  stepUp(),
  c.approveWriteOff,
);
r.post(
  '/platform/invoices/:id/write-off/reject',
  platform(),
  canPlatform('platform.billing.approve'),
  validate({ params: s.idParam, body: s.reject }),
  c.rejectWriteOff,
);

// ---- queues and reports (8.24 to 8.27)
r.get(
  '/platform/billing/approvals',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ query: s.approvals }),
  c.approvals,
);
r.get(
  '/platform/billing/dunning',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ query: s.dunning }),
  c.dunning,
);
r.get(
  '/platform/billing/revenue',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ query: s.revenue }),
  c.revenue,
);
r.get(
  '/platform/billing/gst-summary',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ query: s.gstSummary }),
  csvNeedsExport(),
  c.gstSummary,
);
r.get(
  '/platform/billing/tds-receivable',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ query: s.tdsReceivable }),
  csvNeedsExport(),
  c.tdsReceivable,
);

// ---- platform payments, TDS decision, refunds, credits (8.7, 8.8, 8.18 to 8.23)
r.get(
  '/platform/payments',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ query: s.platformPayments }),
  c.platformPayments,
);
r.post(
  '/platform/payments',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ body: s.manualPayment }),
  stepUp(),
  idempotency(),
  c.manualPayment,
);
r.post(
  '/platform/payments/:id/approve',
  platform(),
  canPlatform('platform.billing.approve'),
  validate({ params: s.idParam, body: s.approve }),
  stepUp(),
  c.approvePayment,
);
r.post(
  '/platform/payments/:id/reject',
  platform(),
  canPlatform('platform.billing.approve'),
  validate({ params: s.idParam, body: s.reject }),
  c.rejectPayment,
);
r.post(
  '/platform/payments/:id/tds-decision',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.idParam, body: s.tdsDecision }),
  c.tdsDecision,
);
r.post(
  '/platform/payments/:id/complete-refund',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.idParam, body: s.completeRefund }),
  stepUp(),
  c.completeRefund,
);
r.post(
  '/platform/societies/:societyId/refunds',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.societyParam, body: s.refund }),
  stepUp(),
  idempotency(),
  c.requestRefund,
);
r.get(
  '/platform/societies/:societyId/credits',
  platform(),
  canPlatform('platform.billing.view'),
  validate({ params: s.societyParam, query: s.credits }),
  c.platformCredits,
);
r.post(
  '/platform/societies/:societyId/credits',
  platform(),
  canPlatform('platform.billing.edit'),
  validate({ params: s.societyParam, body: s.goodwill }),
  stepUp(),
  idempotency(),
  c.requestGoodwill,
);
r.post(
  '/platform/credits/:id/approve',
  platform(),
  canPlatform('platform.billing.approve'),
  validate({ params: s.idParam, body: s.approve }),
  stepUp(),
  c.approveCredit,
);
r.post(
  '/platform/credits/:id/reject',
  platform(),
  canPlatform('platform.billing.approve'),
  validate({ params: s.idParam, body: s.reject }),
  c.rejectCredit,
);

// ---- 8.28 gateway webhook: signature only, no cookie, no CSRF; 600 per minute per IP
r.post(
  '/webhooks/platform-billing/razorpay',
  publicRoute(),
  rateLimit({ name: 'platform-webhook', limit: 600, windowSeconds: 60, key: req => req.ip ?? 'unknown' }),
  c.webhook,
);
