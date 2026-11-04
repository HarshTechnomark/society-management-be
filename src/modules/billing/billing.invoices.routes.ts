import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { tag } from '../access-control/access-control.registry';
import { FEATURES as F, PERMISSIONS as P } from './billing.constants';
import { invoicesController as c } from './billing.invoices.controller';
import { invoiceSchemas as s } from './billing.invoices.validation';

/**
 * Sub-module 11.4 routes (sections 8.11 to 8.17 and 8.19). Order on a route: society marker, permission, entitlement, validate,
 * step-up (write-off), idempotency. Reads use the plan's read grace. The CSV export is limited to 10 an hour per user.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });
const exportLimit = rateLimit({
  name: 'billing-invoices-export',
  limit: 10,
  windowSeconds: 3600,
  key: req => String(req.ctx.user?.id),
});

export const billingInvoicesRoutes = Router();
const r = billingInvoicesRoutes;

r.get('/invoices', society(), can(P.view), validate({ query: s.list }), c.list);
r.get(
  '/invoices/export',
  society(),
  can(P.export),
  validate({ query: s.export }),
  exportLimit as RequestHandler,
  c.export,
);
r.get('/invoices/:id', society(), can(P.view), validate({ params: s.idParam }), c.get);
r.get(
  '/invoices/:id/pdf-url',
  society(),
  can(P.view),
  feature(F.invoicePdf, read),
  validate({ params: s.idParam }),
  c.pdfUrl,
);
r.post(
  '/invoices',
  society(),
  can(P.create),
  feature(F.adHocInvoices),
  validate({ body: s.adHoc }),
  idempotency(),
  c.adHoc,
);
r.post(
  '/invoices/:id/credit-notes',
  society(),
  can(P.create),
  feature(F.creditNotes),
  validate({ params: s.idParam, body: s.creditNote }),
  idempotency(),
  c.creditNote,
);
r.post(
  '/invoices/:id/debit-notes',
  society(),
  can(P.create),
  feature(F.debitNotes),
  validate({ params: s.idParam, body: s.debitNote }),
  idempotency(),
  c.debitNote,
);
r.post(
  '/invoices/:id/cancel',
  society(),
  can(P.edit),
  feature(F.creditNotes),
  validate({ params: s.idParam, body: s.cancel }),
  idempotency(),
  c.cancel,
);
r.post(
  '/invoices/:id/write-off',
  society(),
  can(P.edit),
  feature(F.creditNotes),
  validate({ params: s.idParam, body: s.writeOff }),
  stepUp(),
  idempotency(),
  c.writeOff,
);

r.get('/billing/notes', society(), can(P.view), validate({ query: s.noteList }), c.noteList);
r.get('/billing/notes/:id', society(), can(P.view), validate({ params: s.idParam }), c.noteGet);
r.get(
  '/billing/notes/:id/pdf-url',
  society(),
  can(P.view),
  feature(F.invoicePdf, read),
  validate({ params: s.idParam }),
  c.notePdfUrl,
);
r.patch(
  '/billing/notes/:id',
  society(),
  can(P.create),
  feature(F.creditNotes),
  validate({ params: s.idParam, body: s.patchNote }),
  c.notePatch,
);
r.post(
  '/billing/notes/:id/withdraw',
  society(),
  can(P.create),
  feature(F.creditNotes),
  validate({ params: s.idParam, body: s.withdraw }),
  c.noteWithdraw,
);
