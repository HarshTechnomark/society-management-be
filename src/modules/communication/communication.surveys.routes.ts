import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './communication.constants';
import { surveyController as c } from './communication.surveys.controller';
import { surveySchemas as s } from './communication.surveys.validation';

/** Part 16.3 survey routes (8.31 to 8.34). Everything but close, cancel and delete needs the `surveys_with_analytics` plan feature. Order: society, permission, plan, validate, idempotency. */
export const surveyRoutes = Router();
const r = surveyRoutes;
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

r.get(
  '/surveys',
  society(),
  can(PERM.surveysView),
  feature(ENT.surveys, read),
  validate({ query: s.list }),
  c.list,
);
r.post(
  '/surveys',
  society(),
  can(PERM.surveysCreate),
  feature(ENT.surveys),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.get(
  '/surveys/:id',
  society(),
  can(PERM.surveysView),
  feature(ENT.surveys, read),
  validate({ params: s.idParam }),
  c.detail,
);
r.patch(
  '/surveys/:id',
  society(),
  can(PERM.surveysCreate, PERM.surveysEdit),
  feature(ENT.surveys),
  validate({ params: s.idParam, body: s.patch }),
  c.patch,
);
r.delete(
  '/surveys/:id',
  society(),
  can(PERM.surveysEdit),
  validate({ params: s.idParam, query: s.remove }),
  c.remove,
);
r.post(
  '/surveys/:id/publish',
  society(),
  can(PERM.surveysCreate),
  feature(ENT.surveys),
  validate({ params: s.idParam, body: s.publish }),
  c.publish,
);
r.post(
  '/surveys/:id/close',
  society(),
  can(PERM.surveysEdit),
  validate({ params: s.idParam, body: s.close }),
  c.close,
);
r.post(
  '/surveys/:id/cancel',
  society(),
  can(PERM.surveysEdit),
  validate({ params: s.idParam, body: s.cancel }),
  c.cancel,
);
r.get(
  '/surveys/:id/results',
  society(),
  can(PERM.surveysView),
  feature(ENT.surveys, read),
  validate({ params: s.idParam }),
  c.results,
);
r.get(
  '/surveys/:id/results/export',
  routeMeta({ noSupportAccess: true }),
  society(),
  can(PERM.surveysExport),
  feature(ENT.surveys, read),
  validate({ params: s.idParam }),
  c.export,
);
r.get('/me/surveys', society(), can(PERM.residentNoticesView), feature(ENT.surveys, read), c.mine);
r.get(
  '/me/surveys/:id',
  society(),
  can(PERM.residentNoticesView),
  feature(ENT.surveys, read),
  validate({ params: s.idParam }),
  c.mineDetail,
);
r.post(
  '/me/surveys/:id/responses',
  society(),
  can(PERM.residentNoticesEdit),
  feature(ENT.surveys),
  validate({ params: s.idParam, body: s.respond }),
  idempotency(),
  c.respond,
);
