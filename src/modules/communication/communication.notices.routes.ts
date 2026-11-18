import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './communication.constants';
import { noticeController as c } from './communication.notices.controller';
import { noticeSchemas as s } from './communication.notices.validation';

/**
 * Part 16.1 routes (8.1 to 8.18). Order on a route: society marker, permission, entitlement, validate, rate limit, idempotency.
 * Fixed paths (`templates`, `audience-preview`) come before `/notices/:id`.
 */
export const noticeRoutes = Router();
const r = noticeRoutes;
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

r.get(
  '/notices',
  society(),
  can(PERM.noticesView),
  feature(ENT.composer, read),
  validate({ query: s.list }),
  c.list,
);
r.post(
  '/notices',
  society(),
  can(PERM.noticesCreate),
  feature(ENT.composer),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.get(
  '/notices/templates',
  society(),
  can(PERM.noticesCreate),
  feature(ENT.templateLibrary, read),
  validate({ query: s.templates }),
  c.templates,
);
r.post(
  '/notices/audience-preview',
  society(),
  can(PERM.noticesCreate),
  feature(ENT.composer),
  validate({ body: s.preview }),
  c.preview,
);
r.get(
  '/notices/:id',
  society(),
  can(PERM.noticesView),
  feature(ENT.composer, read),
  validate({ params: s.idParam }),
  c.detail,
);
r.patch(
  '/notices/:id',
  society(),
  can(PERM.noticesCreate, PERM.noticesEdit),
  feature(ENT.composer),
  validate({ params: s.idParam, body: s.patch }),
  c.patch,
);
r.delete(
  '/notices/:id',
  society(),
  can(PERM.noticesCreate, PERM.noticesDelete),
  validate({ params: s.idParam, query: s.del }),
  c.remove,
);
r.post(
  '/notices/:id/publish',
  society(),
  can(PERM.noticesCreate),
  feature(ENT.composer),
  validate({ params: s.idParam, body: s.publish }),
  idempotency(),
  c.publish,
);
r.post(
  '/notices/:id/withdraw',
  society(),
  can(PERM.noticesCreate, PERM.noticesEdit),
  validate({ params: s.idParam, body: s.withReason }),
  c.withdraw,
);
r.post(
  '/notices/:id/cancel-schedule',
  society(),
  can(PERM.noticesCreate, PERM.noticesEdit),
  validate({ params: s.idParam, body: s.withReason }),
  c.cancelSchedule,
);
r.post(
  '/notices/:id/recall',
  society(),
  can(PERM.noticesEdit),
  feature(ENT.revisionsAndRecall),
  validate({ params: s.idParam, body: s.recall }),
  c.recall,
);
r.post(
  '/notices/:id/pin',
  society(),
  can(PERM.noticesEdit),
  feature(ENT.pinningAndExpiry),
  validate({ params: s.idParam, body: s.withVersion }),
  c.pin,
);
r.post(
  '/notices/:id/unpin',
  society(),
  can(PERM.noticesEdit),
  validate({ params: s.idParam, body: s.withVersion }),
  c.unpin,
);
r.post(
  '/notices/:id/archive',
  society(),
  can(PERM.noticesEdit),
  validate({ params: s.idParam, body: s.withVersion }),
  c.archive,
);
r.post(
  '/notices/:id/duplicate',
  society(),
  can(PERM.noticesCreate),
  feature(ENT.composer),
  validate({ params: s.idParam }),
  idempotency(),
  c.duplicate,
);
r.post(
  '/notices/:id/remind',
  society(),
  can(PERM.noticesEdit),
  feature(ENT.mandatoryAck),
  validate({ params: s.idParam, body: s.withVersion }),
  c.remind,
);
r.post(
  '/notices/:id/restored',
  society(),
  can(PERM.noticesEdit),
  feature(ENT.utilityShutdown),
  validate({ params: s.idParam, body: s.restored }),
  c.restored,
);
r.get(
  '/notices/:id/receipts',
  society(),
  can(PERM.noticesView),
  feature(ENT.receiptDashboard, read),
  validate({ params: s.idParam, query: s.receipts }),
  c.receipts,
);
r.get(
  '/notices/:id/receipts/export',
  routeMeta({ noSupportAccess: true }),
  society(),
  can(PERM.noticesEdit),
  feature(ENT.receiptDashboard, read),
  validate({ params: s.idParam, query: s.receiptsExport }),
  rateLimit({
    name: 'notice-receipts-export',
    limit: 10,
    windowSeconds: 3600,
    key: req => String(req.ctx.user?.id),
  }),
  c.receiptsExport,
);
r.get(
  '/notices/:id/attachments/:fileId/download-url',
  society(),
  can(PERM.noticesView),
  validate({ params: s.fileParams, query: s.fileQuery }),
  c.fileUrl,
);
r.post(
  '/notices/:id/acknowledge',
  society(),
  can(PERM.noticesView),
  validate({ params: s.idParam, body: s.ack }),
  c.acknowledge,
);
