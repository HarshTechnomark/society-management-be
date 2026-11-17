import type { Ctx } from '../../types/context';
import { NotFoundError } from '../../utils/errors';
import { placeholderAccountsApprovalTypes, placeholderAccountsApprovals } from './accounts.ports';
import { moneyTx, withSociety } from './accounts.expenses.shared';

/**
 * Development hooks of the approval type `EXPENSE` for `/dev/approvals/:id/approve|reject?source=accounts` (the dev route checks the
 * maker-checker rule and the pending state). They stand in for the module 14 inbox: the registered `onApproved` / `onRejected` run
 * in one transaction, so an `INSUFFICIENT_BALANCE` leaves the request pending.
 */
function find(requestId: number, ctx: Ctx) {
  const req = placeholderAccountsApprovals.get(requestId);
  const hooks = req ? placeholderAccountsApprovalTypes.get(req.type) : undefined;
  if (!req || !hooks) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  return { req, hooks, ctx: req.societyId ? withSociety(ctx, req.societyId) : ctx };
}

export const expenseApprovals = {
  approve: async (requestId: number, ctx: Ctx) => {
    const { req, hooks, ctx: c } = find(requestId, ctx);
    await moneyTx(t => hooks.onApproved(c, req.entityId, t));
    return { type: req.type, entityId: req.entityId, status: 'APPROVED' };
  },
  reject: async (requestId: number, reason: string, ctx: Ctx) => {
    const { req, hooks, ctx: c } = find(requestId, ctx);
    await moneyTx(t => hooks.onRejected(c, req.entityId, reason, t));
    return { type: req.type, entityId: req.entityId, status: 'REJECTED' };
  },
};
