/**
 * Names, enums, limits and keys of module 14 (sections 2, 5, 7, 9, 10 and 12). The enums are shared with the migrations'
 * CHECKs and with Zod (`z.enum(X)`); keep the lists identical.
 */
export const APPROVALS_QUEUE = 'approvals';

/** Section 2 permission keys (no new keys; the catalogue of module 03 already has them). */
export const PERM = {
  inboxView: 'approvals.inbox.view',
  rulesView: 'settings.approval_rules.view',
  rulesEdit: 'settings.approval_rules.edit',
  residentRequestsView: 'resident.requests.view',
  residentRequestsCreate: 'resident.requests.create',
  residentAmenitiesView: 'resident.amenities.view',
  residentAmenitiesCreate: 'resident.amenities.create',
  contactsView: 'residents.contacts.view',
  todayView: 'dashboard.today.view',
} as const;

/** Section 2.2 entitlement keys. */
export const ENT = {
  unifiedInbox: 'approvals.unified_inbox',
  delegation: 'iam.approval_delegation',
} as const;

/** Module 08 setting keys (7.6); already in the registry of `society-setup`. */
export const SETTING = {
  stepUpAbovePaise: 'approvals.stepUpAbovePaise',
  bulkApproveBelowPaise: 'approvals.bulkApproveBelowPaise',
} as const;
export const DEFAULT_STEP_UP_ABOVE_PAISE = 2_500_000;
export const DEFAULT_BULK_BELOW_PAISE = 2_500_000;

export const REQUEST_STATUS = [
  'PENDING',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUS)[number];
export const OPEN_STATUSES: readonly RequestStatus[] = ['PENDING', 'CHANGES_REQUESTED'];

export const ROUTING = ['STEPS', 'AUTO_RULE', 'AUTO_NO_RULE'] as const;
export type Routing = (typeof ROUTING)[number];
export const REQUESTER_KIND = ['ADMIN', 'RESIDENT', 'SYSTEM'] as const;
export type RequesterKind = (typeof REQUESTER_KIND)[number];

export const ACTION = [
  'SUBMITTED',
  'RESUBMITTED',
  'AUTO_APPROVED',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'CANCELLED',
  'EXPIRED',
  'REMINDED',
  'ESCALATED',
  'REASSIGNED',
] as const;
export type ActionKind = (typeof ACTION)[number];
export const SLOT_TYPE = ['ROLE', 'USER', 'FALLBACK', 'ESCALATION'] as const;
export type SlotType = (typeof SLOT_TYPE)[number];

export const RULE_ACTION = ['REQUIRE_APPROVAL', 'AUTO_APPROVE'] as const;
export type RuleAction = (typeof RULE_ACTION)[number];
export const STEP_MODE = ['ANY_OF', 'ALL_OF', 'N_OF'] as const;
export type StepMode = (typeof STEP_MODE)[number];

export const DELEGATION_SOURCE = ['OUT_OF_OFFICE', 'TERM_HANDOVER'] as const;
export const DELEGATION_STATUS = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;

export const LIMITS = {
  maxLiveRulesPerType: 20,
  maxSteps: 5,
  maxSlotsPerStep: 10,
  maxAllOfSlots: 5,
  payloadBytes: 16 * 1024,
  titleMin: 3,
  titleMax: 200,
  summaryMax: 500,
  reasonMin: 5,
  reasonMax: 500,
  commentMax: 500,
  maxAmountPaise: 10 ** 13,
  maxRemindersPerStep: 5,
  changesDueDays: 30,
  bulkMax: 50,
  inboxMax: 2000,
  /** Delegation windows (BR-14-24), in days. */
  outOfOfficeMaxDays: 90,
  handoverMaxDays: 60,
} as const;

/** Section 12 error codes owned by module 14. */
export const ERR = {
  validation: 'VALIDATION_FAILED',
  reauth: 'REAUTH_REQUIRED',
  featureNotInPlan: 'FEATURE_NOT_IN_PLAN',
  notEligible: 'NOT_ELIGIBLE_APPROVER',
  noDelegation: 'NO_ACTIVE_DELEGATION',
  notRequester: 'NOT_THE_REQUESTER',
  notFound: 'APPROVAL_NOT_FOUND',
  ruleNotFound: 'APPROVAL_RULE_NOT_FOUND',
  delegationNotFound: 'DELEGATION_NOT_FOUND',
  stale: 'STALE_VERSION',
  notPending: 'APPROVAL_NOT_PENDING',
  makerChecker: 'MAKER_CHECKER_VIOLATION',
  alreadyActed: 'APPROVER_ALREADY_ACTED',
  alreadyPending: 'APPROVAL_ALREADY_PENDING',
  ruleNameTaken: 'RULE_NAME_TAKEN',
  delegationOverlap: 'DELEGATION_OVERLAP',
  delegationNotActive: 'DELEGATION_NOT_ACTIVE',
  changesNotSupported: 'CHANGES_NOT_SUPPORTED',
  cancelNotSupported: 'CANCEL_NOT_SUPPORTED',
  onBehalfRequired: 'ON_BEHALF_REQUIRED',
  reassignTarget: 'REASSIGN_TARGET_NOT_ELIGIBLE',
  slotNotVacant: 'SLOT_NOT_VACANT',
  ruleLimit: 'RULE_LIMIT_REACHED',
  ruleAmountRange: 'RULE_AMOUNT_RANGE_INVALID',
  ruleSteps: 'RULE_STEPS_INVALID',
  stepRoleUnknown: 'STEP_ROLE_UNKNOWN',
  stepRoleLacksPermission: 'STEP_ROLE_LACKS_PERMISSION',
  stepUserNotEligible: 'STEP_USER_NOT_ELIGIBLE',
  stepCannotBeSatisfied: 'STEP_CANNOT_BE_SATISFIED',
  delegationSelf: 'DELEGATION_SELF',
  delegateNotEligible: 'DELEGATE_NOT_ELIGIBLE',
  delegationChain: 'DELEGATION_CHAIN_NOT_ALLOWED',
  delegationWindow: 'DELEGATION_WINDOW_INVALID',
  internal: 'INTERNAL_ERROR',
  /** Per-item bulk result (inside a 200). */
  bulkNotAllowed: 'BULK_NOT_ALLOWED',
} as const;
/** Rule warnings (inside 200/201). */
export const WARN = {
  shadowed: 'RULE_SHADOWED',
  coverageGap: 'COVERAGE_GAP',
  unsatisfiable: 'RULE_MAY_BE_UNSATISFIABLE',
} as const;

/** Section 9.1 jobs (queue `approvals`). */
export const JOB = {
  slaSweep: 'approvals:sla-sweep',
  notifyApprovers: 'approvals:notify-approvers',
  delegationSweep: 'approvals:delegation-sweep',
  recheckMember: 'approvals:recheck-member',
  ruleHealth: 'approvals:rule-health',
} as const;

/** Section 9.2 audit actions and entity types. */
export const AUDIT = {
  created: 'approvals.request.created',
  autoApproved: 'approvals.request.auto_approved',
  stepApproved: 'approvals.request.step_approved',
  approved: 'approvals.request.approved',
  rejected: 'approvals.request.rejected',
  changesRequested: 'approvals.request.changes_requested',
  resubmitted: 'approvals.request.resubmitted',
  cancelled: 'approvals.request.cancelled',
  expired: 'approvals.request.expired',
  escalated: 'approvals.request.escalated',
  reassigned: 'approvals.request.reassigned',
  stuck: 'approvals.request.stuck',
  unstuck: 'approvals.request.unstuck',
  bulkApproved: 'approvals.request.bulk_approved',
  ruleCreated: 'approvals.rule.created',
  ruleUpdated: 'approvals.rule.updated',
  ruleDeleted: 'approvals.rule.deleted',
  ruleReset: 'approvals.rule.reset',
  ruleSeeded: 'approvals.rule.seeded',
  settingsUpdated: 'approvals.settings.updated',
  delegationCreated: 'approvals.delegation.created',
  delegationRevoked: 'approvals.delegation.revoked',
  delegationExpired: 'approvals.delegation.expired',
} as const;
export const ENTITY = {
  request: 'approval_request',
  rule: 'approval_rule',
  delegation: 'approval_delegation',
  settings: 'approval_settings',
} as const;

/** Section 9.3 realtime. */
export const RT = {
  changed: 'approvals.changed',
  requestUpdated: 'approvals.request.updated',
  stuck: 'approvals.stuck',
  delegationUpdated: 'approvals.delegation.updated',
} as const;
export const adminRoom = (societyId: number): string => `society:${societyId}:admin`;

/** Section 10 notification template keys. */
export const NOTIFY = {
  pending: 'approvals.pending',
  reminder: 'approvals.reminder',
  escalated: 'approvals.escalated',
  approved: 'approvals.approved',
  rejected: 'approvals.rejected',
  changesRequested: 'approvals.changes_requested',
  expired: 'approvals.expired',
  closed: 'approvals.closed',
  unroutable: 'approvals.unroutable',
  ruleHealth: 'approvals.rule_health',
  delegationCreated: 'approvals.delegation_created',
  delegationEnding: 'approvals.delegation_ending',
  delegationRevoked: 'approvals.delegation_revoked',
} as const;

/** Public (resident-visible) status labels. */
export const STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: 'Waiting',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};
