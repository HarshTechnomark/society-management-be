import { sequelize } from '../../models';
import type { Ctx } from '../../types/context';
import { NotFoundError } from '../../utils/errors';
import { permitApprovals } from './residents.renovations.service';
import { transferApprovals } from './residents.transfers.service';
import { approvalHandlers, approvalStore, part3Ports } from './residents.part3.ports';

/**
 * Module 14 does not exist yet. These two functions do what its inbox callback will do for a request created through the
 * placeholder `approvals.request`: run the type's `onApproved` or `onRejected` in one transaction. The coordinator can wire
 * a development-only route to them (`POST /dev/approvals/:id/approve` and `/reject`).
 */
export function registerPart3Approvals(): void {
  const p = part3Ports().approvals;
  p.registerType('RENOVATION_PERMIT', permitApprovals);
  p.registerType('OWNERSHIP_TRANSFER', transferApprovals);
}

async function decide(
  approvalRequestId: number,
  ctx: Ctx,
  run: 'onApproved' | 'onRejected',
  reason: string | null,
): Promise<{ type: string; entityId: number; status: string }> {
  const a = approvalStore.get(approvalRequestId);
  const h = a ? approvalHandlers.get(a.type) : undefined;
  if (!a || !h) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  if (a.status !== 'PENDING') return { type: a.type, entityId: a.entityId, status: a.status };
  await sequelize.transaction(t =>
    h[run](ctx, { id: a.id, entityId: a.entityId, societyId: a.societyId, reason }, t),
  );
  a.status = run === 'onApproved' ? 'APPROVED' : 'REJECTED';
  return { type: a.type, entityId: a.entityId, status: a.status };
}

export const approve = (approvalRequestId: number, actorCtx: Ctx) =>
  decide(approvalRequestId, actorCtx, 'onApproved', null);
export const reject = (approvalRequestId: number, reason: string, actorCtx: Ctx) =>
  decide(approvalRequestId, actorCtx, 'onRejected', reason);
