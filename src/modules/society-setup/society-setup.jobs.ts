import type { Transaction } from 'sequelize';
import { logger } from '../../lib/logger';
import { enqueueAfterCommit, registerProcessor, registerQueue } from '../../lib/queue';
import { systemCtx, type Ctx } from '../../types/context';
import { runExportUnits, type ExportJobData } from './society-setup.export.service';
import { runCommitImport, runValidateImport, type ImportJobData } from './society-setup.imports.service';
import { registerGoLiveHook } from './society-setup.onboarding.service';
import { setupPorts } from './society-setup.ports';
import { JOBS, SOCIETY_SETUP_QUEUE } from './society-setup.types';

/** Queue `society-setup` jobs of module 08 section 9.1. Registered by `registerSocietySetup()` (API, worker and seed). */
export interface GoLiveJobData extends Record<string, unknown> {
  societyId: number;
  requestId: string;
  actorUserId: number | null;
}

/** `go-live-invites` (6.5 step 5): module 09 sends the welcome invites; the job is idempotent in module 09. */
export async function runGoLiveInvites(d: GoLiveJobData): Promise<void> {
  await setupPorts().residents.sendWelcomeInvites(systemCtx(d.requestId), d.societyId);
  logger.info({ societyId: d.societyId }, 'society-setup:go-live-invites done');
}

/** Go-live hook: queue the invites after the go-live transaction commits, once per society (`jobId go-live:<id>`). */
export const queueGoLiveInvites = (ctx: Ctx, societyId: number, t: Transaction): void => {
  const data: GoLiveJobData = {
    societyId,
    requestId: ctx.requestId,
    actorUserId: ctx.user?.id ?? null,
  };
  enqueueAfterCommit(t, SOCIETY_SETUP_QUEUE, JOBS.goLiveInvites, data, { jobId: `go-live:${societyId}` });
};

export function registerSocietySetupJobs(): void {
  registerQueue(SOCIETY_SETUP_QUEUE, 'Society setup: unit import, unit export, go-live invites', 4);
  registerProcessor(SOCIETY_SETUP_QUEUE, JOBS.validateImport, async d =>
    runValidateImport(d as unknown as ImportJobData),
  );
  registerProcessor(SOCIETY_SETUP_QUEUE, JOBS.commitImport, async d =>
    runCommitImport(d as unknown as ImportJobData),
  );
  registerProcessor(SOCIETY_SETUP_QUEUE, JOBS.exportUnits, async d =>
    runExportUnits(d as unknown as ExportJobData),
  );
  registerProcessor(SOCIETY_SETUP_QUEUE, JOBS.goLiveInvites, async d =>
    runGoLiveInvites(d as unknown as GoLiveJobData),
  );
  registerGoLiveHook(queueGoLiveInvites);
}
