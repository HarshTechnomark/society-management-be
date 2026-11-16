import { NotFoundError, ConflictError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { placeholderPaymentApprovalTypes, placeholderPaymentApprovals } from './payments.ports';
import { moneyTx } from './payments.shared';

/**
 * Development stand-in for the module 14 inbox on `PAYMENT_REFUND` requests made through the placeholder approvals port: `approve`
 * and `reject` run the type callbacks (`onApproved`, `onRejected`) in one transaction, as module 14 will. The dev approvals route
 * (`?source=payments`) calls them; the placeholder enforces maker-checker (`409 MAKER_CHECKER_VIOLATION`).
 */
async function decide(id: number, ctx: Ctx, action: 'approve' | 'reject', reason: string | null) {
  const req = placeholderPaymentApprovals.get(id);
  const hooks = req ? placeholderPaymentApprovalTypes.get(req.type) : undefined;
  if (!req || !hooks) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  if (req.status !== 'PENDING') return { type: req.type, entityId: req.entityId, status: req.status };
  if (action === 'approve' && ctx.user?.id !== undefined && ctx.user.id === req.requestedBy)
    throw new ConflictError('MAKER_CHECKER_VIOLATION', 'The person who requested this cannot approve it');
  const c: Ctx =
    req.societyId && !ctx.society
      ? {
          ...ctx,
          society: { id: req.societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
        }
      : ctx;
  await moneyTx(async t => {
    if (action === 'approve') await hooks.onApproved(c, req.entityId, t);
    else await hooks.onRejected(c, req.entityId, reason ?? '', t);
  });
  req.status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  return { type: req.type, entityId: req.entityId, status: req.status };
}

export const approve = (id: number, ctx: Ctx) => decide(id, ctx, 'approve', null);
export const reject = (id: number, reason: string, ctx: Ctx) => decide(id, ctx, 'reject', reason);
