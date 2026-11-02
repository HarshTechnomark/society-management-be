import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok, okList } from '../../utils/response';
import * as profile from './society-setup.profile.service';
import * as settings from './society-setup.settings.service';
import * as buildings from './society-setup.buildings.service';
import * as units from './society-setup.units.service';
import * as generator from './society-setup.generator.service';
import * as locations from './society-setup.locations.service';
import * as holidays from './society-setup.holidays.service';
import * as onboarding from './society-setup.onboarding.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const pid = (req: Request): number => req.valid.params.id;
const sid = (req: Request): number => req.ctx.society!.id;

export const setupController = {
  // ---- profile and settings (8.2 to 8.5)
  getProfile: h(async (req, res) => ok(res, await profile.getProfile(req.ctx, sid(req)))),
  updateProfile: h(async (req, res) =>
    ok(res, await profile.updateProfile(req.ctx, sid(req), v(req).body), 'Society saved'),
  ),
  listSettings: h(async (req, res) =>
    ok(res, await settings.listView(req.ctx, sid(req), v(req).query.namespace)),
  ),
  saveSettings: h(async (req, res) =>
    ok(res, await settings.saveFromRoute(req.ctx, sid(req), v(req).body), 'Settings saved'),
  ),

  // ---- buildings (8.6 to 8.9)
  listBuildings: h(async (req, res) => {
    const r = await buildings.listBuildings(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  getBuilding: h(async (req, res) => ok(res, await buildings.getBuilding(sid(req), pid(req)))),
  buildingGrid: h(async (req, res) =>
    ok(res, await buildings.getGrid(sid(req), pid(req), v(req).query.includeArchived)),
  ),
  createBuilding: h(async (req, res) =>
    created(res, await buildings.createBuilding(req.ctx, sid(req), v(req).body), 'Building created'),
  ),
  updateBuilding: h(async (req, res) =>
    ok(res, await buildings.patchBuilding(req.ctx, sid(req), pid(req), v(req).body), 'Building saved'),
  ),
  archiveBuilding: h(async (req, res) =>
    ok(res, await buildings.archiveBuilding(req.ctx, sid(req), pid(req), v(req).body), 'Building archived'),
  ),
  restoreBuilding: h(async (req, res) =>
    ok(res, await buildings.restoreBuilding(req.ctx, sid(req), pid(req), v(req).body), 'Building restored'),
  ),
  deleteBuilding: h(async (req, res) => {
    await buildings.deleteBuilding(req.ctx, sid(req), pid(req));
    noContent(res);
  }),

  // ---- units (8.10 to 8.14)
  listUnits: h(async (req, res) => {
    const r = await units.listUnits(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  getUnit: h(async (req, res) => ok(res, await units.getUnit(sid(req), pid(req)))),
  createUnit: h(async (req, res) =>
    created(res, await units.createUnit(req.ctx, sid(req), v(req).body), 'Unit created'),
  ),
  updateUnit: h(async (req, res) =>
    ok(res, await units.patchUnit(req.ctx, sid(req), pid(req), v(req).body), 'Unit saved'),
  ),
  archiveUnit: h(async (req, res) =>
    ok(res, await units.archiveUnit(req.ctx, sid(req), pid(req), v(req).body), 'Unit archived'),
  ),
  restoreUnit: h(async (req, res) =>
    ok(res, await units.restoreUnit(req.ctx, sid(req), pid(req), v(req).body), 'Unit restored'),
  ),
  deleteUnit: h(async (req, res) => {
    await units.deleteUnit(req.ctx, sid(req), pid(req));
    noContent(res);
  }),
  bulkUpdate: h(async (req, res) =>
    ok(res, await units.bulkUpdate(req.ctx, sid(req), v(req).body), 'Units updated'),
  ),
  generatorPreview: h(async (req, res) =>
    ok(res, await generator.preview(req.ctx, sid(req), v(req).body), 'Preview ready'),
  ),
  generatorCommit: h(async (req, res) =>
    created(res, await generator.commit(req.ctx, sid(req), v(req).body), 'Units created'),
  ),

  // ---- locations (8.19 to 8.21)
  listLocations: h(async (req, res) => {
    const q = v(req).query;
    ok(
      res,
      {
        items: await locations.listTree(sid(req), {
          includeArchived: q.status === 'ALL',
          buildingId: q.buildingId,
          areaType: q.areaType,
          rootOnly: q.rootOnly,
        }),
      },
      'OK',
    );
  }),
  getLocation: h(async (req, res) => ok(res, await locations.getNodeOrThrow(sid(req), pid(req)))),
  createLocation: h(async (req, res) =>
    created(res, await locations.createNode(req.ctx, sid(req), v(req).body), 'Location created'),
  ),
  updateLocation: h(async (req, res) =>
    ok(res, await locations.patchNode(req.ctx, sid(req), pid(req), v(req).body), 'Location saved'),
  ),
  archiveLocation: h(async (req, res) =>
    ok(
      res,
      await locations.archiveNode(req.ctx, sid(req), pid(req), v(req).body.version),
      'Location archived',
    ),
  ),
  restoreLocation: h(async (req, res) =>
    ok(
      res,
      await locations.restoreNode(req.ctx, sid(req), pid(req), v(req).body.version),
      'Location restored',
    ),
  ),
  regenerateQr: h(async (req, res) =>
    ok(
      res,
      await locations.regenerateQr(req.ctx, sid(req), pid(req), v(req).body.version),
      'New QR code issued',
    ),
  ),

  // ---- holidays (8.22)
  listHolidays: h(async (req, res) => ok(res, await holidays.listYear(sid(req), v(req).query.year))),
  holidaySuggestions: h(async (req, res) => ok(res, await holidays.suggestions(sid(req), v(req).query.year))),
  createHoliday: h(async (req, res) =>
    created(res, await holidays.createHoliday(req.ctx, sid(req), v(req).body), 'Holiday added'),
  ),
  bulkHolidays: h(async (req, res) =>
    created(res, await holidays.bulkCreate(req.ctx, sid(req), v(req).body.items), 'Holidays added'),
  ),
  updateHoliday: h(async (req, res) =>
    ok(res, await holidays.patchHoliday(req.ctx, sid(req), pid(req), v(req).body), 'Holiday saved'),
  ),
  deleteHoliday: h(async (req, res) => {
    await holidays.deleteHoliday(req.ctx, sid(req), pid(req));
    noContent(res);
  }),

  // ---- onboarding (8.23 to 8.25)
  getOnboarding: h(async (req, res) => ok(res, await onboarding.getView(sid(req)))),
  completeStep: h(async (req, res) =>
    ok(res, await onboarding.completeStep(req.ctx, sid(req), v(req).params.stepKey), 'Step completed'),
  ),
  skipStep: h(async (req, res) =>
    ok(
      res,
      await onboarding.skipStep(req.ctx, sid(req), v(req).params.stepKey, v(req).body.reason),
      'Step skipped',
    ),
  ),
  reopenStep: h(async (req, res) =>
    ok(res, await onboarding.reopenStep(req.ctx, sid(req), v(req).params.stepKey), 'Step reopened'),
  ),
  goLive: h(async (req, res) => ok(res, await onboarding.goLive(req.ctx, sid(req)), 'The society is live')),
};
