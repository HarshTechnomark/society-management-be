import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { routeMeta } from '../societies/societies.guard';
import { tag } from '../access-control/access-control.registry';
import { residentController as c } from './residents.controller';
import { residentSchemas as s } from './residents.validation';
import { FEATURE as F } from './residents.constants';

/**
 * Module 09 routes, part 1 (section 8.1): residents, unit links, documents, import and export, flats, timeline and
 * statistics, pets register, SOS emergency profiles, and the resident app routes of the household, own emergency profile,
 * privacy, directory, documents, pets and portfolio. Order on a route: society marker, permission, entitlement, validate,
 * step-up, idempotency. Fixed paths come before `/:id`. No route is allow-listed for a suspended or closed society (BR-09-74).
 * Join requests, tenancies, moves, renovation permits and ownership transfers (parts 2 and 3) mount their own routers.
 */
const society = () => societyMiddleware();
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const noSupport = (): RequestHandler => routeMeta({ noSupportAccess: true });
const read = { mode: 'read' } as const;
const perUser = (name: string, limit: number, windowSeconds: number) =>
  rateLimit({ name, limit, windowSeconds, key: req => String(req.ctx.user?.id ?? '') || null });

export const residentsRoutes = Router();
const r = residentsRoutes;

// ---- flats, timeline, statistics, export, import (fixed paths first)
r.get(
  '/residents',
  society(),
  can('residents.people.view'),
  feature(F.registry, read),
  validate({ query: s.residentList }),
  c.list,
);
r.get(
  '/residents/units',
  society(),
  can('residents.people.view'),
  feature(F.occupancy, read),
  validate({ query: s.flatList }),
  c.listFlats,
);
r.get(
  '/residents/units/:unitId',
  society(),
  can('residents.people.view'),
  feature(F.registry, read),
  validate({ params: s.unitParam, query: s.revealQuery }),
  c.unitPanel,
);
r.get(
  '/residents/units/:unitId/timeline',
  society(),
  can('residents.people.view'),
  feature(F.timeline, read),
  validate({ params: s.unitParam }),
  c.timeline,
);
r.put(
  '/residents/units/:unitId/ownership-shares',
  society(),
  can('residents.people.edit'),
  feature(F.jointOwnership),
  validate({ params: s.unitParam, body: s.shares }),
  c.shares,
);
r.post(
  '/residents/units/:unitId/vacate',
  society(),
  can('residents.people.edit'),
  feature(F.occupancy),
  validate({ params: s.unitParam, body: s.vacate }),
  c.vacate,
);
r.get('/residents/stats', society(), can('residents.people.view'), feature(F.analytics, read), c.stats);
r.get(
  '/residents/export',
  noSupport(),
  society(),
  can('residents.people.export'),
  feature(F.registry, read),
  validate({ query: s.residentExport }),
  stepUp(),
  perUser('residents-export', 10, 3600),
  c.exportCsv,
);
r.post(
  '/residents/import',
  noSupport(),
  society(),
  can('residents.people.import'),
  feature(F.bulkImport),
  validate({ body: s.importStart }),
  idempotency(),
  c.startImport,
);
r.get(
  '/residents/import/:jobId',
  noSupport(),
  society(),
  can('residents.people.import'),
  feature(F.bulkImport, read),
  validate({ params: s.importParam }),
  c.getImport,
);
r.post(
  '/residents',
  society(),
  can('residents.people.create'),
  feature(F.registry),
  validate({ body: s.residentCreate }),
  idempotency(),
  c.create,
);
r.patch(
  '/residents/links/:linkId',
  society(),
  can('residents.people.edit'),
  feature(F.registry),
  validate({ params: s.linkParam, body: s.linkPatch }),
  c.patchLink,
);
r.post(
  '/residents/links/:linkId/end',
  society(),
  can('residents.people.edit'),
  feature(F.registry),
  validate({ params: s.linkParam, body: s.linkEnd }),
  c.endLink,
);

// ---- one resident
r.get(
  '/residents/:id',
  society(),
  can('residents.people.view'),
  feature(F.registry, read),
  validate({ params: s.idParam, query: s.revealQuery }),
  c.get,
);
r.patch(
  '/residents/:id',
  society(),
  can('residents.people.edit'),
  feature(F.registry),
  validate({ params: s.idParam, body: s.residentPatch }),
  c.patch,
);
r.delete(
  '/residents/:id',
  society(),
  can('residents.people.delete'),
  feature(F.registry),
  validate({ params: s.idParam, body: s.residentDelete }),
  stepUp(),
  c.remove,
);
r.post(
  '/residents/:id/invite',
  society(),
  can('residents.people.create'),
  feature(F.invitations),
  validate({ params: s.idParam, body: s.residentInvite }),
  idempotency(),
  c.invite,
);
r.post(
  '/residents/:id/links',
  society(),
  can('residents.people.create'),
  feature(F.registry),
  validate({ params: s.idParam, body: s.linkCreate }),
  idempotency(),
  c.addLink,
);
r.get(
  '/residents/:id/documents',
  society(),
  can('residents.people.view'),
  feature(F.kyc, read),
  validate({ params: s.idParam }),
  c.listDocs,
);
r.post(
  '/residents/:id/documents',
  society(),
  can('residents.people.create'),
  feature(F.kyc),
  validate({ params: s.idParam, body: s.docCreate }),
  idempotency(),
  c.addDoc,
);

// ---- documents
r.post(
  '/resident-documents/:docId/verify',
  society(),
  can('residents.people.approve'),
  feature(F.kyc),
  validate({ params: s.docParam, body: s.docVerify }),
  c.verifyDoc,
);
r.delete(
  '/resident-documents/:docId',
  society(),
  can('residents.people.delete'),
  feature(F.kyc),
  validate({ params: s.docParam, body: s.docDelete }),
  c.deleteDoc,
);
r.get(
  '/resident-documents/:docId/download-url',
  noSupport(),
  society(),
  can('residents.people.view', 'resident.home.view'),
  feature(F.kyc, read),
  validate({ params: s.docParam, query: s.download }),
  c.docUrl,
);

// ---- pets register and SOS cards
r.get(
  '/pets',
  society(),
  can('residents.people.view'),
  feature(F.pets, read),
  validate({ query: s.petList }),
  c.listPets,
);
r.get(
  '/sos/:sosId/emergency-profiles',
  society(),
  can('security.incidents.view'),
  feature(F.emergency, read),
  validate({ params: s.sosParam }),
  c.sosProfiles,
);
r.get(
  '/gate/sos/:sosId/emergency-profiles',
  society(),
  can('gate.sos.create'),
  feature(F.emergency, read),
  validate({ params: s.sosParam }),
  c.sosProfiles,
);

// ---- resident app (`/me/*`, limited to ctx.unitIds in the services)
r.get('/me/household', society(), can('resident.household.view'), feature(F.registry, read), c.myHousehold);
r.post(
  '/me/household/members',
  society(),
  can('resident.household.create'),
  feature(F.family),
  validate({ body: s.memberCreate }),
  idempotency(),
  c.addMember,
);
r.patch(
  '/me/household/members/:linkId',
  society(),
  can('resident.household.edit'),
  feature(F.family),
  validate({ params: s.linkParam, body: s.memberPatch }),
  c.patchMember,
);
r.delete(
  '/me/household/members/:linkId',
  society(),
  can('resident.household.delete'),
  feature(F.family),
  validate({ params: s.linkParam, body: s.memberDelete }),
  c.removeMember,
);
r.post(
  '/me/household/members/:linkId/invite',
  society(),
  can('resident.household.create'),
  feature(F.invitations),
  validate({ params: s.linkParam, body: s.residentInvite }),
  idempotency(),
  c.inviteMember,
);
r.put(
  '/me/household/members/:linkId/emergency-profile',
  society(),
  can('resident.household.edit'),
  feature(F.emergency),
  validate({ params: s.linkParam, body: s.emergencyPut }),
  c.memberEmergency,
);
r.get('/me/portfolio', society(), can('resident.household.view'), feature(F.portfolio, read), c.portfolio);
r.get('/me/pets', society(), can('resident.home.view'), feature(F.pets, read), c.myPets);
r.post(
  '/me/pets',
  society(),
  can('resident.household.create'),
  feature(F.pets),
  validate({ body: s.petCreate }),
  idempotency(),
  c.createPet,
);
r.patch(
  '/me/pets/:id',
  society(),
  can('resident.household.edit'),
  feature(F.pets),
  validate({ params: s.idParam, body: s.petPatch }),
  c.patchPet,
);
r.delete(
  '/me/pets/:id',
  society(),
  can('resident.household.delete'),
  feature(F.pets),
  validate({ params: s.idParam, body: s.empty }),
  c.deletePet,
);
r.get(
  '/me/emergency-profile',
  society(),
  can('resident.home.view'),
  feature(F.emergency, read),
  c.myEmergency,
);
r.put(
  '/me/emergency-profile',
  society(),
  can('resident.home.view'),
  feature(F.emergency),
  validate({ body: s.emergencyPut }),
  c.saveMyEmergency,
);
r.get('/me/privacy', society(), can('resident.home.view'), feature(F.registry, read), c.getPrivacy);
r.patch(
  '/me/privacy',
  society(),
  can('resident.home.view'),
  feature(F.registry),
  validate({ body: s.privacyPatch }),
  c.patchPrivacy,
);
r.get(
  '/me/directory',
  society(),
  can('resident.community.view'),
  feature(F.directory, read),
  validate({ query: s.directory }),
  perUser('residents-directory', 60, 60),
  c.directory,
);
r.get('/me/documents', society(), can('resident.home.view'), feature(F.kyc, read), c.myDocs);
r.post(
  '/me/documents',
  society(),
  can('resident.home.view'),
  feature(F.kyc),
  validate({ body: s.selfDocCreate }),
  idempotency(),
  c.addMyDoc,
);
r.get(
  '/me/documents/:docId/download-url',
  noSupport(),
  society(),
  can('resident.home.view'),
  feature(F.kyc, read),
  validate({ params: s.docParam, query: s.download }),
  c.myDocUrl,
);
