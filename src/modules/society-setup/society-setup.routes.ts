import { Router, type Request, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { routeMeta } from '../societies/societies.guard';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { setupController as c } from './society-setup.controller';
import { setupSchemas as s } from './society-setup.validation';
import { ALL_EDIT_PERMISSIONS, ALL_VIEW_PERMISSIONS } from './society-setup.settings-registry';
import { needsStepUp } from './society-setup.settings.service';
import { changesLegalField } from './society-setup.profile.service';
import { FEATURE as F } from './society-setup.types';

/**
 * Module 08 routes (section 8.1), part 1: profile, settings, buildings, units, generator, locations, holidays and
 * onboarding. Order on a route: society marker, permission, entitlement, validate, step-up, idempotency, controller.
 * Fixed paths (`/units/generator/*`, `/units/bulk-update`, `/holidays/suggestions`, `/holidays/bulk`) come before `/:id`.
 * No route is allow-listed for a suspended or closed society (BR-08-48). Part 2 adds `/units/imports*` and `/units/export`.
 */
const society = () => societyMiddleware();
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
/** Step-up when the (possibly async) predicate says the request touches a protected value. */
const stepUpIf = (pred: (req: Request) => Promise<boolean> | boolean): RequestHandler => {
  const inner = requireRecentAuth();
  return tag(
    async (req, res, next) => {
      try {
        if (await pred(req)) return inner(req, res, next);
        next();
      } catch (err) {
        next(err);
      }
    },
    { stepUp: true },
  );
};
/** A support grant never deletes (module 05 section 6.4 and module 08 section 13); unit delete is out of reach by permission. */
const noSupport = (): RequestHandler => routeMeta({ noSupportAccess: true });
const read = { mode: 'read' } as const;

export const societySetupRoutes = Router();
const r = societySetupRoutes;

// ---- society profile (8.2, 8.3)
r.get('/society', society(), can('settings.society.view'), feature(F.profile, read), c.getProfile);
r.patch(
  '/society',
  society(),
  can('settings.society.edit'),
  feature(F.profile),
  validate({ body: s.profileUpdate }),
  stepUpIf(req => changesLegalField(req.ctx.society!.id, req.valid.body)),
  c.updateProfile,
);

// ---- settings (8.4, 8.5): the route needs some view / edit permission; the service checks every key's namespace
r.get(
  '/society/settings',
  society(),
  can(...ALL_VIEW_PERMISSIONS),
  feature(F.settings, read),
  validate({ query: s.settingsQuery }),
  c.listSettings,
);
r.patch(
  '/society/settings',
  society(),
  can(...ALL_EDIT_PERMISSIONS),
  feature(F.settings),
  validate({ body: s.settingsPatch }),
  stepUpIf(req => needsStepUp(req.valid.body.changes)),
  c.saveSettings,
);

// ---- buildings (8.6 to 8.9)
r.get(
  '/buildings',
  society(),
  can('residents.units.view'),
  feature(F.hierarchy, read),
  validate({ query: s.buildingList }),
  c.listBuildings,
);
r.get(
  '/buildings/:id',
  society(),
  can('residents.units.view'),
  feature(F.hierarchy, read),
  validate({ params: s.idParam }),
  c.getBuilding,
);
r.get(
  '/buildings/:id/grid',
  society(),
  can('residents.units.view'),
  feature(F.hierarchy, read),
  validate({ params: s.idParam, query: s.gridQuery }),
  c.buildingGrid,
);
r.post(
  '/buildings',
  society(),
  can('settings.society.edit'),
  feature(F.hierarchy),
  validate({ body: s.buildingCreate }),
  idempotency(),
  c.createBuilding,
);
r.patch(
  '/buildings/:id',
  society(),
  can('settings.society.edit'),
  feature(F.hierarchy),
  validate({ params: s.idParam, body: s.buildingPatch }),
  c.updateBuilding,
);
r.post(
  '/buildings/:id/archive',
  society(),
  can('settings.society.edit'),
  feature(F.hierarchy),
  validate({ params: s.idParam, body: s.archiveBody }),
  c.archiveBuilding,
);
r.post(
  '/buildings/:id/restore',
  society(),
  can('settings.society.edit'),
  feature(F.hierarchy),
  validate({ params: s.idParam, body: s.versionBody }),
  c.restoreBuilding,
);
r.delete(
  '/buildings/:id',
  noSupport(),
  society(),
  can('settings.society.edit'),
  feature(F.hierarchy),
  validate({ params: s.idParam }),
  stepUp(),
  c.deleteBuilding,
);

// ---- units (8.10 to 8.14)
r.get(
  '/units',
  society(),
  can('residents.units.view'),
  feature(F.registry, read),
  validate({ query: s.unitList }),
  c.listUnits,
);
r.post(
  '/units/bulk-update',
  society(),
  can('residents.units.edit'),
  feature(F.registry),
  validate({ body: s.bulkUpdate }),
  c.bulkUpdate,
);
r.post(
  '/units/generator/preview',
  society(),
  can('residents.units.create'),
  feature(F.generator),
  validate({ body: s.generatorPreview }),
  rateLimit({
    name: 'setup-generator-preview',
    limit: 60,
    windowSeconds: 60,
    key: req => String(req.ctx.user?.id),
  }),
  c.generatorPreview,
);
r.post(
  '/units/generator/commit',
  society(),
  can('residents.units.create'),
  feature(F.generator),
  validate({ body: s.generatorCommit }),
  idempotency(),
  c.generatorCommit,
);
r.post(
  '/units',
  society(),
  can('residents.units.create'),
  feature(F.registry),
  validate({ body: s.unitCreate }),
  idempotency(),
  c.createUnit,
);
r.get(
  '/units/:id',
  society(),
  can('residents.units.view'),
  feature(F.registry, read),
  validate({ params: s.idParam }),
  c.getUnit,
);
r.patch(
  '/units/:id',
  society(),
  can('residents.units.edit'),
  feature(F.registry),
  validate({ params: s.idParam, body: s.unitPatch }),
  c.updateUnit,
);
r.post(
  '/units/:id/archive',
  society(),
  can('residents.units.edit'),
  feature(F.registry),
  validate({ params: s.idParam, body: s.archiveBody }),
  c.archiveUnit,
);
r.post(
  '/units/:id/restore',
  society(),
  can('residents.units.edit'),
  feature(F.registry),
  validate({ params: s.idParam, body: s.versionBody }),
  c.restoreUnit,
);
r.delete(
  '/units/:id',
  society(),
  can('residents.units.delete'),
  feature(F.registry),
  validate({ params: s.idParam }),
  stepUp(),
  c.deleteUnit,
);

// ---- locations (8.19 to 8.21)
r.get(
  '/locations',
  society(),
  can('residents.units.view'),
  feature(F.commonAreas, read),
  validate({ query: s.locationQuery }),
  c.listLocations,
);
r.post(
  '/locations',
  society(),
  can('settings.society.edit'),
  feature(F.commonAreas),
  validate({ body: s.locationCreate }),
  idempotency(),
  c.createLocation,
);
r.get(
  '/locations/:id',
  society(),
  can('residents.units.view'),
  feature(F.commonAreas, read),
  validate({ params: s.idParam }),
  c.getLocation,
);
r.patch(
  '/locations/:id',
  society(),
  can('settings.society.edit'),
  feature(F.commonAreas),
  validate({ params: s.idParam, body: s.locationPatch }),
  c.updateLocation,
);
r.post(
  '/locations/:id/archive',
  society(),
  can('settings.society.edit'),
  feature(F.commonAreas),
  validate({ params: s.idParam, body: s.versionBody }),
  c.archiveLocation,
);
r.post(
  '/locations/:id/restore',
  society(),
  can('settings.society.edit'),
  feature(F.commonAreas),
  validate({ params: s.idParam, body: s.versionBody }),
  c.restoreLocation,
);
r.post(
  '/locations/:id/regenerate-qr',
  society(),
  can('settings.society.edit'),
  feature(F.qr),
  validate({ params: s.idParam, body: s.versionBody }),
  c.regenerateQr,
);

// ---- holidays (8.22)
r.get(
  '/holidays',
  society(),
  can('settings.society.view'),
  feature(F.settings, read),
  validate({ query: s.holidayYear }),
  c.listHolidays,
);
r.get(
  '/holidays/suggestions',
  society(),
  can('settings.society.view'),
  feature(F.settings, read),
  validate({ query: s.holidayYear }),
  c.holidaySuggestions,
);
r.post(
  '/holidays/bulk',
  society(),
  can('settings.society.edit'),
  feature(F.settings),
  validate({ body: s.holidayBulk }),
  idempotency(),
  c.bulkHolidays,
);
r.post(
  '/holidays',
  society(),
  can('settings.society.edit'),
  feature(F.settings),
  validate({ body: s.holidayCreate }),
  idempotency(),
  c.createHoliday,
);
r.patch(
  '/holidays/:id',
  society(),
  can('settings.society.edit'),
  feature(F.settings),
  validate({ params: s.idParam, body: s.holidayPatch }),
  c.updateHoliday,
);
r.delete(
  '/holidays/:id',
  noSupport(),
  society(),
  can('settings.society.edit'),
  feature(F.settings),
  validate({ params: s.idParam }),
  c.deleteHoliday,
);

// ---- onboarding (8.23 to 8.25): no entitlement, a society must always be able to finish setup
r.get('/onboarding', society(), can('settings.society.view'), c.getOnboarding);
r.post(
  '/onboarding/steps/:stepKey/complete',
  society(),
  can('settings.society.edit'),
  validate({ params: s.stepParam, body: s.empty }),
  c.completeStep,
);
r.post(
  '/onboarding/steps/:stepKey/skip',
  society(),
  can('settings.society.edit'),
  validate({ params: s.stepParam, body: s.skipBody }),
  c.skipStep,
);
r.post(
  '/onboarding/steps/:stepKey/reopen',
  society(),
  can('settings.society.edit'),
  validate({ params: s.stepParam, body: s.empty }),
  c.reopenStep,
);
r.post(
  '/onboarding/go-live',
  society(),
  can('settings.society.edit'),
  validate({ body: s.empty }),
  idempotency(),
  c.goLive,
);
