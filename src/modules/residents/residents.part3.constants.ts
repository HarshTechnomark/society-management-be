/** Names, enums and limits of module 09 part 3 (renovation permits and ownership transfers, sections 5.7, 5.8, 7.7, 7.8). */
export const PART3_JOBS = {
  renovationDaily: 'residents:renovation-daily',
} as const;

export const FEATURE3 = {
  permits: 'residents.renovation_permits',
  transfers: 'residents.ownership_transfer',
} as const;

export const ENTITY3 = {
  permit: 'renovation_permit',
  transfer: 'ownership_transfer',
} as const;

export const AUDIT3 = {
  permitCreated: 'residents.renovation_permit.created',
  permitUpdated: 'residents.renovation_permit.updated',
  permitDepositPaid: 'residents.renovation_permit.deposit_paid',
  permitApproved: 'residents.renovation_permit.approved',
  permitRejected: 'residents.renovation_permit.rejected',
  permitChangesRequested: 'residents.renovation_permit.changes_requested',
  permitResubmitted: 'residents.renovation_permit.resubmitted',
  permitStarted: 'residents.renovation_permit.started',
  permitExtended: 'residents.renovation_permit.extended',
  permitViolation: 'residents.renovation_permit.violation_recorded',
  permitSuspended: 'residents.renovation_permit.suspended',
  permitResumed: 'residents.renovation_permit.resumed',
  permitWorkDone: 'residents.renovation_permit.work_done',
  permitInspected: 'residents.renovation_permit.inspected',
  permitCompleted: 'residents.renovation_permit.completed',
  permitCancelled: 'residents.renovation_permit.cancelled',
  transferCreated: 'residents.ownership_transfer.created',
  transferUpdated: 'residents.ownership_transfer.updated',
  transferSubmitted: 'residents.ownership_transfer.submitted',
  transferApproved: 'residents.ownership_transfer.approved',
  transferRejected: 'residents.ownership_transfer.rejected',
  transferChangesRequested: 'residents.ownership_transfer.changes_requested',
  transferResubmitted: 'residents.ownership_transfer.resubmitted',
  transferCompleted: 'residents.ownership_transfer.completed',
  transferCancelled: 'residents.ownership_transfer.cancelled',
} as const;

// ------------------------------------------------------------------ renovation permits
export const WORK_CATEGORIES = [
  'INTERIOR',
  'CIVIL',
  'PLUMBING',
  'ELECTRICAL',
  'CARPENTRY',
  'PAINTING',
  'FLOORING',
  'WATERPROOFING',
  'KITCHEN',
  'BATHROOM',
  'OTHER',
] as const;
export const PERMIT_DOC_TYPES = ['CONTRACTOR_ID', 'WORK_PLAN', 'STRUCTURAL_CERTIFICATE', 'OTHER'] as const;
export const VIOLATION_CATEGORIES = [
  'OUTSIDE_HOURS',
  'NOISE',
  'DEBRIS',
  'COMMON_AREA_DAMAGE',
  'UNAUTHORISED_WORK',
  'SAFETY',
  'OTHER',
] as const;
export const PERMIT_STATUSES = [
  'PENDING_DEPOSIT',
  'PENDING_APPROVAL',
  'APPROVED',
  'IN_PROGRESS',
  'SUSPENDED',
  'INSPECTION_PENDING',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
] as const;
/** BR-09-50: the furthest start date ahead, in days. */
export const PERMIT_START_WINDOW_DAYS = 60;
/** BR-09-57. */
export const PERMIT_MAX_EXTENSIONS = 3;

// ------------------------------------------------------------------ ownership transfers
export const TRANSFER_TYPES = [
  'SALE',
  'GIFT',
  'INHERITANCE',
  'NOMINATION',
  'COURT_ORDER',
  'FAMILY_SETTLEMENT',
] as const;
export type TransferType = (typeof TRANSFER_TYPES)[number];
export const TRANSFER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
] as const;
export const DUES_POLICIES = ['MUST_CLEAR', 'CARRY_WITH_UNIT'] as const;
/** The document types a transfer accepts (BR-09-63). */
export const TRANSFER_DOC_TYPES = [
  'SALE_DEED',
  'INDEX_II',
  'STAMP_DUTY_RECEIPT',
  'ORIGINAL_SHARE_CERTIFICATE',
  'MEMBERSHIP_APPLICATION',
  'NOC',
  'DEATH_CERTIFICATE',
  'SUCCESSION_CERTIFICATE',
  'OTHER',
] as const;
/** BR-09-64 caps (Maharashtra model bye-laws), in paise. */
export const TRANSFER_PREMIUM_CAP = 2_500_000;
export const SHARE_TRANSFER_FEE_CAP = 50_000;
export const ENTRANCE_FEE_CAP = 10_000;
/** BR-09-62: how far ahead an effective date may lie. */
export const TRANSFER_AHEAD_DAYS = 30;
export const MAX_BUYERS = 6;
/** BR-09-65 charge head keys. */
export const CHARGE_HEAD = {
  premium: 'TRANSFER_PREMIUM',
  shareFee: 'SHARE_TRANSFER_FEE',
  entrance: 'ENTRANCE_FEE',
  renovation: 'RENOVATION_FEE',
} as const;
/** BR-09-65: fees fall due this many days after approval. */
export const TRANSFER_FEE_DUE_DAYS = 7;
