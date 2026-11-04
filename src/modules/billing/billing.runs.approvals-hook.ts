import { sequelize } from '../../models';
import type { Ctx } from '../../types/context';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { APPROVAL_TYPES } from './billing.constants';
import { billingPorts, placeholderApprovalRequests, placeholderApprovalTypes } from './billing.ports';
import { formatRupees } from '../../lib/money';
import { BillingRun } from '../../models';
import { onRunApproved, onRunChangesRequested, onRunRejected } from './billing.runs.service';

/**
 * Module 14 does not exist yet. `registerRunApprovalType()` registers `BILLING_RUN_PUBLISH` through the approvals port (the
 * placeholder keeps the hooks; module 14 replaces it). `approve` and `reject` do what module 14's inbox callback will do for a
 * request created through the placeholder: run the type's `onApproved` or `onRejected` in one transaction. The coordinator can
 * wire a development-only route to them (`POST /dev/approvals/:id/approve` and `/reject`), like
 * `residents.part3.approvals-hook.ts`. The placeholder enforces maker-checker (BR-14: the publisher cannot approve).
 */
export function registerRunApprovalType(): void {
  billingPorts().approvals.registerType({
    type: APPROVAL_TYPES.runPublish,
    onApproved: onRunApproved,
    onRejected: onRunRejected,
    onChangesRequested: (ctx, entityId, t) => onRunChangesRequested(ctx, entityId, t),
    describe: async runId => {
      const run = await BillingRun.findByPk(runId);
      if (!run) return [];
      const change =
        run.previousRunTotalPaise && Number(run.previousRunTotalPaise) > 0
          ? `${(((Number(run.totalPaise) - Number(run.previousRunTotalPaise)) * 100) / Number(run.previousRunTotalPaise)).toFixed(2)}%`
          : 'No earlier run';
      return [
        { label: 'Period', value: run.runLabel, kind: 'text' },
        { label: 'Flats', value: String(run.readyCount), kind: 'text' },
        { label: 'Total billed', value: formatRupees(Number(run.totalPaise)), kind: 'money' },
        { label: 'Exceptions', value: String(run.exceptionCount), kind: 'text' },
        { label: 'Change vs last month', value: change, kind: 'text' },
      ];
    },
  });
}

async function decide(
  approvalRequestId: number,
  ctx: Ctx,
  action: 'approve' | 'reject' | 'changes',
  reason: string | null,
): Promise<{ type: string; entityId: number; status: string }> {
  const req = placeholderApprovalRequests.get(approvalRequestId);
  const hooks = req ? placeholderApprovalTypes.get(req.type) : undefined;
  if (!req || !hooks) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  if (req.status !== 'PENDING') return { type: req.type, entityId: req.entityId, status: req.status };
  if (action === 'approve' && ctx.user?.id !== undefined && ctx.user.id === req.requestedBy)
    throw new ConflictError('MAKER_CHECKER_VIOLATION', 'The person who requested this cannot approve it');
  await sequelize.transaction(async t => {
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

export const approve = (approvalRequestId: number, ctx: Ctx) =>
  decide(approvalRequestId, ctx, 'approve', null);
export const reject = (approvalRequestId: number, reason: string, ctx: Ctx) =>
  decide(approvalRequestId, ctx, 'reject', reason);
export const requestChanges = (approvalRequestId: number, ctx: Ctx) =>
  decide(approvalRequestId, ctx, 'changes', null);
