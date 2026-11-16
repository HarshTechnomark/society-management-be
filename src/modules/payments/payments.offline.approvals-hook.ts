import { Payment } from '../../models';
import type { Ctx } from '../../types/context';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { APPROVAL_TYPES, ERR } from './payments.constants';
import {
  paymentsPorts,
  placeholderPaymentApprovalTypes,
  placeholderPaymentApprovals,
} from './payments.ports';
import { describeOfflinePayment, endPending, onOfflineApproved } from './payments.offline.service';
import { moneyTx } from './payments.shared';
import type { ApprovalTypeHooks } from './payments.ports';

/**
 * Approval type `OFFLINE_PAYMENT` (entity `payment`): registers the module 14 callbacks, and `approve` / `reject` for the
 * development approvals page (`?source=payments`), which stand in for the module 14 inbox until it exists. Same pattern as
 * `billing.notes.approvals-hook.ts`; maker-checker is enforced here as the placeholder module 14 would.
 */
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

async function decide(approvalRequestId: number, ctx: Ctx, action: 'approve' | 'reject', reason: string) {
  const req = placeholderPaymentApprovals.get(approvalRequestId);
  const hooks = req ? placeholderPaymentApprovalTypes.get(req.type) : undefined;
  if (!req || !hooks) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  if (req.status !== 'PENDING') return { type: req.type, entityId: req.entityId, status: req.status };
  if (action === 'approve' && ctx.user?.id !== undefined && ctx.user.id === req.requestedBy)
    throw new ConflictError(ERR.makerChecker, 'The person who recorded this cannot approve it');
  const societyId = req.societyId;
  const c: Ctx =
    societyId && !ctx.society
      ? {
          ...ctx,
          society: { id: societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
        }
      : ctx;
  await moneyTx(async t => {
    if (action === 'approve') await hooks.onApproved(c, req.entityId, t);
    else await hooks.onRejected(c, req.entityId, reason, t);
  });
  req.status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  return { type: req.type, entityId: req.entityId, status: req.status };
}

export const approve = (approvalRequestId: number, ctx: Ctx) => decide(approvalRequestId, ctx, 'approve', '');
export const reject = (approvalRequestId: number, reason: string, ctx: Ctx) =>
  decide(approvalRequestId, ctx, 'reject', reason);

/** Used by tests: the payment of a placeholder approval request. */
export const paymentOfRequest = (approvalRequestId: number) =>
  Payment.findOne({ where: { approvalRequestId } });
