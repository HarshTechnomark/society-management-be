import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './accounts.constants';
import { reportsController as c } from './accounts.reports.controller';
import { reportSchemas as s, residentSchemas as rs } from './accounts.reports.validation';

/**
 * Sub-module 13.4b routes: financial reports and their export (8.19, Premium) and the resident finance view (8.3).
 * Order on a route: marker, society, permission, entitlement, validate, rate limit, idempotency.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const exportLimit = rateLimit({
  name: 'accounts-report-export',
  limit: 10,
  windowSeconds: 3600,
  key: req => String(req.ctx.user?.id),
});

export const accountsReportsRoutes = Router();
const r = accountsReportsRoutes;

r.get(
  '/accounts/reports/:report',
  society(),
  can(PERM.accountsView),
  feature(ENT.financialReports, read),
  validate({ params: s.report, query: s.query }),
  c.run,
);
r.post(
  '/accounts/exports',
  routeMeta({ noSupportAccess: true }),
  society(),
  can(PERM.accountsExport),
  feature(ENT.financialReports),
  validate({ body: s.exportBody }),
  exportLimit as RequestHandler,
  idempotency(),
  c.export,
);
r.get('/me/society-finances', society(), can(PERM.residentFinancesView), c.myFinances);
r.get(
  '/me/society-finances/funds/:id/statement',
  society(),
  can(PERM.residentFinancesView),
  validate({ params: rs.id }),
  c.myFundStatement,
);
