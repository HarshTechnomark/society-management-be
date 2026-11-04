import { BillingRuleVersion, LateFeePolicy, sequelize } from '../../models';
import type { Ctx } from '../../types/context';
import { NotFoundError } from '../../utils/errors';
import { APPROVAL_TYPES } from './billing.constants';
import { policyApprovalType } from './billing.latefee-policy.service';
import { ruleApprovalType } from './billing.rules.service';
import { billingPorts } from './billing.ports';
import type { ApprovalTypeHooks } from './billing.ports';

/**
 * Module 14 does not exist yet. These two functions do what its inbox callback will do for a `BILLING_RULE_CHANGE` or
 * `LATE_FEE_POLICY_CHANGE` request created through the placeholder `approvals.request`: run the type's `onApproved` or
 * `onRejected` in one transaction. The request is found by the `approvalRequestId` stored on the version or policy. The
 * coordinator can wire a development-only route to them (`POST /dev/approvals/:id/approve` and `/reject`).
 */
const TYPES: ApprovalTypeHooks[] = [ruleApprovalType, policyApprovalType];

/** Registers both approval types with the approvals port (called by `registerBilling`). */
export function registerSetupApprovals(): void {
  for (const type of TYPES) billingPorts().approvals.registerType(type);
}

interface Found {
  type: string;
  entityId: number;
  status: string;
}
async function find(approvalRequestId: number): Promise<Found> {
  const v = await BillingRuleVersion.findOne({ where: { approvalRequestId } });
  if (v) return { type: APPROVAL_TYPES.ruleChange, entityId: Number(v.id), status: v.status };
  const p = await LateFeePolicy.findOne({ where: { approvalRequestId } });
  if (p) return { type: APPROVAL_TYPES.lateFeePolicyChange, entityId: Number(p.id), status: p.status };
  throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
}

async function decide(
  approvalRequestId: number,
  ctx: Ctx,
  run: 'onApproved' | 'onRejected',
  reason: string,
): Promise<{ type: string; entityId: number; status: string }> {
  const f = await find(approvalRequestId);
  if (f.status !== 'PENDING_APPROVAL') return f;
  const h = TYPES.find(x => x.type === f.type)!;
  await sequelize.transaction(t =>
    run === 'onApproved' ? h.onApproved(ctx, f.entityId, t) : h.onRejected(ctx, f.entityId, reason, t),
  );
  return { ...f, status: (await find(approvalRequestId)).status };
}

export const approve = (approvalRequestId: number, actorCtx: Ctx) =>
  decide(approvalRequestId, actorCtx, 'onApproved', '');
export const reject = (approvalRequestId: number, reason: string, actorCtx: Ctx) =>
  decide(approvalRequestId, actorCtx, 'onRejected', reason);
