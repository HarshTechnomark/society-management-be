/**
 * The module 14 functions other modules may import (section 8.20) and the start-up hook `registerApprovals()`. Owner modules reach
 * approvals only through this file (or, until 14.3 switches them, through their own placeholder ports, which accept
 * `realApprovals`, `realPart2Approvals` and `realPart3Approvals`).
 */
import { registerExportProvider, registerPurgeHandler } from '../societies/societies.public';
import { registerApprovalJobs } from './approvals.jobs';
import { approvalsExportProvider } from './approvals.engine.export';
import { PURGE_ORDER, PURGE_TABLES, purgeApprovals } from './approvals.engine.purge';
import { registerApprovalTemplates } from './approvals.notify';
import { logUnregisteredTypes } from './approvals.registry';

export { registerType } from './approvals.registry';
export {
  request,
  resubmit,
  cancel,
  cancelByRequester,
  lockOpenForEntity,
  getOpenForEntity,
  publicStatus,
} from './approvals.engine';
export { reassign } from './approvals.engine.reassign';
export { bulkApprove } from './approvals.engine.bulk';
export { countForUser, countsFor, computeCounts, bumpEpoch } from './approvals.engine.counts';
export { onMemberEnded, enqueueRecheck } from './approvals.engine.member';
export { recheckSociety } from './approvals.engine.recheck';
export { runSlaSweep } from './approvals.engine.sla';
export { runDelegationSweep } from './approvals.jobs.delegations';
export { assertSocietyWritable } from './approvals.engine.guard';
export { approve, reject, requestChanges, decide } from './approvals.decide';
export { decideAsCommittee, memberCtx } from './approvals.committee';
export { realApprovals } from './approvals.port';
export { realPart2Approvals, realPart3Approvals } from './approvals.port.residents';
export { approvalsPorts, setApprovalsPorts } from './approvals.ports';
export { APPROVAL_TYPES, CATALOGUE, typeMeta } from './approvals.catalogue';
export type {
  ApprovalCtx,
  ApprovalDescription,
  RequestInput,
  ResubmitInput,
  TypeHandlers,
} from './approvals.types';

/** Start-up hook: queue, processors, notification templates. Call from `server.ts`, `worker.ts` (14.3 adds the lines). */
export function registerApprovals(): void {
  registerExportProvider(approvalsExportProvider);
  registerPurgeHandler({
    module: 'approvals',
    order: PURGE_ORDER,
    tables: PURGE_TABLES,
    purge: purgeApprovals,
  });
  registerApprovalJobs();
  registerApprovalTemplates();
  logUnregisteredTypes();
}
