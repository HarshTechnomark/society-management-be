import { ConflictError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { APPROVAL_TYPES } from './accounts.constants';
import { placeholderAccountsApprovalTypes, placeholderAccountsApprovals } from './accounts.ports';
import { moneyTx } from '../payments/payments.shared';

/**
 * Development stand-in for the module 14 inbox on `DEPOSIT_REFUND` and `PERIOD_UNLOCK` requests of the placeholder approvals port:
 * `approve` and `reject` run the type callbacks in one transaction, as module 14 will. The dev approvals route (`?source=accounts`)
 * calls them (maker-checker is enforced there).
 */
async function decide(id: number, ctx: Ctx, action: 'approve' | 'reject', reason: string | null) {
  const req = placeholderAccountsApprovals.get(id);
  const hooks = req ? placeholderAccountsApprovalTypes.get(req.type) : undefined;
  if (!req || !hooks) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  if (req.status !== 'PENDING') throw new ConflictError('NOT_PENDING', 'This request was already decided');
  if (![APPROVAL_TYPES.depositRefund, APPROVAL_TYPES.periodUnlock].includes(req.type as never))
    throw new NotFoundError('APPROVAL_NOT_FOUND', 'Not a deposit or period request');
  await moneyTx(async t => {
    if (action === 'approve') await hooks.onApproved(ctx, req.entityId, t);
    else await hooks.onRejected(ctx, req.entityId, reason ?? '', t);
  });
  req.status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  return { type: req.type, entityId: req.entityId, status: req.status };
}

export const approve = (id: number, ctx: Ctx) => decide(id, ctx, 'approve', null);
export const reject = (id: number, reason: string, ctx: Ctx) => decide(id, ctx, 'reject', reason);
