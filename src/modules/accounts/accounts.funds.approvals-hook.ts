import type { Ctx } from '../../types/context';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { moneyTx } from '../payments/payments.shared';
import { ERR } from './accounts.constants';
import { placeholderAccountsApprovalTypes, placeholderAccountsApprovals } from './accounts.ports';
import { withApprovalRequest } from './accounts.funds.transfer';

/**
 * Development stand-in for module 14's inbox callback for `FUND_TRANSFER` requests made through the accounts placeholder: runs the type's
 * `onApproved` or `onRejected` in one transaction and enforces maker-checker. Wired into `ACCOUNTS_APPROVAL_HOOKS` of `dev.routes.ts`.
 */
async function decide(
  approvalRequestId: number,
  ctx: Ctx,
  action: 'approve' | 'reject',
  reason: string | null,
) {
  const req = placeholderAccountsApprovals.get(approvalRequestId);
  const hooks = req ? placeholderAccountsApprovalTypes.get(req.type) : undefined;
  if (!req || !hooks) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  if (req.status !== 'PENDING') return { type: req.type, entityId: req.entityId, status: req.status };
  if (action === 'approve' && ctx.user?.id !== undefined && ctx.user.id === req.requestedBy)
    throw new ConflictError(ERR.makerChecker, 'The person who requested this cannot approve it');
  const c: Ctx =
    req.societyId && !ctx.society
      ? {
          ...ctx,
          society: { id: req.societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
        }
      : ctx;
  await withApprovalRequest(approvalRequestId, () =>
    moneyTx(async t => {
      if (action === 'approve') await hooks.onApproved(c, req.entityId, t);
      else await hooks.onRejected(c, req.entityId, reason ?? '', t);
    }),
  );
  req.status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  return { type: req.type, entityId: req.entityId, status: req.status };
}

export const approve = (id: number, ctx: Ctx) => decide(id, ctx, 'approve', null);
export const reject = (id: number, reason: string, ctx: Ctx) => decide(id, ctx, 'reject', reason);
