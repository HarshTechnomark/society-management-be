import type { Ctx } from '../../types/context';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { moneyTx } from '../payments/payments.shared';
import { APPROVAL_TYPES, ERR } from './accounts.constants';
import {
  accountsPorts,
  placeholderAccountsApprovalTypes,
  placeholderAccountsApprovals,
  type ApprovalTypeHooks,
} from './accounts.ports';
import {
  describeJournal,
  onJournalApproved,
  onJournalCancelled,
  onJournalChangesRequested,
  onJournalRejected,
} from './accounts.journal.service';

/**
 * Approval type `MANUAL_JOURNAL` (entity `journal_entry`): registers the module 14 callbacks, and `approve` / `reject` /
 * `requestChanges` for the development approvals page (`?source=accounts`), which stand in for the module 14 inbox until it
 * exists. Same pattern as `payments.offline.approvals-hook.ts`; maker-checker is enforced as module 14 would.
 */
export function registerJournalApprovalType(): void {
  const hooks: ApprovalTypeHooks = {
    type: APPROVAL_TYPES.manualJournal,
    onApproved: onJournalApproved,
    onRejected: onJournalRejected,
    onChangesRequested: onJournalChangesRequested,
    onCancelled: onJournalCancelled,
    describe: describeJournal,
  };
  accountsPorts().approvals.registerType(hooks);
}

async function decide(id: number, ctx: Ctx, action: 'approve' | 'reject' | 'changes', reason: string | null) {
  const req = placeholderAccountsApprovals.get(id);
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
  await moneyTx(async t => {
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
