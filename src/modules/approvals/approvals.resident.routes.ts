import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { ENT, PERM } from './approvals.constants';
import { inboxController as c } from './approvals.inbox.controller';
import { inboxSchemas as s } from './approvals.inbox.validation';

/** 8.19 resident endpoints. */
export const approvalsResidentRoutes = Router();
const r = approvalsResidentRoutes;
const society = () => societyMiddleware();
const view = [PERM.residentRequestsView, PERM.residentAmenitiesView] as const;
const create = [PERM.residentRequestsCreate, PERM.residentAmenitiesCreate] as const;

r.get(
  '/me/approval-requests',
  society(),
  can(...view),
  feature(ENT.unifiedInbox, { mode: 'read' }),
  validate({ query: s.residentList }),
  c.meList,
);
r.get(
  '/me/approval-requests/:id',
  society(),
  can(...view),
  feature(ENT.unifiedInbox, { mode: 'read' }),
  validate({ params: s.idParam }),
  c.meGet,
);
r.post(
  '/me/approval-requests/:id/cancel',
  society(),
  can(...create),
  feature(ENT.unifiedInbox),
  validate({ params: s.idParam, body: s.cancel }),
  idempotency(),
  c.meCancel,
);
