/**
 * The module 16 functions other modules may import (section 8.38) and the start-up hook `registerCommunication()`. `notify` and `notifyMany` are the REAL
 * service; the functions owned by the parts are implemented by them (see README). Other modules reach notices,
 * emergency broadcasts and the inbox only through this file.
 */
import type { Transaction } from 'sequelize';
import { setNotifyEngine } from '../../lib/notify';
import { setAuthPorts } from '../auth/auth.ports';
import { registerQueue } from '../../lib/queue';
import type { Ctx, SystemCtx } from '../../types/context';
import { registerExportProvider, registerPurgeHandler } from '../societies/societies.public';
import { COMMUNICATION_QUEUE } from './communication.constants';
import { legacyEngine } from './communication.core';
import { registerNoticeApprovalType } from './communication.approval';
import {
  ackSummary,
  createDraft,
  createSystemNotice,
  hasUserAcknowledged,
} from './communication.notices.system';
import { recallBySource } from './communication.notices.publish';
import { forNotices, reachByNotice } from './communication.notices.reports';
import { getActiveSummary } from './communication.emergency.read';
import { startFromSos } from './communication.emergency.service';
import { communicationExportProvider } from './communication.exports';
import { registerCommunicationJobs } from './communication.jobs';
import { assertCommunicationPortsReady, setCommunicationPorts } from './communication.ports';
import {
  onSessionRevoked as pushOnSessionRevoked,
  onUserAnonymised as pushOnUserAnonymised,
} from './communication.push.service';
import { webPushPortFromEnv } from './communication.push.sender';
import { moduleSevenProviders } from './communication.platform.providers';
import { PURGE_ORDER, PURGE_TABLES, purgeCommunication } from './communication.purge';
import type { StartFromSosInput } from './communication.types';

export { notify, notifyMany, runNotifyFanout, setDeliveryMode, deliveryMode } from './communication.core';
export { registerTemplates, syncTemplates, codeDefinitions } from './communication.registry';
export { deliverNotification, repairStuck, runDeliverJob } from './communication.deliver';
export { getTemplate, renderTemplate, dropTemplateCache } from './communication.templates';
export { resolveAudience, normaliseAudience, audienceLabel } from './communication.audience';
export { unreadCount, markRead } from './communication.inbox';
export { getOrCreatePreferences } from './communication.prefs';
export { setCommunicationPorts } from './communication.ports';
export type { CommunicationPorts } from './communication.ports';
export type {
  Recipient,
  NotifyOptions,
  NotifyResult,
  TemplateDefinition,
  NoticeAudience,
  SystemNoticeInput,
} from './communication.types';

/** 8.38 `notices.*` (part 16.1). */
export const notices = { createSystemNotice, recallBySource, createDraft, ackSummary, hasUserAcknowledged };

/** 8.38 `emergency.*` (part 16.3). */
export const emergency = {
  async startFromSos(
    ctx: Ctx | SystemCtx,
    input: StartFromSosInput,
  ): Promise<{ broadcastId: number; created: boolean }> {
    return startFromSos(ctx, input);
  },
  async getActive(
    societyId: number,
  ): Promise<{ id: number; type: string; title: string; startedAt: Date }[]> {
    return getActiveSummary(societyId);
  },
};

/** 8.38 hooks called by module 02 (part 16.2). */
export const communicationHooks = {
  onUserAnonymised: (userId: number, t: Transaction): Promise<void> => pushOnUserAnonymised(userId, t),
  onSessionRevoked: (sessionId: number): Promise<void> => pushOnSessionRevoked(sessionId),
};

/** 8.38 reach readers for module 24 (part 16.1). */
export const reach = { forNotices };
export const noticeReports = { reachByNotice };

/**
 * Start-up hook: installs the real notification engine behind `lib/notify`, export provider, purge handler, queue `communication` and its jobs. Call it from
 * `server.ts`, `worker.ts` and `scripts/seed.ts` AFTER the modules that register templates (the registry is read lazily, so the order is not critical).
 */
export function registerCommunication(): void {
  // 16.2: the real Web Push sender when the VAPID keys are configured (otherwise the placeholder stays, and production start-up refuses it)
  const webPush = webPushPortFromEnv();
  if (webPush) setCommunicationPorts({ push: webPush });
  setAuthPorts({ communicationHooks });
  setCommunicationPorts({ providers: moduleSevenProviders }); // 16.4: module 07 resolveProvider (BR-16-28)
  assertCommunicationPortsReady();
  setNotifyEngine(legacyEngine);
  registerExportProvider(communicationExportProvider);
  registerPurgeHandler({
    module: 'communication',
    order: PURGE_ORDER,
    tables: PURGE_TABLES,
    purge: purgeCommunication,
  });
  registerQueue(
    COMMUNICATION_QUEUE,
    'Communication: delivery, fan-out, notices, reminders, emergency, surveys, webhooks',
    20,
  );
  registerCommunicationJobs();
  registerNoticeApprovalType(); // 8.39 (16.1)
}
