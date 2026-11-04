import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { z } from 'zod';
import { FEATURES, PERMISSIONS as P } from './billing.constants';
import { residentController as c } from './billing.dues.controller';
import { ledgerSchemas } from './billing.ledger.validation';

/** Sub-module 11.5 resident routes (section 8.21): own bills, bill detail, PDF url, dues summary and the owner-side statement. */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const id = z.coerce.number().int().positive();
const listQuery = z
  .object({
    unitId: id.optional(),
    status: z.enum(['OPEN', 'PAID', 'ALL']).default('ALL'),
    financialYear: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const statementQuery = z
  .object({ from: ledgerSchemas.statementQuery.shape.from, to: ledgerSchemas.statementQuery.shape.to })
  .strict();

export const billingResidentRoutes = Router();
const r = billingResidentRoutes;

r.get('/me/dues', society(), can(P.residentDuesView), c.dues);
r.get('/me/invoices', society(), can(P.residentDuesView), validate({ query: listQuery }), c.invoices);
r.get(
  '/me/invoices/:id',
  society(),
  can(P.residentDuesView),
  validate({ params: z.object({ id }) }),
  c.invoice,
);
r.get(
  '/me/invoices/:id/pdf-url',
  society(),
  can(P.residentDuesView),
  validate({ params: z.object({ id }) }),
  c.pdfUrl,
);
r.get(
  '/me/units/:unitId/statement',
  society(),
  can(P.residentDuesView),
  feature(FEATURES.statement, read),
  validate({ params: z.object({ unitId: id }), query: statementQuery }),
  c.statement,
);
