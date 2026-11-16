import { moneyTx } from './payments.shared';
import type { Ctx } from '../../types/context';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { ERR } from './payments.constants';
import { placeholderPaymentApprovalTypes, placeholderPaymentApprovals } from './payments.ports';

/**
 * Development stand-in for module 14's inbox callback for requests made through the payments placeholder: runs the type's
 * `onApproved`, `onRejected` or `onChangesRequested` in one transaction and enforces maker-checker
 * (`409 MAKER_CHECKER_VIOLATION`). Wired into `PAYMENTS_APPROVAL_HOOKS` of `dev.routes.ts` for `COLLECTION_PUBLISH`.
 */
async function decide(
  approvalRequestId: number,
  ctx: Ctx,
  action: 'approve' | 'reject' | 'changes',
  reason: string | null,
): Promise<{ type: string; entityId: number; status: string }> {
  const req = placeholderPaymentApprovals.get(approvalRequestId);
  const hooks = req ? placeholderPaymentApprovalTypes.get(req.type) : undefined;
  if (!req || !hooks) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  if (req.status !== 'PENDING') return { type: req.type, entityId: req.entityId, status: req.status };
  if (action === 'approve' && ctx.user?.id !== undefined && ctx.user.id === req.requestedBy)
    throw new ConflictError(ERR.makerChecker, 'The person who requested this cannot approve it');
  await moneyTx(async t => {
    const c: Ctx =
      req.societyId && !ctx.society
        ? {
            ...ctx,
            society: { id: req.societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
          }
        : ctx;
    if (action === 'approve') await hooks.onApproved(c, req.entityId, t);
    else if (action === 'reject') await hooks.onRejected(c, req.entityId, reason ?? '', t);
    else await hooks.onChangesRequested?.(c, req.entityId, t);
  });
  req.status = action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
  return { type: req.type, entityId: req.entityId, status: req.status };
}

export const approve = (id: number, ctx: Ctx) => decide(id, ctx, 'approve', null);
export const reject = (id: number, reason: string, ctx: Ctx) => decide(id, ctx, 'reject', reason);
export const requestChanges = (id: number, ctx: Ctx) => decide(id, ctx, 'changes', null);
