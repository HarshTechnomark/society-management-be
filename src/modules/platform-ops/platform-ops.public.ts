/**
 * The module 07 functions other modules may import (section 8.13, part 1), and the start-up hook `registerPlatformOps()`.
 */
import { setAuthPorts } from '../auth/auth.ports';
import { setSocietyPorts } from '../societies/societies.public';
import { setBillingSettingsSource } from '../platform-billing/platform-billing.public';
import { SETTING_DEFAULTS } from '../societies/societies.types';
import { getPlatformSetting, getStoredSetting } from './platform-ops.settings.service';
import type { SettingKey } from './platform-ops.settings-registry';
import { registerPlatformOpsJobs } from './platform-ops.jobs';
import { countOpenTicketsBySociety } from './platform-ops.tickets.core';
import { createTicket } from './platform-ops.tickets.service';
import { createAnnouncement } from './platform-ops.announcements.service';
import { listEnabledProviders, resolveProvider } from './platform-ops.providers.registry';
import { onAuditCommitted } from '../../utils/audit';
import { emitToRoom } from '../../lib/realtime';
import { activityItem, isActivityAction } from './platform-ops.dashboard.service';
import './platform-ops.templates';

export { getPlatformSetting, countOpenTicketsBySociety };
export { setPlatformOpsPorts } from './platform-ops.ports';
export { createAnnouncement, resolveProvider, listEnabledProviders };
export type { ResolvedProvider } from './platform-ops.providers.registry';
export { SETTINGS_REGISTRY, type SettingKey, type SettingValue } from './platform-ops.settings-registry';

export const platformOps = {
  getPlatformSetting,
  countOpenTickets: countOpenTicketsBySociety,
  createTicketForSociety: createTicket,
  resolveProvider,
  listEnabledProviders,
  createAnnouncement,
};

/**
 * Start-up hook (call after `registerAccessControl()`, `registerSubscriptions()`, `registerSocieties()` and
 * `registerPlatformBilling()`; done in `server.ts`, `worker.ts` and the seed script): gives module 02 the real
 * `getPlatformSetting` port, module 05 its settings reader and module 06 the settings source (a key with no stored row
 * keeps the default of the reading module), and registers the ticket jobs.
 */
export function registerPlatformOps(): void {
  setAuthPorts({
    getPlatformSetting: async key => (await getPlatformSetting(key)) as number,
  });
  setSocietyPorts({
    settings: {
      get: async key =>
        ((await getStoredSetting(key as SettingKey)) as number | undefined) ?? SETTING_DEFAULTS[key],
    },
  });
  setBillingSettingsSource(key => getStoredSetting(key as SettingKey));
  registerPlatformOpsJobs();
  // new activity items go to the platform console live (section 8.2, room `platform:ops`)
  onAuditCommitted(row => {
    if (isActivityAction(row.action))
      emitToRoom(
        'platform:ops',
        'platform.activity',
        activityItem(row) as unknown as Record<string, unknown>,
      );
  });
}
