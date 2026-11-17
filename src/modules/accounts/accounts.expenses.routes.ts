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
import { ENT, PERM } from './accounts.constants';
import { expenseController as c } from './accounts.expenses.controller';
import { expenseSchemas as s } from './accounts.expenses.validation';

/**
 * Routes 5 to 14 of section 8: cash book, expenses and the export. Order on a route: society marker, permission, entitlement,
 * validate, step-up, idempotency. `/expenses/export` comes before `/expenses/:id`.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });
const exportLimit = rateLimit({
  name: 'expenses-export',
  limit: 10,
  windowSeconds: 3600,
  key: req => String(req.ctx.user?.id),
});

export const accountsExpensesRoutes = Router();
const r = accountsExpensesRoutes;

r.get(
  '/accounts/cash-book',
  society(),
  can(PERM.expensesView),
  feature(ENT.cashBook, read),
  validate({ query: s.cashBook }),
  c.cashBook,
);
r.get(
  '/expenses',
  society(),
  can(PERM.expensesView),
  feature(ENT.cashBook, read),
  validate({ query: s.list }),
  c.list,
);
r.get(
  '/expenses/export',
  routeMeta({ noSupportAccess: true }),
  society(),
  can(PERM.expensesExport),
  feature(ENT.cashBook, read),
  validate({ query: s.export }),
  exportLimit as RequestHandler,
  c.export,
);
r.get(
  '/expenses/:id',
  society(),
  can(PERM.expensesView),
  feature(ENT.cashBook, read),
  validate({ params: s.idParam }),
  c.get,
);
r.post(
  '/expenses',
  society(),
  can(PERM.expensesCreate),
  feature(ENT.cashBook),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.patch(
  '/expenses/:id',
  society(),
  can(PERM.expensesCreate, PERM.expensesEdit),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.patch }),
  c.patch,
);
r.post(
  '/expenses/:id/submit',
  society(),
  can(PERM.expensesCreate),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.submit }),
  idempotency(),
  c.submit,
);
r.post(
  '/expenses/:id/withdraw',
  society(),
  can(PERM.expensesCreate),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.withdraw }),
  c.withdraw,
);
r.delete(
  '/expenses/:id',
  society(),
  can(PERM.expensesDelete, PERM.expensesCreate),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.remove }),
  c.remove,
);
r.post(
  '/expenses/:id/reverse',
  society(),
  can(PERM.expensesApprove),
  feature(ENT.cashBook),
  validate({ params: s.idParam, body: s.reverse }),
  stepUp(),
  idempotency(),
  c.reverse,
);
