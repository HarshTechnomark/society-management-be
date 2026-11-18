import { policyApprovalType } from './billing.latefee-policy.service';
import { ruleApprovalType } from './billing.rules.service';
import { billingPorts } from './billing.ports';
import type { ApprovalTypeHooks } from './billing.ports';

/** `BILLING_RULE_CHANGE` and `LATE_FEE_POLICY_CHANGE`: decisions come from the module 14 inbox. */
const TYPES: ApprovalTypeHooks[] = [ruleApprovalType, policyApprovalType];

/** Registers both approval types with the approvals port (called by `registerBilling`). */
export function registerSetupApprovals(): void {
  for (const type of TYPES) billingPorts().approvals.registerType(type);
}
