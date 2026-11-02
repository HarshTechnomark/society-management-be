/**
 * The module 08 functions other modules may import (section 8.30), and the start-up hook `registerSocietySetup()`.
 * Modules 09 to 30 read units, settings, holidays and locations only through this file.
 */
import { setAuthPorts } from '../auth/auth.ports';
import { entitlements } from '../subscriptions/subscriptions.public';
import { setSocietyPorts } from '../societies/societies.ports';
import { registerExportProvider, registerPurgeHandler } from '../societies/societies.public';
import * as unitsSvc from './society-setup.units.service';
import * as settingsSvc from './society-setup.settings.service';
import * as buildingsSvc from './society-setup.buildings.service';
import * as locationsSvc from './society-setup.locations.service';
import * as holidaysSvc from './society-setup.holidays.service';
import * as onboardingSvc from './society-setup.onboarding.service';
import { societySetupExportProvider } from './society-setup.exports';
import { PURGE_TABLES, purgeSocietySetup } from './society-setup.purge';
import { FLATS_LIMIT } from './society-setup.types';
import './society-setup.templates';

export const units = {
  get: unitsSvc.getUnitDto,
  listActive: unitsSvc.listActive,
  /** Countable units (BR-08-20). */
  count: unitsSvc.count,
  getByLabel: unitsSvc.getByLabel,
  lockActive: unitsSvc.lockActive,
  registerUnitGuard: unitsSvc.registerUnitGuard,
};
/** Module 07 dashboard: countable units of the given societies, or of every society. */
export const countUnits = unitsSvc.countUnits;

export const settings = {
  get: settingsSvc.get,
  getMany: settingsSvc.getMany,
  getNamespace: settingsSvc.getNamespace,
  set: settingsSvc.set,
  setMany: settingsSvc.setMany,
};
/** Module 02 port. */
export const societySettings = { getSessionPolicy: settingsSvc.getSessionPolicy };

export const buildings = { list: buildingsSvc.listForSociety };

export const locations = {
  get: (societyId: number, nodeId: number) => locationsSvc.getNode(societyId, nodeId, true),
  listTree: locationsSvc.listTree,
  listGates: locationsSvc.listGates,
  getByQrToken: locationsSvc.getByQrToken,
};

export const holidays = {
  isHoliday: holidaysSvc.isHoliday,
  isWorkingDay: holidaysSvc.isWorkingDay,
  nextWorkingDay: holidaysSvc.nextWorkingDay,
  addWorkingDays: holidaysSvc.addWorkingDays,
  listBetween: holidaysSvc.listBetween,
};

export const onboarding = {
  progressPercent: onboardingSvc.progressPercent,
  isLive: onboardingSvc.isLive,
  registerCheck: onboardingSvc.registerCheck,
  ensureSteps: onboardingSvc.ensureSteps,
  /** Extension point of the go-live transaction (part 2 queues the welcome invites here). */
  registerGoLiveHook: onboardingSvc.registerGoLiveHook,
};

export { setSetupPorts } from './society-setup.ports';
export type { SetupPorts } from './society-setup.ports';
export type {
  UnitDto,
  BuildingDto,
  LocationDto,
  LocationTreeDto,
  HolidayDto,
  UnitGuard,
} from './society-setup.types';
export type { SettingKey, SettingNamespace, SettingValue } from './society-setup.settings-registry';

/**
 * Start-up hook (call after `registerAccessControl()`, `registerSubscriptions()` and `registerSocieties()`; done in
 * `server.ts`, `worker.ts` and `npm run seed`): gives module 02 the real session policy, module 05 the real unit count
 * and onboarding progress, module 04 the `limit.flats` usage provider, and registers the export provider and purge handler.
 */
export function registerSocietySetup(): void {
  setAuthPorts({ societySettings: { getSessionPolicy: settingsSvc.getSessionPolicy } });
  setSocietyPorts({
    units: { count: unitsSvc.count },
    onboarding: { progressPercent: onboardingSvc.progressPercent },
  });
  entitlements.registerUsageProvider(FLATS_LIMIT, unitsSvc.count);
  registerExportProvider(societySetupExportProvider);
  registerPurgeHandler({ module: 'society-setup', order: 8, tables: PURGE_TABLES, purge: purgeSocietySetup });
  // part 2 adds `registerSocietySetupJobs()` here (import validation and commit, export, go-live invites)
}
