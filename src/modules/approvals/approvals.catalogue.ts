import type { StepMode } from './approvals.constants';
import type { RuleStep } from './approvals.types';

/**
 * Section 5.1: the approval type catalogue, defined once. The same list feeds the Zod enum, the migrations' CHECKs and the
 * registry. Section 7.5: the default rules per type. Adding a type = one entry here, one migration that rewrites the two CHECKs
 * and the owner module calling `registerType()`.
 */
export interface TypeMeta {
  type: string;
  label: string;
  /** Owner module number. */
  owner: string;
  entityType: string;
  approvePermission: string;
  viewPermission: string;
  requestPermission: string;
  isMoney: boolean;
  residentVisible: boolean;
  allowBulk: boolean;
  allowsChanges: boolean;
  /** Module 14 notifies the requester of approved, rejected, changes requested and expired (BR-14-31). */
  notifyRequester: boolean;
  /** Approving always needs step-up (PERIOD_UNLOCK, BILLING_RULE_CHANGE, LATE_FEE_POLICY_CHANGE and the gateway types). */
  alwaysStepUp: boolean;
}

// type, label, owner, entityType, approve, view, request, money, resident, bulk, changes, notify
type Row = [string, string, string, string, string, string, string, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1];
// prettier-ignore
const ROWS: Row[] = [
  ['EXPENSE', 'Expense', '13', 'expense', 'finance.expenses.approve', 'finance.expenses.view', 'finance.expenses.create', 1, 0, 1, 1, 1],
  ['PAYMENT_REFUND', 'Payment refund', '12', 'refund', 'finance.payments.approve', 'finance.payments.view', 'finance.payments.create', 1, 0, 0, 0, 1],
  ['OFFLINE_PAYMENT', 'Offline payment', '12', 'payment', 'finance.payments.approve', 'finance.payments.view', 'finance.payments.create', 1, 0, 0, 0, 1],
  ['INVOICE_CANCEL', 'Invoice cancellation', '11', 'invoice', 'finance.billing.approve', 'finance.billing.view', 'finance.billing.edit', 1, 0, 0, 0, 1],
  ['BILLING_RUN_PUBLISH', 'Billing run', '11', 'billing_run', 'finance.billing.approve', 'finance.billing.view', 'finance.billing.create', 1, 0, 0, 1, 1],
  ['CREDIT_NOTE', 'Credit note', '11', 'billing_note', 'finance.billing.approve', 'finance.billing.view', 'finance.billing.create', 1, 0, 0, 1, 1],
  ['WRITE_OFF', 'Write-off', '11', 'billing_note', 'finance.billing.approve', 'finance.billing.view', 'finance.billing.create', 1, 0, 0, 0, 1],
  ['COLLECTION_PUBLISH', 'Collection', '12', 'collection', 'finance.collections.approve', 'finance.collections.view', 'finance.collections.create', 1, 0, 0, 1, 1],
  ['JOIN_REQUEST', 'Join request', '09', 'join_request', 'residents.requests.approve', 'residents.requests.view', 'residents.requests.create', 0, 1, 1, 0, 0],
  ['MOVE_IN', 'Move-in', '09', 'move_request', 'residents.requests.approve', 'residents.requests.view', 'residents.requests.create', 0, 1, 1, 1, 0],
  ['MOVE_OUT', 'Move-out', '09', 'move_request', 'residents.requests.approve', 'residents.requests.view', 'residents.requests.create', 0, 1, 1, 1, 0],
  ['RENOVATION_PERMIT', 'Renovation permit', '09', 'renovation_permit', 'residents.requests.approve', 'residents.requests.view', 'residents.requests.create', 0, 1, 0, 1, 0],
  ['OWNERSHIP_TRANSFER', 'Ownership transfer', '09', 'ownership_transfer', 'residents.requests.approve', 'residents.requests.view', 'residents.requests.create', 0, 1, 0, 1, 0],
  ['PURCHASE_ORDER', 'Purchase order', '21', 'purchase_order', 'vendors.purchase_orders.approve', 'vendors.purchase_orders.view', 'vendors.purchase_orders.create', 1, 0, 0, 1, 1],
  ['VENDOR_BILL', 'Vendor bill', '21', 'vendor_bill', 'vendors.purchase_orders.approve', 'vendors.purchase_orders.view', 'vendors.purchase_orders.create', 1, 0, 0, 1, 1],
  ['NOTICE_PUBLISH', 'Notice', '16', 'notice', 'communication.notices.approve', 'communication.notices.view', 'communication.notices.create', 0, 0, 1, 1, 1],
  ['BOOKING', 'Booking', '18', 'booking', 'amenities.bookings.approve', 'amenities.bookings.view', 'amenities.bookings.create', 0, 1, 1, 0, 0],
  ['SUBSCRIPTION_CANCEL', 'Subscription cancellation', '04', 'subscription', 'settings.subscription.edit', 'settings.subscription.view', 'settings.subscription.edit', 0, 0, 0, 0, 1],
  ['DEPOSIT_REFUND', 'Deposit refund', '13', 'deposit', 'finance.accounts.approve', 'finance.accounts.view', 'finance.accounts.create', 1, 0, 0, 0, 1],
  ['FINE_WAIVER', 'Fine waiver', '23', 'rule_violation', 'documents.rules.approve', 'documents.rules.view', 'documents.rules.edit', 1, 0, 0, 0, 1],
  ['CERTIFICATE_REQUEST', 'Certificate request', '23', 'certificate_request', 'documents.certificates.approve', 'documents.certificates.view', 'documents.certificates.create', 0, 1, 1, 0, 0],
  ['SHARE_CERTIFICATE_ACTION', 'Share certificate action', '23', 'share_certificate', 'documents.certificates.approve', 'documents.registers.view', 'documents.registers.edit', 0, 0, 0, 1, 0],
  ['GATEWAY_ACTIVATE', 'Gateway activation', '29', 'gateway_account', 'settings.integrations.approve', 'settings.integrations.view', 'settings.integrations.edit', 0, 0, 0, 0, 1],
  ['GATEWAY_ROTATE_SECRETS', 'Gateway secret rotation', '29', 'gateway_account', 'settings.integrations.approve', 'settings.integrations.view', 'settings.integrations.edit', 0, 0, 0, 0, 1],
  ['AUTOMATION_RULE_ACTIVATE', 'Automation rule', '30', 'automation_rule', 'automation.rules.approve', 'automation.rules.view', 'automation.rules.edit', 0, 0, 0, 1, 0],
  ['MINUTES', 'Meeting minutes', '22', 'meeting', 'governance.meetings.approve', 'governance.meetings.view', 'governance.meetings.create', 0, 0, 0, 1, 0],
  ['MANUAL_JOURNAL', 'Manual journal', '13', 'journal_entry', 'finance.accounts.approve', 'finance.accounts.view', 'finance.accounts.create', 1, 0, 0, 0, 1],
  ['FUND_TRANSFER', 'Fund transfer', '13', 'fund', 'finance.accounts.approve', 'finance.accounts.view', 'finance.accounts.create', 1, 0, 0, 0, 1],
  ['PERIOD_UNLOCK', 'Period unlock', '13', 'society_balance', 'finance.accounts.approve', 'finance.accounts.view', 'finance.accounts.create', 0, 0, 0, 0, 1],
  ['BILLING_RULE_CHANGE', 'Billing rule change', '11', 'billing_rule_version', 'finance.billing.approve', 'finance.billing.view', 'finance.billing.edit', 0, 0, 0, 0, 1],
  ['LATE_FEE_POLICY_CHANGE', 'Late fee policy change', '11', 'late_fee_policy', 'finance.billing.approve', 'finance.billing.view', 'finance.billing.edit', 0, 0, 0, 0, 1],
];

/** Types whose approval always asks for step-up whatever the amount (section 5.1 note, BR-14-13). */
const ALWAYS_STEP_UP = new Set([
  'PERIOD_UNLOCK',
  'BILLING_RULE_CHANGE',
  'LATE_FEE_POLICY_CHANGE',
  'GATEWAY_ACTIVATE',
  'GATEWAY_ROTATE_SECRETS',
]);

export const APPROVAL_TYPES = ROWS.map(r => r[0]) as readonly string[];
export type ApprovalType = string;

export const CATALOGUE: Record<string, TypeMeta> = Object.fromEntries(
  ROWS.map(r => [
    r[0],
    {
      type: r[0],
      label: r[1],
      owner: r[2],
      entityType: r[3],
      approvePermission: r[4],
      viewPermission: r[5],
      requestPermission: r[6],
      isMoney: r[7] === 1,
      residentVisible: r[8] === 1,
      allowBulk: r[9] === 1,
      allowsChanges: r[10] === 1,
      notifyRequester: r[11] === 1,
      alwaysStepUp: ALWAYS_STEP_UP.has(r[0]),
    } satisfies TypeMeta,
  ]),
);
export const isApprovalType = (t: string): boolean => Object.prototype.hasOwnProperty.call(CATALOGUE, t);
export const typeMeta = (t: string): TypeMeta | undefined => (isApprovalType(t) ? CATALOGUE[t] : undefined);

// ------------------------------------------------------------------ role labels (step names, "Waiting for Secretary")
const ROLE_LABEL: Record<string, string> = {
  chairman: 'Chairman',
  secretary: 'Secretary',
  treasurer: 'Treasurer',
  society_admin: 'Society Admin',
  committee_member: 'Committee Member',
  facility_manager: 'Facility Manager',
  accountant: 'Accountant',
};
export const roleLabel = (key: string): string =>
  ROLE_LABEL[key] ?? key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const NUMBER_WORD = ['', 'One', 'Two', 'Three', 'Four', 'Five'];
const list = (keys: string[], joiner: string) => keys.map(roleLabel).join(joiner);

/** Display name of a step built from its mode and roles ("Two of Chairman, Treasurer, Secretary"). */
export function stepName(mode: StepMode, roleKeys: string[], requiredCount: number | null): string {
  if (mode === 'N_OF')
    return `${NUMBER_WORD[requiredCount ?? 2] ?? requiredCount} of ${list(roleKeys, ', ')}`;
  if (mode === 'ALL_OF') return `All of ${list(roleKeys, ', ')}`;
  return list(roleKeys, ' or ');
}

const AUTO_WORDS = [...NUMBER_WORD.filter(Boolean), 'All', 'of', 'or', ...Object.values(ROLE_LABEL)].sort(
  (x, y) => y.length - x.length,
);
/** True when a step name is one `stepName` could have produced for the well-known roles (it follows the roles, not a person's wording). */
const looksAutomatic = (name: string): boolean => {
  let rest = name;
  for (const w of AUTO_WORDS) rest = rest.split(w).join(' ');
  return /^[\s,]*$/.test(rest);
};
/** The step name for the CURRENT roles: an automatic name is rebuilt (a rule whose approvers changed), a typed name is kept. */
export function freshStepName(step: {
  name: string;
  mode: StepMode;
  roleKeys: string[];
  userIds: number[];
  requiredCount: number | null;
}): string {
  if (!step.roleKeys.length || step.userIds.length) return step.name;
  return !step.name || looksAutomatic(step.name)
    ? stepName(step.mode, step.roleKeys, step.requiredCount)
    : step.name;
}

// ------------------------------------------------------------------ 7.5 default rules
export interface DefaultRule {
  priority: number;
  name: string;
  minAmountPaise: number;
  maxAmountPaise: number | null;
  action: 'REQUIRE_APPROVAL' | 'AUTO_APPROVE';
  steps: RuleStep[];
}
const any = (...roles: string[]): RuleStep[] => [
  {
    stepNo: 1,
    name: stepName('ANY_OF', roles, null),
    mode: 'ANY_OF',
    roleKeys: roles,
    userIds: [],
    requiredCount: null,
  },
];
const two = (...roles: string[]): RuleStep[] => [
  {
    stepNo: 1,
    name: stepName('N_OF', roles, 2),
    mode: 'N_OF',
    roleKeys: roles,
    userIds: [],
    requiredCount: 2,
  },
];
const rule = (
  priority: number,
  name: string,
  min: number,
  max: number | null,
  steps: RuleStep[] | 'AUTO',
): DefaultRule => ({
  priority,
  name,
  minAmountPaise: min,
  maxAmountPaise: max,
  action: steps === 'AUTO' ? 'AUTO_APPROVE' : 'REQUIRE_APPROVAL',
  steps: steps === 'AUTO' ? [] : steps,
});
const TRI = ['chairman', 'treasurer', 'secretary'];

export const DEFAULT_RULES: Record<string, DefaultRule[]> = {
  EXPENSE: [
    rule(10, 'Small expenses', 0, 500_000, 'AUTO'),
    rule(20, 'Expenses up to ₹25,000', 500_001, 2_500_000, any('treasurer', 'chairman')),
    rule(30, 'Expenses above ₹25,000', 2_500_001, null, two(...TRI)),
  ],
  PAYMENT_REFUND: [
    rule(10, 'Refunds up to ₹25,000', 0, 2_500_000, any('treasurer', 'chairman')),
    rule(20, 'Refunds above ₹25,000', 2_500_001, null, two(...TRI)),
  ],
  OFFLINE_PAYMENT: [rule(10, 'Offline payments', 0, null, any('treasurer', 'chairman'))],
  INVOICE_CANCEL: [rule(10, 'Invoice cancellation', 0, null, any('treasurer', 'chairman'))],
  BILLING_RUN_PUBLISH: [rule(10, 'Billing runs', 0, null, any('treasurer', 'chairman'))],
  CREDIT_NOTE: [
    rule(10, 'Small credit notes', 0, 1_000_000, 'AUTO'),
    rule(20, 'Credit notes above ₹10,000', 1_000_001, null, any('treasurer', 'chairman')),
  ],
  WRITE_OFF: [rule(10, 'Write-offs', 0, null, two(...TRI))],
  COLLECTION_PUBLISH: [rule(10, 'Collections', 0, null, any('chairman', 'treasurer'))],
  JOIN_REQUEST: [rule(10, 'Join requests', 0, null, any('secretary', 'chairman'))],
  MOVE_IN: [rule(10, 'Move-in', 0, null, any('secretary', 'chairman'))],
  MOVE_OUT: [rule(10, 'Move-out', 0, null, any('secretary', 'chairman'))],
  RENOVATION_PERMIT: [rule(10, 'Renovation permits', 0, null, any('secretary', 'chairman'))],
  OWNERSHIP_TRANSFER: [
    rule(10, 'Ownership transfer', 0, null, two('chairman', 'secretary', 'society_admin')),
  ],
  PURCHASE_ORDER: [
    rule(10, 'POs up to ₹25,000', 0, 2_500_000, any('treasurer', 'secretary')),
    rule(20, 'POs above ₹25,000', 2_500_001, null, two(...TRI)),
  ],
  VENDOR_BILL: [
    rule(10, 'Vendor bills up to ₹1,00,000', 0, 10_000_000, any('treasurer', 'chairman')),
    rule(20, 'Vendor bills above ₹1,00,000', 10_000_001, null, two(...TRI)),
  ],
  NOTICE_PUBLISH: [rule(10, 'Notices', 0, null, any('chairman', 'secretary'))],
  BOOKING: [rule(10, 'Bookings', 0, null, any('facility_manager', 'secretary'))],
  SUBSCRIPTION_CANCEL: [
    rule(10, 'Subscription cancellation', 0, null, any('chairman', 'society_admin', 'treasurer')),
  ],
  DEPOSIT_REFUND: [rule(10, 'Deposit refunds', 0, null, any('treasurer', 'chairman'))],
  FINE_WAIVER: [rule(10, 'Fine waivers', 0, null, any('chairman', 'secretary'))],
  MANUAL_JOURNAL: [rule(10, 'Manual journals', 0, null, any('treasurer', 'chairman'))],
  FUND_TRANSFER: [rule(10, 'Fund transfers', 0, null, any('treasurer', 'chairman'))],
  PERIOD_UNLOCK: [rule(10, 'Period unlock', 0, null, two(...TRI))],
  CERTIFICATE_REQUEST: [rule(10, 'Certificates', 0, null, any('secretary', 'chairman'))],
  SHARE_CERTIFICATE_ACTION: [
    rule(10, 'Share certificate actions', 0, null, two('chairman', 'secretary', 'treasurer')),
  ],
  GATEWAY_ACTIVATE: [rule(10, 'Gateway activation (always step-up)', 0, null, two(...TRI))],
  GATEWAY_ROTATE_SECRETS: [rule(10, 'Gateway secret rotation (always step-up)', 0, null, two(...TRI))],
  AUTOMATION_RULE_ACTIVATE: [
    rule(10, 'Resident-facing automation rules', 0, null, any('chairman', 'secretary')),
  ],
  MINUTES: [rule(10, 'Meeting minutes', 0, null, any('chairman', 'secretary'))],
  BILLING_RULE_CHANGE: [rule(10, 'Billing rule changes', 0, null, two(...TRI))],
  LATE_FEE_POLICY_CHANGE: [rule(10, 'Late fee policy changes', 0, null, two(...TRI))],
};
