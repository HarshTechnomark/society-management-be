import { registerChequeJobs } from './payments.cheques.jobs';
import { registerOfflineApprovalTypes } from './payments.offline.approvals-hook';

/** 12.2 start-up registrations: the `OFFLINE_PAYMENT` approval type and the cheque reminder job. Idempotent. */
export function registerOfflinePayments(): void {
  registerOfflineApprovalTypes();
  registerChequeJobs();
}
