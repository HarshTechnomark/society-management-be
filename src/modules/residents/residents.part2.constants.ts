/** Names and vocabulary added by module 09 part 2 (join requests, tenancies, move requests). */
export const JOBS2 = {
  tenancyReminders: 'residents:tenancy-reminders',
  policeReminders: 'residents:police-reminders',
  joinRequests: 'residents:join-requests',
  depositRefunds: 'residents:deposit-refunds',
} as const;

export const FEATURE2 = {
  moveIn: 'residents.move_in_workflow',
  moveOut: 'residents.move_out_workflow',
  slotAndLift: 'residents.moving_slot_and_lift_booking',
  police: 'residents.police_verification_tracking',
  agreementReminders: 'residents.agreement_expiry_reminders',
} as const;

export const ENTITY2 = {
  tenancy: 'tenancy',
  joinRequest: 'join_request',
  moveRequest: 'move_request',
} as const;

/** Section 9.2, part 2 actions. Audit key names avoid `code`, `token` and `secret` (the redaction masks them). */
export const AUDIT2 = {
  tenancyCreated: 'residents.tenancy.created',
  tenancyUpdated: 'residents.tenancy.updated',
  tenancySubmitted: 'residents.tenancy.submitted',
  tenancyApproved: 'residents.tenancy.approved',
  tenancyRejected: 'residents.tenancy.rejected',
  tenancyActivated: 'residents.tenancy.activated',
  tenancyRenewed: 'residents.tenancy.renewed',
  tenancyEnded: 'residents.tenancy.ended',
  tenancyCancelled: 'residents.tenancy.cancelled',
  tenancyOverstayed: 'residents.tenancy.overstayed',
  tenancyPolice: 'residents.tenancy.police_verification_updated',
  joinSubmitted: 'residents.join_request.submitted',
  joinOwnerConfirmed: 'residents.join_request.owner_confirmed',
  joinOwnerDeclined: 'residents.join_request.owner_declined',
  joinEscalated: 'residents.join_request.escalated',
  joinApproved: 'residents.join_request.approved',
  joinRejected: 'residents.join_request.rejected',
  joinExpired: 'residents.join_request.expired',
  joinWithdrawn: 'residents.join_request.withdrawn',
  moveCreated: 'residents.move_request.created',
  moveOwnerConfirmed: 'residents.move_request.owner_confirmed',
  moveOwnerDeclined: 'residents.move_request.owner_declined',
  moveDuesBlocked: 'residents.move_request.dues_blocked',
  moveDuesRechecked: 'residents.move_request.dues_rechecked',
  moveDuesOverridden: 'residents.move_request.dues_overridden',
  moveDepositPaid: 'residents.move_request.deposit_paid',
  moveApproved: 'residents.move_request.approved',
  moveRejected: 'residents.move_request.rejected',
  moveChangesRequested: 'residents.move_request.changes_requested',
  moveResubmitted: 'residents.move_request.resubmitted',
  moveStarted: 'residents.move_request.started',
  moveCompleted: 'residents.move_request.completed',
  moveInspected: 'residents.move_request.inspected',
  moveRefundRequested: 'residents.move_request.refund_requested',
  moveCancelled: 'residents.move_request.cancelled',
} as const;

export const TENANCY_DOC_TYPES = [
  'RENT_AGREEMENT',
  'POLICE_VERIFICATION',
  'NOC',
  'AADHAAR',
  'PAN',
  'PASSPORT',
  'DRIVING_LICENCE',
  'VOTER_ID',
  'OTHER_ID',
] as const;
export const AGREEMENT_TYPES = ['LEAVE_AND_LICENCE', 'LEASE', 'OTHER'] as const;
export const POLICE_STATUSES = [
  'NOT_REQUIRED',
  'NOT_SUBMITTED',
  'SUBMITTED',
  'VERIFIED',
  'REJECTED',
] as const;
export const TENANCY_END_REASONS = ['MOVED_OUT', 'AGREEMENT_ENDED', 'TERMINATED', 'OTHER'] as const;
export const TENANCY_STATUSES_ALL = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ACTIVE',
  'EXPIRED_OVERSTAY',
  'ENDED',
  'REJECTED',
  'CANCELLED',
] as const;
export const JOIN_STATUSES_ALL = [
  'PENDING_OWNER',
  'PENDING_ADMIN',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'WITHDRAWN',
] as const;
export const JOIN_RELATIONS = ['OWNER', 'CO_OWNER', 'TENANT', 'FAMILY', 'CARETAKER'] as const;
export const MOVE_STATUSES_ALL = [
  'PENDING_OWNER',
  'BLOCKED_DUES',
  'PENDING_DEPOSIT',
  'PENDING_APPROVAL',
  'APPROVED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
] as const;
export const MOVE_TYPES = ['MOVE_IN', 'MOVE_OUT'] as const;
export const MOVE_DOC_TYPES = ['NOC', 'OTHER'] as const;
/** Documents a join request needs (BR-09-23). `ORIGINAL_SHARE_CERTIFICATE` is the share certificate type of 7.4. */
export const OWNERSHIP_PROOF_TYPES = ['SALE_DEED', 'INDEX_II', 'ORIGINAL_SHARE_CERTIFICATE'] as const;

export const GATE_PASS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_OWNER_WAIT_DAYS = 3;
