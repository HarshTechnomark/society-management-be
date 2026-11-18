import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { ENT, PERM } from './helpdesk.constants';
import { adminController as c } from './helpdesk.admin.controller';
import { adminSchemas as s } from './helpdesk.admin.validation';

/**
 * Part 15.2 routes (8.7 to 8.21). Order on a route: society marker, permission, entitlement, validate, rate limit, idempotency.
 * Fixed paths (`stats`, `export`, `assignees`) come before `/tickets/:id`.
 */
export const helpdeskAdminRoutes = Router();
const r = helpdeskAdminRoutes;
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

r.get(
  '/tickets',
  society(),
  can(PERM.ticketsView),
  feature(ENT.raiseTicket, read),
  validate({ query: s.list }),
  c.list,
);
r.get(
  '/tickets/stats',
  society(),
  can(PERM.ticketsView),
  feature(ENT.analytics, read),
  validate({ query: s.stats }),
  c.stats,
);
r.get(
  '/tickets/export',
  society(),
  can(PERM.ticketsExport),
  feature(ENT.raiseTicket, read),
  validate({ query: s.exportQuery }),
  rateLimit({
    name: 'helpdesk-export',
    limit: 10,
    windowSeconds: 3600,
    key: req => String(req.ctx.user?.id),
  }),
  c.export,
);
r.get(
  '/tickets/assignees',
  society(),
  can(PERM.ticketsEdit),
  feature(ENT.raiseTicket, read),
  validate({ query: s.assignees }),
  c.assignees,
);
r.post(
  '/tickets',
  society(),
  can(PERM.ticketsCreate),
  feature(ENT.raiseTicket),
  validate({ body: s.onBehalf }),
  idempotency(),
  c.create,
);
r.get(
  '/tickets/:id',
  society(),
  can(PERM.ticketsView),
  feature(ENT.raiseTicket, read),
  validate({ params: s.idParam }),
  c.detail,
);
r.patch(
  '/tickets/:id',
  society(),
  can(PERM.ticketsEdit),
  feature(ENT.raiseTicket),
  validate({ params: s.idParam, body: s.patch }),
  c.patch,
);
r.post(
  '/tickets/:id/assign',
  society(),
  can(PERM.ticketsEdit),
  feature(ENT.raiseTicket),
  validate({ params: s.idParam, body: s.assign }),
  c.assign,
);
r.post(
  '/tickets/:id/unassign',
  society(),
  can(PERM.ticketsEdit),
  feature(ENT.raiseTicket),
  validate({ params: s.idParam, body: s.unassign }),
  c.unassign,
);
r.post(
  '/tickets/:id/transition',
  society(),
  can(PERM.ticketsEdit),
  feature(ENT.statusWorkflow),
  validate({ params: s.idParam, body: s.transition }),
  idempotency(),
  c.transition,
);
r.post(
  '/tickets/:id/merge',
  society(),
  can(PERM.ticketsEdit),
  feature(ENT.buildingIssueByAnyone),
  validate({ params: s.idParam, body: s.merge }),
  c.merge,
);
r.post(
  '/tickets/:id/estimate',
  society(),
  can(PERM.ticketsEdit),
  feature(ENT.chargeableWork),
  validate({ params: s.idParam, body: s.estimate }),
  idempotency(),
  c.estimate,
);
r.get(
  '/tickets/:id/comments',
  society(),
  can(PERM.ticketsView),
  feature(ENT.raiseTicket, read),
  validate({ params: s.idParam, query: s.commentList }),
  c.comments,
);
r.post(
  '/tickets/:id/comments',
  society(),
  can(PERM.ticketsEdit),
  feature(ENT.raiseTicket),
  validate({ params: s.idParam, body: s.commentPost }),
  idempotency(),
  c.comment,
);
r.delete(
  '/tickets/:id/comments/:commentId',
  society(),
  can(PERM.ticketsDelete, PERM.ticketsEdit),
  feature(ENT.raiseTicket),
  validate({ params: s.commentParam, body: s.commentDelete }),
  c.removeComment,
);
r.get(
  '/tickets/:id/files/:fileId/download-url',
  society(),
  can(PERM.ticketsView),
  feature(ENT.raiseTicket, read),
  validate({ params: s.fileParam, query: s.download }),
  c.fileUrl,
);
r.post(
  '/building-issues',
  society(),
  can(PERM.ticketsCreate),
  feature(ENT.buildingIssueByAnyone),
  validate({ body: s.buildingIssue }),
  idempotency(),
  c.buildingIssue,
);
r.get(
  '/building-issues/similar',
  society(),
  can(PERM.ticketsCreate),
  feature(ENT.buildingIssueByAnyone),
  validate({ query: s.similar }),
  c.similar,
);
