import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { ENT, PERM } from './approvals.constants';
import { inboxController as c } from './approvals.inbox.controller';
import { VIEW_PERMS } from './approvals.inbox.routes';
import { inboxSchemas as s } from './approvals.inbox.validation';

/** 8.5 `GET /approvals/history`: every request of one entity the caller may see. Mounted before the `/:id` routes. */
export const approvalsHistoryRoutes = Router();

approvalsHistoryRoutes.get(
  '/approvals/history',
  societyMiddleware(),
  can(PERM.inboxView, ...VIEW_PERMS),
  feature(ENT.unifiedInbox, { mode: 'read' }),
  validate({ query: s.history }),
  c.history,
);
