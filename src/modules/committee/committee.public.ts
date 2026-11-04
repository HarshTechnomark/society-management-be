/**
 * The module 10 functions other modules may import (section 9.2) and the start-up hook `registerCommittee()`. Modules 14, 16,
 * 22, 24 and 25 read the committee only through this file. Sub-modules 10.2 and 10.3 add the jobs, the activation and
 * changes services, the hand-over checklist and the resident views here.
 */
import { registerExportProvider, registerPurgeHandler } from '../societies/societies.public';
import { committeeExportProvider } from './committee.exports';
import { PURGE_TABLES, purgeCommittee } from './committee.purge';
import { createDraftFromElection } from './committee.election';
import { getCurrent, isSeated, listSeatedUserIds } from './committee.queries';
import { registerCommitteeJobs } from './committee.jobs';
import './committee.templates';

export const committee = { getCurrent, listSeatedUserIds, isSeated, createDraftFromElection };

export { setCommitteePorts } from './committee.ports';
export type { CommitteePorts } from './committee.ports';
export type { DraftFromElectionInput } from './committee.election';
export { DESIGNATIONS, DESIGNATION_ROLE, COMMITTEE_ROLE_KEYS, PORTFOLIOS } from './committee.constants';
export type { Designation } from './committee.constants';

/**
 * Start-up hook (call after `registerSocieties()`; done in `server.ts`, `worker.ts` and `npm run seed`): the module 05 export
 * provider and purge handler. Jobs, hooks and onboarding checks of later sub-modules register here.
 */
export function registerCommittee(): void {
  registerExportProvider(committeeExportProvider);
  registerPurgeHandler({ module: 'members', order: 10, tables: PURGE_TABLES, purge: purgeCommittee });
  registerCommitteeJobs();
}
