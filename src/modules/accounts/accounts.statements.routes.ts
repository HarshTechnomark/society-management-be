import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { ENT, PERM } from './accounts.constants';
import { statementController as c } from './accounts.statements.controller';
import { statementSchemas as s } from './accounts.statements.validation';

/**
 * Sections 8.14 (BRS) and 8.16 (statements, lines, matching). Order on a route: society marker, permission, entitlement, validate,
 * idempotency (import and create-entry). Reads use the plan's read grace.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

export const accountsStatementRoutes = Router();
const r = accountsStatementRoutes;
const lines = '/accounts/bank-statement-lines/:id';

r.post(
  '/accounts/bank-statements',
  society(),
  can(PERM.bankImport),
  feature(ENT.statementImport),
  validate({ body: s.import }),
  idempotency(),
  c.import,
);
r.get(
  '/accounts/bank-statements',
  society(),
  can(PERM.bankView),
  feature(ENT.statementImport, read),
  validate({ query: s.list }),
  c.list,
);
r.get(
  '/accounts/bank-statements/:id',
  society(),
  can(PERM.bankView),
  feature(ENT.statementImport, read),
  validate({ params: s.idParam }),
  c.get,
);
r.get(
  '/accounts/bank-statements/:id/lines',
  society(),
  can(PERM.bankView),
  feature(ENT.statementImport, read),
  validate({ params: s.idParam, query: s.lines }),
  c.lines,
);
r.post(
  '/accounts/bank-statements/:id/auto-match',
  society(),
  can(PERM.bankImport),
  feature(ENT.statementImport),
  validate({ params: s.idParam }),
  c.autoMatch,
);
r.post(
  '/accounts/bank-statements/:id/mark-reconciled',
  society(),
  can(PERM.bankApprove),
  feature(ENT.bankReconciliation),
  validate({ params: s.idParam, body: s.versionBody }),
  c.markReconciled,
);
r.get(
  `${lines}/candidates`,
  society(),
  can(PERM.bankView),
  feature(ENT.statementImport, read),
  validate({ params: s.idParam }),
  c.candidates,
);
r.post(
  `${lines}/match`,
  society(),
  can(PERM.bankImport),
  feature(ENT.statementImport),
  validate({ params: s.idParam, body: s.match }),
  c.match,
);
r.post(
  `${lines}/unmatch`,
  society(),
  can(PERM.bankImport),
  feature(ENT.statementImport),
  validate({ params: s.idParam, body: s.versionBody }),
  c.unmatch,
);
r.post(
  `${lines}/ignore`,
  society(),
  can(PERM.bankImport),
  feature(ENT.statementImport),
  validate({ params: s.idParam, body: s.ignore }),
  c.ignore,
);
r.post(
  `${lines}/create-entry`,
  society(),
  can(PERM.bankImport),
  feature(ENT.statementImport),
  validate({ params: s.idParam, body: s.createEntry }),
  idempotency(),
  c.createEntry,
);
r.get(
  '/accounts/bank-accounts/:id/brs',
  society(),
  can(PERM.bankView),
  feature(ENT.bankReconciliation, read),
  validate({ params: s.idParam, query: s.brs }),
  c.brs,
);
