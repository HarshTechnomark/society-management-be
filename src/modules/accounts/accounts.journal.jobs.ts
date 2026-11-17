import './accounts.journal.templates';
import { registerJournalApprovalType } from './accounts.journal.approvals-hook';

/** 13.1b registration (called from `registerAccountsJobs()`): the `MANUAL_JOURNAL` approval type and the rejection template. No jobs. */
export function registerJournalJobs(): void {
  registerJournalApprovalType();
}
