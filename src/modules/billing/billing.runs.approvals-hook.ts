import { APPROVAL_TYPES } from './billing.constants';
import { billingPorts } from './billing.ports';
import { formatRupees } from '../../lib/money';
import { BillingRun } from '../../models';
import { onRunApproved, onRunChangesRequested, onRunRejected } from './billing.runs.service';

/** `registerRunApprovalType()` registers `BILLING_RUN_PUBLISH` with module 14; decisions come from the module 14 inbox. */
export function registerRunApprovalType(): void {
  billingPorts().approvals.registerType({
    type: APPROVAL_TYPES.runPublish,
    onApproved: onRunApproved,
    onRejected: onRunRejected,
    onChangesRequested: (ctx, entityId, t) => onRunChangesRequested(ctx, entityId, t),
    describe: async runId => {
      const run = await BillingRun.findByPk(runId);
      if (!run) return [];
      const change =
        run.previousRunTotalPaise && Number(run.previousRunTotalPaise) > 0
          ? `${(((Number(run.totalPaise) - Number(run.previousRunTotalPaise)) * 100) / Number(run.previousRunTotalPaise)).toFixed(2)}%`
          : 'No earlier run';
      return [
        { label: 'Period', value: run.runLabel, kind: 'text' },
        { label: 'Flats', value: String(run.readyCount), kind: 'text' },
        { label: 'Total billed', value: formatRupees(Number(run.totalPaise)), kind: 'money' },
        { label: 'Exceptions', value: String(run.exceptionCount), kind: 'text' },
        { label: 'Change vs last month', value: change, kind: 'text' },
      ];
    },
  });
}
