import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { ApprovalRequest } from '../../models';
import { NotFoundError } from '../../utils/errors';
import { tag } from '../access-control/access-control.registry';
import { CATALOGUE } from './approvals.catalogue';
import { ENT, ERR, PERM } from './approvals.constants';
import { inboxController as c } from './approvals.inbox.controller';
import { inboxSchemas as s } from './approvals.inbox.validation';

/**
 * 14.2a routes (8.1 to 8.11). Order on a route: society marker, permission, entitlement, validate, step-up, idempotency.
 * Fixed paths come before `/:id`; `/:id` handlers skip non-numeric ids (`next('route')`) so the rules, settings and delegations
 * routers of 14.2b answer `/approvals/rules` and the like whatever the mount order.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const numeric: RequestHandler = (req, _res, next) =>
  /^[1-9]\d{0,18}$/.test(req.params.id ?? '') ? next() : next('route');

const unique = (xs: string[]): string[] => [...new Set(xs)];
const all = Object.values(CATALOGUE);
/** Permissions of "any type request permission" and "any type view permission" (section 8). */
export const REQUEST_PERMS = unique(all.map(m => m.requestPermission));
export const VIEW_PERMS = unique(all.map(m => m.viewPermission));

/**
 * `approvalStepUpGuard` (8.7): loads the request (society-scoped) and runs `requireRecentAuth` only when `stepUpRequired = 1`.
 * Reject, request changes and cancel never need step-up.
 */
export const approvalStepUpGuard: RequestHandler = tag(
  async (req, res, next) => {
    try {
      const row = await ApprovalRequest.findOne({
        where: { id: req.valid.params.id, societyId: req.ctx.society!.id },
        attributes: ['id', 'stepUpRequired'],
      });
      if (!row) throw new NotFoundError(ERR.notFound, 'Approval request not found');
      if (!row.stepUpRequired) return next();
      return requireRecentAuth()(req, res, next);
    } catch (err) {
      next(err);
    }
  },
  { stepUp: true },
);

export const approvalsInboxRoutes = Router();
const r = approvalsInboxRoutes;
const inbox = PERM.inboxView;
const feat = () => feature(ENT.unifiedInbox);
const featRead = () => feature(ENT.unifiedInbox, read);

r.get('/approvals', society(), can(inbox), featRead(), validate({ query: s.list }), c.list);
r.get('/approvals/counts', society(), can(inbox), featRead(), c.counts);
r.get(
  '/approvals/submitted',
  society(),
  can(inbox, ...REQUEST_PERMS),
  featRead(),
  validate({ query: s.submitted }),
  c.submitted,
);
r.get('/approvals/types', society(), can(inbox, PERM.rulesView), c.types);
r.post(
  '/approvals/bulk-approve',
  society(),
  can(inbox),
  feat(),
  validate({ body: s.bulk }),
  idempotency(),
  c.bulk,
);

r.get(
  '/approvals/:id',
  numeric,
  society(),
  can(inbox, ...REQUEST_PERMS, ...VIEW_PERMS),
  featRead(),
  validate({ params: s.idParam }),
  c.detail,
);
r.post(
  '/approvals/:id/approve',
  numeric,
  society(),
  can(inbox),
  feat(),
  validate({ params: s.idParam, body: s.approve }),
  approvalStepUpGuard,
  idempotency(),
  c.approve,
);
r.post(
  '/approvals/:id/reject',
  numeric,
  society(),
  can(inbox),
  feat(),
  validate({ params: s.idParam, body: s.reject }),
  idempotency(),
  c.reject,
);
r.post(
  '/approvals/:id/request-changes',
  numeric,
  society(),
  can(inbox),
  feat(),
  validate({ params: s.idParam, body: s.reject }),
  idempotency(),
  c.requestChanges,
);
r.post(
  '/approvals/:id/cancel',
  numeric,
  society(),
  can(inbox, ...REQUEST_PERMS),
  feat(),
  validate({ params: s.idParam, body: s.cancel }),
  idempotency(),
  c.cancel,
);
r.post(
  '/approvals/:id/reassign',
  numeric,
  society(),
  can(PERM.rulesEdit),
  feat(),
  validate({ params: s.idParam, body: s.reassign }),
  stepUp(),
  idempotency(),
  c.reassign,
);
