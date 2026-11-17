import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { ACCOUNTS_QUEUE, JOBS } from './accounts.constants';
import { verifyJob } from './accounts.verify';
import { registerJournalJobs } from './accounts.journal.jobs';

/**
 * Registry of the jobs of queue `accounts` (section 9.1). The foundation registers `accounts:balance-verify` (daily 02:30 IST; with
 * `{ societyId }` it verifies one society). Each part adds ONE line to `registerAccountsJobs()` that calls its own `register...Jobs()`
 * (processors, repeatables and the module 14 approval types of its part).
 */
export function registerAccountsJobs(): void {
  registerProcessor(ACCOUNTS_QUEUE, JOBS.balanceVerify, verifyJob);
  registerRepeatable(ACCOUNTS_QUEUE, JOBS.balanceVerify, { dailyAtIst: '02:30' });
  // parts add their registration here, one line each:
  registerJournalJobs(); // 13.1b: MANUAL_JOURNAL approval type
  // registerExpenseJobs(); // 13.2: EXPENSE and FUND_TRANSFER approval types
  // registerStatementJobs(); // 13.3: settlement-reconcile, statement-parse, auto-match, clearing-age
  // registerPeriodJobs(); // 13.4: deposit-sync, relock, year-close, report-export, PERIOD_UNLOCK and DEPOSIT_REFUND approval types
}
