import type { Ctx } from '../../types/context';
import { APPROVAL_TYPES } from './payments.constants';
import { paymentsPorts } from './payments.ports';
import { describeOfflinePayment, endPending, onOfflineApproved } from './payments.offline.service';
import type { ApprovalTypeHooks } from './payments.ports';

/** Approval type `OFFLINE_PAYMENT` (entity `payment`): registers the module 14 callbacks (decisions come from the inbox). */
export function registerOfflineApprovalTypes(): void {
  const hooks: ApprovalTypeHooks & {
    onExpired: (ctx: Ctx, id: number, t: import('sequelize').Transaction) => Promise<void>;
  } = {
    type: APPROVAL_TYPES.offlinePayment,
    onApproved: onOfflineApproved,
    onRejected: (ctx, id, reason, t) => endPending(ctx, id, reason, 'rejected', t),
    onCancelled: (ctx, id, t) =>
      endPending(ctx, id, 'Withdrawn by the person who recorded it', 'withdrawn', t),
    onExpired: (ctx, id, t) => endPending(ctx, id, 'The approval request expired', 'expired', t),
    describe: describeOfflinePayment,
  };
  paymentsPorts().approvals.registerType(hooks);
}
