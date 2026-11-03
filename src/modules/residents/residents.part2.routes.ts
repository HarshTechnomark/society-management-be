import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { authenticatedOnly, requirePermission as can } from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { part2Controller as c } from './residents.part2.controller';
import { part2Schemas as s } from './residents.part2.validation';
import { FEATURE as F } from './residents.constants';

/**
 * Module 09 part 2 routes (section 8.1): tenancies, join requests and move requests, with the resident app and gate
 * variants. Same order on a route as part 1: society marker, permission, entitlement, validate, step-up, idempotency.
 * Move routes check the plan feature "by type" (move-in or move-out) in the service. Join routes run `authenticatedOnly()`.
 */
const society = () => societyMiddleware();
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const read = { mode: 'read' } as const;
const perUser = (name: string, limit: number, windowSeconds: number) =>
  rateLimit({ name, limit, windowSeconds, key: req => String(req.ctx.user?.id ?? '') || null });

export const residentsPart2Routes = Router();
const r = residentsPart2Routes;

// ---- tenancies (admin)
r.get(
  '/tenancies',
  society(),
  can('residents.people.view'),
  feature(F.tenancies, read),
  validate({ query: s.tenancyList }),
  c.tenancyList,
);
r.post(
  '/tenancies',
  society(),
  can('residents.people.create'),
  feature(F.tenancies),
  validate({ body: s.tenancyCreate }),
  idempotency(),
  c.tenancyCreate,
);
r.get(
  '/tenancies/:id',
  society(),
  can('residents.people.view'),
  feature(F.tenancies, read),
  validate({ params: s.idParam }),
  c.tenancyGet,
);
r.patch(
  '/tenancies/:id',
  society(),
  can('residents.people.edit'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.tenancyPatch }),
  c.tenancyPatch,
);
r.post(
  '/tenancies/:id/submit',
  society(),
  can('residents.people.edit'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.versionOnly }),
  c.tenancySubmit,
);
r.post(
  '/tenancies/:id/approve',
  society(),
  can('residents.people.approve'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.tenancyApprove }),
  c.tenancyApprove,
);
r.post(
  '/tenancies/:id/reject',
  society(),
  can('residents.people.approve'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.tenancyReject }),
  c.tenancyReject,
);
r.post(
  '/tenancies/:id/activate',
  society(),
  can('residents.people.edit'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.tenancyActivate }),
  c.tenancyActivate,
);
r.post(
  '/tenancies/:id/renew',
  society(),
  can('residents.people.edit'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.tenancyRenew }),
  c.tenancyRenew,
);
r.post(
  '/tenancies/:id/end',
  society(),
  can('residents.people.edit'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.tenancyEnd }),
  c.tenancyEnd,
);
r.post(
  '/tenancies/:id/cancel',
  society(),
  can('residents.people.edit'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.tenancyCancel }),
  c.tenancyCancel,
);
r.patch(
  '/tenancies/:id/police-verification',
  society(),
  can('residents.people.edit'),
  feature('residents.police_verification_tracking'),
  validate({ params: s.idParam, body: s.police }),
  c.police,
);

// ---- join requests (admin)
r.get(
  '/join-requests',
  society(),
  can('residents.requests.view'),
  feature(F.invitations, read),
  validate({ query: s.joinList }),
  c.joinList,
);
r.get(
  '/join-requests/:id',
  society(),
  can('residents.requests.view'),
  feature(F.invitations, read),
  validate({ params: s.idParam }),
  c.joinGet,
);

// ---- join requests (any signed-in user; the society comes from the code)
r.get(
  '/me/join/societies/:code',
  authenticatedOnly(),
  validate({ params: s.codeParam }),
  perUser('join-lookup', 20, 900),
  c.joinSociety,
);
r.get(
  '/me/join/societies/:code/units',
  authenticatedOnly(),
  validate({ params: s.codeParam, query: s.joinUnits }),
  perUser('join-lookup', 20, 900),
  c.joinUnits,
);
r.post(
  '/me/join-requests',
  authenticatedOnly(),
  validate({ body: s.joinCreate }),
  idempotency(),
  c.joinSubmit,
);
r.get('/me/join-requests', authenticatedOnly(), c.joinMine);
r.post(
  '/me/join-requests/:id/withdraw',
  authenticatedOnly(),
  validate({ params: s.idParam, body: s.versionOnly }),
  c.joinWithdraw,
);

// ---- join requests (owner or tenant confirmation, resident app)
r.get(
  '/me/household/join-requests',
  society(),
  can('resident.household.view'),
  feature(F.invitations, read),
  c.joinConfirmList,
);
r.post(
  '/me/household/join-requests/:id/confirm',
  society(),
  can('resident.household.edit'),
  feature(F.invitations),
  validate({ params: s.idParam, body: s.joinConfirm }),
  c.joinConfirm,
);
r.post(
  '/me/household/join-requests/:id/decline',
  society(),
  can('resident.household.edit'),
  feature(F.invitations),
  validate({ params: s.idParam, body: s.joinDecline }),
  c.joinDecline,
);

// ---- tenancies (resident app, owner)
r.get(
  '/me/tenancies',
  society(),
  can('resident.household.view'),
  feature(F.tenancies, read),
  c.myTenancyList,
);
r.post(
  '/me/tenancies',
  society(),
  can('resident.household.create'),
  feature(F.tenancies),
  validate({ body: s.tenancyCreate }),
  idempotency(),
  c.myTenancyCreate,
);
r.get(
  '/me/tenancies/:id',
  society(),
  can('resident.household.view'),
  feature(F.tenancies, read),
  validate({ params: s.idParam }),
  c.myTenancyGet,
);
r.post(
  '/me/tenancies/:id/submit',
  society(),
  can('resident.household.create'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.versionOnly }),
  c.myTenancySubmit,
);
r.post(
  '/me/tenancies/:id/cancel',
  society(),
  can('resident.household.create'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.tenancyCancel }),
  c.myTenancyCancel,
);
r.post(
  '/me/tenancies/:id/documents',
  society(),
  can('resident.household.create'),
  feature(F.tenancies),
  validate({ params: s.idParam, body: s.myTenancyDocs }),
  idempotency(),
  c.myTenancyDocs,
);

// ---- move requests (admin); the plan feature is checked by type in the service
r.get(
  '/move-requests',
  society(),
  can('residents.requests.view'),
  validate({ query: s.moveList }),
  c.moveList,
);
r.post(
  '/move-requests',
  society(),
  can('residents.requests.create'),
  validate({ body: s.moveCreate }),
  idempotency(),
  c.moveCreate,
);
r.get(
  '/move-requests/:id',
  society(),
  can('residents.requests.view'),
  validate({ params: s.idParam }),
  c.moveGet,
);
r.patch(
  '/move-requests/:id',
  society(),
  can('residents.requests.edit'),
  validate({ params: s.idParam, body: s.movePatch }),
  c.movePatch,
);
r.post(
  '/move-requests/:id/recheck-dues',
  society(),
  can('residents.requests.create'),
  validate({ params: s.idParam, body: s.versionOnly }),
  c.moveRecheck,
);
r.post(
  '/move-requests/:id/override-dues',
  society(),
  can('residents.requests.approve'),
  feature('residents.move_out_workflow'),
  validate({ params: s.idParam, body: s.moveOverride }),
  stepUp(),
  c.moveOverride,
);
r.post(
  '/move-requests/:id/start',
  society(),
  can('residents.requests.edit'),
  validate({ params: s.idParam, body: s.moveStart }),
  c.moveStart,
);
r.post(
  '/move-requests/:id/complete',
  society(),
  can('residents.requests.edit'),
  validate({ params: s.idParam, body: s.moveComplete }),
  c.moveComplete,
);
r.post(
  '/move-requests/:id/inspection',
  society(),
  can('residents.requests.edit'),
  validate({ params: s.idParam, body: s.inspection }),
  idempotency(),
  c.moveInspect,
);
r.post(
  '/move-requests/:id/cancel',
  society(),
  can('residents.requests.edit'),
  validate({ params: s.idParam, body: s.moveCancel }),
  c.moveCancel,
);

// ---- move requests (resident app)
r.get('/me/move-requests', society(), can('resident.requests.view'), c.myMoveList);
r.post(
  '/me/move-requests',
  society(),
  can('resident.requests.create'),
  validate({ body: s.moveCreate }),
  idempotency(),
  c.myMoveCreate,
);
r.get(
  '/me/move-requests/:id',
  society(),
  can('resident.requests.view'),
  validate({ params: s.idParam }),
  c.myMoveGet,
);
r.patch(
  '/me/move-requests/:id',
  society(),
  can('resident.requests.create'),
  validate({ params: s.idParam, body: s.movePatch }),
  c.myMovePatch,
);
r.post(
  '/me/move-requests/:id/recheck-dues',
  society(),
  can('resident.requests.create'),
  validate({ params: s.idParam, body: s.versionOnly }),
  c.myMoveRecheck,
);
r.post(
  '/me/move-requests/:id/owner-confirm',
  society(),
  can('resident.household.edit'),
  validate({ params: s.idParam, body: s.versionOnly }),
  c.myMoveConfirm,
);
r.post(
  '/me/move-requests/:id/owner-decline',
  society(),
  can('resident.household.edit'),
  validate({ params: s.idParam, body: s.moveCancel }),
  c.myMoveDecline,
);
r.post(
  '/me/move-requests/:id/cancel',
  society(),
  can('resident.requests.create'),
  validate({ params: s.idParam, body: s.moveCancel }),
  c.myMoveCancel,
);

// ---- move requests (guard console)
r.get(
  '/gate/move-requests',
  society(),
  can('gate.visitors.view'),
  validate({ query: s.gateQuery }),
  c.gateList,
);
r.post(
  '/gate/move-requests/:id/start',
  society(),
  can('gate.visitors.edit'),
  validate({ params: s.idParam, body: s.gateStart }),
  c.gateStart,
);
r.post(
  '/gate/move-requests/:id/complete',
  society(),
  can('gate.visitors.edit'),
  validate({ params: s.idParam, body: s.moveComplete }),
  c.gateComplete,
);
