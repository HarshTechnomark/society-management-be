import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { BILLING_QUEUE, JOBS } from './billing.constants';
import { issueRun, startScheduledIssues } from './billing.issue.service';
import { MAX_COMPUTE_ATTEMPTS } from './billing.runs.shared';
import { runComputeJob } from './billing.runs.compute';
import { registerRunApprovalType } from './billing.runs.approvals-hook';
import './billing.runs.templates';

/**
 * Sub-module 11.3 start-up registrations (section 9.1 and 9.2): the processors of `billing:compute-run`,
 * `billing:issue-run` and `billing:start-scheduled-issues` (daily 00:15 society time, every society is IST for now), and
 * the approval type `BILLING_RUN_PUBLISH`. Idempotent: `registerBilling()` calls it and tests call it again.
 */
export function registerBillingRuns(): void {
  registerProcessor(BILLING_QUEUE, JOBS.computeRun, async data =>
    runComputeJob(Number(data.runId), Number(data.version), MAX_COMPUTE_ATTEMPTS),
  );
  registerProcessor(BILLING_QUEUE, JOBS.issueRun, async data => issueRun(Number(data.runId)));
  registerProcessor(BILLING_QUEUE, JOBS.startScheduledIssues, async () => {
    await startScheduledIssues();
  });
  registerRepeatable(BILLING_QUEUE, JOBS.startScheduledIssues, { dailyAtIst: '00:15' });
  registerRunApprovalType();
}
