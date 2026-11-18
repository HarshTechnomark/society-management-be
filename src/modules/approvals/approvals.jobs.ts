import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import { APPROVALS_QUEUE, JOB } from './approvals.constants';
import { recheckSociety } from './approvals.engine.recheck';
import { runSlaSweep } from './approvals.engine.sla';
import { runDelegationSweep } from './approvals.jobs.delegations';
import { notifyApproversJob } from './approvals.notify';
import { registerRuleHealthJob } from './approvals.rules.health';

const FIFTEEN_MINUTES = 15 * 60_000;

/**
 * Jobs of queue `approvals` (9.1): `notify-approvers`, `sla-sweep` and `delegation-sweep` (every 15 minutes) and `recheck-member`
 * (on demand). `approvals:rule-health` belongs to 14.2.
 */
export function registerApprovalJobs(): void {
  registerQueue(APPROVALS_QUEUE, 'Approvals: notify approvers, SLA sweep, delegations', 5);
  registerProcessor(APPROVALS_QUEUE, JOB.notifyApprovers, d => notifyApproversJob(d));
  registerProcessor(APPROVALS_QUEUE, JOB.slaSweep, d =>
    runSlaSweep(d.societyId ? { societyId: Number(d.societyId) } : {}),
  );
  registerProcessor(APPROVALS_QUEUE, JOB.delegationSweep, () => runDelegationSweep());
  registerProcessor(APPROVALS_QUEUE, JOB.recheckMember, d => recheckSociety(Number(d.societyId)));
  registerRepeatable(APPROVALS_QUEUE, JOB.slaSweep, { everyMs: FIFTEEN_MINUTES });
  registerRepeatable(APPROVALS_QUEUE, JOB.delegationSweep, { everyMs: FIFTEEN_MINUTES });
  registerRuleHealthJob();
}
