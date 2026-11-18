import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './helpdesk.constants';
import { meController as c } from './helpdesk.me.controller';
import { meSchemas as s } from './helpdesk.me.validation';

/**
 * Resident routes `/me/tickets*`, `/me/building-issues*`, `/me/helpdesk/transparency` (8.10, 8.11, 8.17, 8.18, 8.22 to 8.28) and the guard and staff building-issue
 * routes `/gate/building-issues*`, `/work/building-issues*`. BR-15-66: building issues are a safety channel, so the routes that report, comment and
 * agree stay open while the society is SUSPENDED (the shared comment and upvote services refuse personal complaints themselves).
 */
export const helpdeskMeRoutes = Router();
const r = helpdeskMeRoutes;
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const open = () => routeMeta({ suspended: 'allow' });

// ---- lists, detail, personal complaint
r.get(
  '/me/tickets',
  society(),
  can(PERM.residentView),
  feature(ENT.raiseTicket, read),
  validate({ query: s.list }),
  c.list,
);
r.post(
  '/me/tickets',
  society(),
  can(PERM.residentCreate),
  feature(ENT.raiseTicket),
  validate({ body: s.personal }),
  idempotency(),
  c.create,
);

// ---- building issues (fixed paths before the `:id` routes)
r.get(
  '/me/building-issues',
  society(),
  can(PERM.residentView),
  feature(ENT.affectedResidentsUpdates, read),
  validate({ query: s.buildingList }),
  c.buildingList,
);
r.post(
  '/me/building-issues',
  open(),
  society(),
  can(PERM.residentCreate),
  feature(ENT.buildingIssueByAnyone),
  validate({ body: s.buildingIssue }),
  idempotency(),
  c.report,
);
r.get(
  '/me/building-issues/similar',
  society(),
  can(PERM.residentCreate),
  feature(ENT.buildingIssueByAnyone, read),
  validate({ query: s.similar }),
  c.similar,
);
r.get(
  '/me/building-issues/qr/:qrToken',
  society(),
  can(PERM.residentCreate),
  feature(ENT.qr, read),
  validate({ params: s.qrParam }),
  c.qr,
);
r.get(
  '/me/helpdesk/transparency',
  society(),
  can(PERM.residentView),
  feature(ENT.transparencyBoard, read),
  validate({ query: s.transparency }),
  c.transparency,
);

// ---- one ticket
r.get(
  '/me/tickets/:id',
  society(),
  can(PERM.residentView),
  feature(ENT.affectedResidentsUpdates, read),
  validate({ params: s.idParam }),
  c.get,
);
r.post(
  '/me/tickets/:id/upvote',
  open(),
  society(),
  can(PERM.residentCreate),
  feature(ENT.buildingIssueByAnyone),
  validate({ params: s.idParam, body: s.upvote }),
  idempotency(),
  c.upvote,
);
r.delete(
  '/me/tickets/:id/upvote',
  open(),
  society(),
  can(PERM.residentCreate),
  feature(ENT.buildingIssueByAnyone),
  validate({ params: s.idParam }),
  c.removeUpvote,
);
r.get(
  '/me/tickets/:id/comments',
  society(),
  can(PERM.residentView),
  feature(ENT.affectedResidentsUpdates, read),
  validate({ params: s.idParam, query: s.comments }),
  c.comments,
);
r.post(
  '/me/tickets/:id/comments',
  open(),
  society(),
  can(PERM.residentEdit),
  feature(ENT.affectedResidentsUpdates),
  validate({ params: s.idParam, body: s.comment }),
  idempotency(),
  c.addComment,
);
r.get(
  '/me/tickets/:id/files/:fileId/download-url',
  society(),
  can(PERM.residentView),
  feature(ENT.affectedResidentsUpdates, read),
  validate({ params: s.fileParam, query: s.download }),
  c.fileUrl,
);
r.post(
  '/me/tickets/:id/confirm',
  society(),
  can(PERM.residentEdit),
  feature(ENT.raiseTicket),
  validate({ params: s.idParam, body: s.confirm }),
  c.confirm,
);
r.post(
  '/me/tickets/:id/rating',
  society(),
  can(PERM.residentEdit),
  feature(ENT.csat),
  validate({ params: s.idParam, body: s.rating }),
  c.rating,
);
r.post(
  '/me/tickets/:id/reopen',
  society(),
  can(PERM.residentEdit),
  feature(ENT.raiseTicket),
  validate({ params: s.idParam, body: s.reopen }),
  c.reopen,
);
r.post(
  '/me/tickets/:id/cancel',
  society(),
  can(PERM.residentEdit),
  feature(ENT.raiseTicket),
  validate({ params: s.idParam, body: s.cancel }),
  c.cancel,
);
r.post(
  '/me/tickets/:id/escalate',
  society(),
  can(PERM.residentEdit),
  feature(ENT.escalationMatrix),
  validate({ params: s.idParam, body: s.escalate }),
  c.escalate,
);
r.post(
  '/me/tickets/:id/estimate-decision',
  society(),
  can(PERM.residentEdit),
  feature(ENT.chargeableWork),
  validate({ params: s.idParam, body: s.estimate }),
  c.estimate,
);

// ---- guard and staff apps
r.post(
  '/gate/building-issues',
  open(),
  society(),
  can(PERM.gateBuildingIssues),
  feature(ENT.buildingIssueByAnyone),
  validate({ body: s.buildingIssue }),
  idempotency(),
  c.gateReport,
);
r.get(
  '/gate/building-issues/similar',
  society(),
  can(PERM.gateBuildingIssues),
  feature(ENT.buildingIssueByAnyone, read),
  validate({ query: s.similar }),
  c.gateSimilar,
);
r.post(
  '/work/building-issues',
  open(),
  society(),
  can(PERM.workBuildingIssues),
  feature(ENT.buildingIssueByAnyone),
  validate({ body: s.buildingIssue }),
  idempotency(),
  c.workReport,
);
r.get(
  '/work/building-issues/similar',
  society(),
  can(PERM.workBuildingIssues),
  feature(ENT.buildingIssueByAnyone, read),
  validate({ query: s.similar }),
  c.workSimilar,
);
