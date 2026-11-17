import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { registerOrderHook } from '../payments/payments.settle';
import { ACCOUNTS_QUEUE, APPROVAL_TYPES, JOBS } from './accounts.constants';
import * as deposits from './accounts.deposits.service';
import * as periods from './accounts.periods.service';
import { accountsPorts } from './accounts.ports';

/**
 * Part 13.4 registrations: jobs `deposit-sync` (every 15 minutes), `relock` (every 15 minutes) and `year-close` (on demand), the
 * module 14 types `DEPOSIT_REFUND` and `PERIOD_UNLOCK`, and the module 12 order hook of deposits (`registerOrderHook('deposit', …)`).
 */
export function registerPeriodJobs(): void {
  registerProcessor(ACCOUNTS_QUEUE, JOBS.depositSync, deposits.depositSyncJob);
  registerRepeatable(ACCOUNTS_QUEUE, JOBS.depositSync, { everyMs: 15 * 60_000 });
  registerProcessor(ACCOUNTS_QUEUE, JOBS.relock, periods.relockJob);
  registerRepeatable(ACCOUNTS_QUEUE, JOBS.relock, { everyMs: 15 * 60_000 });
  registerProcessor(ACCOUNTS_QUEUE, JOBS.yearClose, periods.yearCloseJob);
  registerDepositHooks();
}

/** Re-registered by tests after `clearOrderHooks()`. */
export function registerDepositHooks(): void {
  registerOrderHook('deposit', {
    onPaid: (ctx, order, _payment, t) => deposits.onDepositOrderPaid(ctx, order, t),
  });
  accountsPorts().approvals.registerType({
    type: APPROVAL_TYPES.depositRefund,
    onApproved: deposits.onRefundApproved,
    onRejected: deposits.onRefundRejected,
    onCancelled: deposits.onRefundCancelled,
    describe: deposits.describeRefund,
  });
  accountsPorts().approvals.registerType({
    type: APPROVAL_TYPES.periodUnlock,
    onApproved: periods.onUnlockApproved,
    onRejected: periods.onUnlockRejected,
    onCancelled: periods.onUnlockCancelled,
    describe: periods.describeUnlock,
  });
}
