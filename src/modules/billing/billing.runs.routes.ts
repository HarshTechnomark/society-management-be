import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { FEATURES as F, PERMISSIONS as P } from './billing.constants';
import { runsController as c } from './billing.runs.controller';
import { runSchemas as s } from './billing.runs.validation';

/**
 * Billing run routes of sub-module 11.3 (sections 8.5 to 8.10). Order on a route: society marker, permission, entitlement,
 * validate, idempotency (create and publish). Reads use the plan's read grace. Writes are refused for a suspended or closed
 * society by module 05 (no route is allow-listed). Supplementary runs and non-monthly cycles are plan-checked in the service.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

export const billingRunsRoutes = Router();
const r = billingRunsRoutes;

r.get(
  '/billing/runs',
  society(),
  can(P.view),
  feature(F.runPipeline, read),
  validate({ query: s.runList }),
  c.list,
);
r.post(
  '/billing/runs',
  society(),
  can(P.create),
  feature(F.runPipeline),
  validate({ body: s.createRun }),
  idempotency(),
  c.create,
);
r.get(
  '/billing/runs/:id',
  society(),
  can(P.view),
  feature(F.runPipeline, read),
  validate({ params: s.idParam }),
  c.get,
);
r.get(
  '/billing/runs/:id/items',
  society(),
  can(P.view),
  feature(F.runPipeline, read),
  feature(F.exceptionsReport, read),
  validate({ params: s.idParam, query: s.itemList }),
  c.items,
);
r.patch(
  '/billing/runs/:id',
  society(),
  can(P.create),
  feature(F.runPipeline),
  validate({ params: s.idParam, body: s.patchRun }),
  c.patch,
);
r.post(
  '/billing/runs/:id/recompute',
  society(),
  can(P.create),
  feature(F.runPipeline),
  validate({ params: s.idParam, body: s.versionOnly }),
  c.recompute,
);
r.post(
  '/billing/runs/:id/items/:itemId/exclude',
  society(),
  can(P.create),
  feature(F.exceptionsReport),
  validate({ params: s.itemParam, body: s.exclude }),
  c.exclude,
);
r.post(
  '/billing/runs/:id/items/:itemId/include',
  society(),
  can(P.create),
  feature(F.exceptionsReport),
  validate({ params: s.itemParam, body: s.versionOnly }),
  c.include,
);
r.post(
  '/billing/runs/:id/publish',
  society(),
  can(P.create),
  feature(F.runPipeline),
  validate({ params: s.idParam, body: s.publish }),
  idempotency(),
  c.publish,
);
r.post(
  '/billing/runs/:id/cancel',
  society(),
  can(P.edit),
  feature(F.runPipeline),
  validate({ params: s.idParam, body: s.cancel }),
  c.cancel,
);
r.post(
  '/billing/runs/:id/resume-issue',
  society(),
  can(P.create),
  feature(F.runPipeline),
  validate({ params: s.idParam, body: s.versionOnly }),
  c.resume,
);
