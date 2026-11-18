/**
 * Names, enums, limits and keys of module 15 (sections 2, 5, 6, 7, 9, 10 and 12). The enums are shared with the migrations' CHECKs
 * and with Zod (`z.enum(X)`); keep the lists identical.
 */
export const HELPDESK_QUEUE = 'helpdesk';

/** Section 2 permission keys. */
export const PERM = {
  ticketsView: 'helpdesk.tickets.view',
  ticketsCreate: 'helpdesk.tickets.create',
  ticketsEdit: 'helpdesk.tickets.edit',
  ticketsDelete: 'helpdesk.tickets.delete',
  ticketsExport: 'helpdesk.tickets.export',
  settingsView: 'helpdesk.settings.view',
  settingsEdit: 'helpdesk.settings.edit',
  residentView: 'resident.helpdesk.view',
  residentCreate: 'resident.helpdesk.create',
  residentEdit: 'resident.helpdesk.edit',
  workTasksView: 'work.tasks.view',
  workTasksEdit: 'work.tasks.edit',
  gateBuildingIssues: 'gate.building_issues.create',
  workBuildingIssues: 'work.building_issues.create',
  contactsView: 'residents.contacts.view',
  dashboardToday: 'dashboard.today.view',
} as const;

/** Section 2 entitlement keys. */
export const ENT = {
  buildingIssueByAnyone: 'helpdesk.building_issue_reporting_by_anyone',
  affectedResidentsUpdates: 'helpdesk.affected_residents_updates',
  raiseTicket: 'helpdesk.raise_ticket',
  categoryCatalogue: 'helpdesk.category_catalogue',
  slaPolicies: 'helpdesk.sla_policies',
  autoAssignment: 'helpdesk.auto_assignment',
  escalationMatrix: 'helpdesk.escalation_matrix',
  statusWorkflow: 'helpdesk.status_workflow',
  attachments: 'helpdesk.attachments',
  beforeAfterPhotos: 'helpdesk.before_after_photos',
  internalNotes: 'helpdesk.comments_internal_notes',
  chargeableWork: 'helpdesk.chargeable_work_estimates',
  duplicateDetection: 'helpdesk.duplicate_detection',
  csat: 'helpdesk.csat_rating',
  recurring: 'helpdesk.recurring_issue_detection',
  analytics: 'helpdesk.helpdesk_analytics',
  preferredSlot: 'helpdesk.preferred_visit_slot',
  autoClose: 'helpdesk.auto_close_after_resolve',
  meTooUpvotes: 'helpdesk.me_too_upvotes',
  qr: 'helpdesk.qr_code_ticketing',
  businessCalendar: 'helpdesk.sla_business_calendar',
  communityBoard: 'helpdesk.public_community_issue_board',
  staffWebWorkflow: 'helpdesk.staff_web_workflow',
  staffWorkerMaster: 'staff.worker_master',
  vendorDispatch: 'helpdesk.vendor_dispatch_from_ticket',
  transparencyBoard: 'helpdesk.committee_transparency_board',
} as const;

/** Section 7.9 settings (namespace `helpdesk.*`, registered by module 08). */
export const SETTING = {
  autoCloseHours: 'helpdesk.autoCloseHours',
  reopenWindowDays: 'helpdesk.reopenWindowDays',
  maxReopens: 'helpdesk.maxReopens',
  waitingReminderHours: 'helpdesk.waitingReminderHours',
  waitingAutoResolveDays: 'helpdesk.waitingAutoResolveDays',
  duplicateWindowHours: 'helpdesk.duplicateWindowHours',
  upvoteRaiseThreshold: 'helpdesk.upvoteRaiseThreshold',
  lowCsatThreshold: 'helpdesk.lowCsatThreshold',
  recurringCount: 'helpdesk.recurringCount',
  recurringWindowDays: 'helpdesk.recurringWindowDays',
  chargeTolerancePct: 'helpdesk.chargeTolerancePct',
  chargeDueDays: 'helpdesk.chargeDueDays',
  showReporter: 'helpdesk.showReporterOnBuildingIssues',
  unassignedReminderMinutes: 'helpdesk.unassignedReminderMinutes',
  residentDailyLimit: 'helpdesk.residentDailyTicketLimit',
} as const;

/** Entity types (audit `entityType`, files `linkedEntityType`). */
export const ENTITY = {
  ticket: 'ticket',
  ticketComment: 'ticket_comment',
  category: 'ticket_category',
  slaPolicy: 'sla_policy',
  escalationRule: 'escalation_rule',
  upvote: 'ticket_upvote',
} as const;

/** Section 9.1 jobs of queue `helpdesk`. */
export const JOBS = {
  slaSweep: 'helpdesk:sla-sweep',
  autoClose: 'helpdesk:auto-close',
  waitingFollowup: 'helpdesk:waiting-followup',
  unassignedReminder: 'helpdesk:unassigned-reminder',
  fanout: 'helpdesk:fanout',
  escalationNotify: 'helpdesk:escalation-notify',
  dailyDigest: 'helpdesk:daily-digest',
  seed: 'helpdesk:seed',
} as const;

// ------------------------------------------------------------------ enums (section 7)
export const TICKET_KINDS = ['PERSONAL', 'BUILDING'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_SOURCES = ['CATEGORY', 'REPORTER', 'ADMIN', 'AUTO_UPVOTES'] as const;
export type PrioritySource = (typeof PRIORITY_SOURCES)[number];
export const TICKET_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING_ON_RESIDENT',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
  'CANCELLED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
/** Statuses in which a ticket still needs work (BR-15-17, BR-15-20, openDisputeKey). */
export const NON_TERMINAL = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_RESIDENT', 'REOPENED'] as const;
export const TERMINAL = ['RESOLVED', 'CLOSED', 'CANCELLED'] as const;
/** BR-15-37: statuses that count as a current load for auto-assignment. */
export const LOAD_STATUSES = ['ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_RESIDENT', 'REOPENED'] as const;
export const CHANNELS = ['APP', 'QR', 'PHONE', 'WALK_IN', 'GATE', 'STAFF_APP', 'SYSTEM'] as const;
export type Channel = (typeof CHANNELS)[number];
export const REPORTER_ROLES = ['RESIDENT', 'GUARD', 'STAFF', 'COMMITTEE', 'OFFICE'] as const;
export type ReporterRole = (typeof REPORTER_ROLES)[number];
export const URGENCIES = ['NORMAL', 'URGENT', 'EMERGENCY'] as const;
export type Urgency = (typeof URGENCIES)[number];
export const AFFECTED_LEVELS = ['SOCIETY', 'BUILDING', 'FLOOR'] as const;
export type AffectedLevel = (typeof AFFECTED_LEVELS)[number];
export const SLA_CALENDARS = ['TWENTY_FOUR_SEVEN', 'BUSINESS_HOURS'] as const;
export type SlaCalendar = (typeof SLA_CALENDARS)[number];
export const SLA_STATES = ['NONE', 'MET', 'BREACHED', 'PAUSED', 'AT_RISK', 'ON_TRACK'] as const;
export type SlaState = (typeof SLA_STATES)[number];
export const WAITING_REASONS = [
  'INFORMATION',
  'ACCESS_TO_FLAT',
  'ESTIMATE_APPROVAL',
  'CONFIRMATION',
  'OTHER',
] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];
export const CHARGE_STATUSES = [
  'NONE',
  'ESTIMATE_SENT',
  'APPROVED',
  'REJECTED',
  'INVOICED',
  'WAIVED',
] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];
export const CLOSE_SOURCES = ['RESIDENT', 'ADMIN', 'AUTO'] as const;
export type CloseSource = (typeof CLOSE_SOURCES)[number];

export const CATEGORY_SCOPES = ['PERSONAL', 'BUILDING', 'BOTH'] as const;
export type CategoryScope = (typeof CATEGORY_SCOPES)[number];
export const DEFAULT_ASSIGNEE_TYPES = ['INHERIT', 'NONE', 'ROLE', 'MEMBER', 'STAFF', 'VENDOR'] as const;
export type DefaultAssigneeType = (typeof DEFAULT_ASSIGNEE_TYPES)[number];
export const CATEGORY_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];
export const POLICY_STATUSES = CATEGORY_STATUSES;
export type PolicyStatus = CategoryStatus;

export const COMMENT_KINDS = [
  'COMMENT',
  'STATUS_CHANGE',
  'ASSIGNMENT',
  'PRIORITY_CHANGE',
  'ESCALATION',
  'MERGE',
  'ESTIMATE',
  'RATING',
  'SYSTEM',
] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
export const VISIBILITIES = ['PUBLIC', 'INTERNAL'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const AUTHOR_ROLES = ['RESIDENT', 'ADMIN', 'STAFF', 'VENDOR', 'GUARD', 'SYSTEM'] as const;
export type AuthorRole = (typeof AUTHOR_ROLES)[number];
export const UPVOTE_SOURCES = ['ME_TOO', 'MERGE'] as const;
export type UpvoteSource = (typeof UPVOTE_SOURCES)[number];

export const ASSIGNEE_TYPES = ['MEMBER', 'STAFF', 'VENDOR', 'EXTERNAL'] as const;
export type AssigneeType = (typeof ASSIGNEE_TYPES)[number];
export const ASSIGNMENT_METHODS = ['AUTO_CATEGORY', 'MANUAL', 'REOPEN'] as const;
export type AssignmentMethod = (typeof ASSIGNMENT_METHODS)[number];
export const ASSIGNMENT_END_REASONS = [
  'REASSIGNED',
  'UNASSIGNED',
  'CANCELLED',
  'MERGED',
  'WORK_ORDER_CANCELLED',
  'ASSIGNEE_INACTIVE',
] as const;
export type AssignmentEndReason = (typeof ASSIGNMENT_END_REASONS)[number];

export const TRIGGER_TYPES = ['RESPONSE_SLA', 'RESOLUTION_SLA', 'RESIDENT_REQUEST', 'LOW_CSAT'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const TARGET_TYPES = ['ROLE', 'DESIGNATION', 'MEMBER'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];
export const RULE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export const DESIGNATIONS = [
  'CHAIRMAN',
  'VICE_CHAIRMAN',
  'SECRETARY',
  'JOINT_SECRETARY',
  'TREASURER',
  'MEMBER',
] as const;
export type Designation = (typeof DESIGNATIONS)[number];

// ------------------------------------------------------------------ limits
export const LIMITS = {
  maxActiveTopCategories: 40,
  maxSubCategoriesPerParent: 30,
  maxActivePolicies: 20,
  maxActiveRules: 30,
  maxSlaMinutes: 129_600,
  minResponseMinutes: 5,
  maxFiles: 6,
  titleMin: 5,
  titleMax: 150,
  personalDescMin: 10,
  descMax: 2000,
  commentMax: 2000,
  commentDeleteWindowMinutes: 15,
  similarMax: 5,
  personalSimilarDays: 7,
  residentEscalationGapHours: 24,
  broadcastsPerDay: 5,
  commentsPerHour: 60,
  exportMaxRows: 20_000,
  chargeMinPaise: 100,
  chargeMaxPaise: 10_000_000,
  businessSearchDays: 400,
  atRiskFraction: 0.25,
  workDoneVisibleDays: 7,
  maxSlaCycle: 11,
} as const;

/** BR-15-8: urgency to priority. */
export const URGENCY_PRIORITY: Record<Urgency, Priority> = { NORMAL: 'P3', URGENT: 'P2', EMERGENCY: 'P1' };

// ------------------------------------------------------------------ state machine (section 6.2)
export const ACTIONS = [
  'START',
  'WAIT_ON_RESIDENT',
  'RESUME',
  'RESOLVE',
  'CLOSE',
  'REOPEN',
  'CANCEL',
] as const;
export type TransitionAction = (typeof ACTIONS)[number];
/** Who may perform an action (6.2 columns "by"): admin = `helpdesk.tickets.edit`, assignee = BR-15-53 with `work.tasks.edit`,
 * requester / unitResident / upvoter = resident rules, system = jobs and hooks. */
export type CallerType = 'ADMIN' | 'ASSIGNEE' | 'REQUESTER' | 'UNIT_RESIDENT' | 'UPVOTER' | 'SYSTEM';

/** Audit actions of section 9.3. */
export const AUDIT = {
  categoryCreated: 'helpdesk.category.created',
  categoryUpdated: 'helpdesk.category.updated',
  categoryArchived: 'helpdesk.category.archived',
  categoryRestored: 'helpdesk.category.restored',
  slaPolicyCreated: 'helpdesk.sla_policy.created',
  slaPolicyUpdated: 'helpdesk.sla_policy.updated',
  slaPolicyDefaultChanged: 'helpdesk.sla_policy.default_changed',
  slaPolicyArchived: 'helpdesk.sla_policy.archived',
  ruleCreated: 'helpdesk.escalation_rule.created',
  ruleUpdated: 'helpdesk.escalation_rule.updated',
  ruleDeleted: 'helpdesk.escalation_rule.deleted',
  ticketCreated: 'helpdesk.ticket.created',
  ticketUpdated: 'helpdesk.ticket.updated',
  priorityChanged: 'helpdesk.ticket.priority_changed',
  assigned: 'helpdesk.ticket.assigned',
  unassigned: 'helpdesk.ticket.unassigned',
  statusChanged: 'helpdesk.ticket.status_changed',
  resolved: 'helpdesk.ticket.resolved',
  closed: 'helpdesk.ticket.closed',
  reopened: 'helpdesk.ticket.reopened',
  cancelled: 'helpdesk.ticket.cancelled',
  merged: 'helpdesk.ticket.merged',
  escalated: 'helpdesk.ticket.escalated',
  estimateSent: 'helpdesk.ticket.estimate_sent',
  estimateDecided: 'helpdesk.ticket.estimate_decided',
  chargeInvoiced: 'helpdesk.ticket.charge_invoiced',
  chargeWaived: 'helpdesk.ticket.charge_waived',
  rated: 'helpdesk.ticket.rated',
  contactViewed: 'helpdesk.ticket.contact_viewed',
  commentAdded: 'helpdesk.comment.added',
  commentRemoved: 'helpdesk.comment.removed',
  upvoteAdded: 'helpdesk.upvote.added',
  upvoteRemoved: 'helpdesk.upvote.removed',
  exported: 'helpdesk.tickets.exported',
} as const;

/** Section 9.4 realtime events and rooms. */
export const RT = {
  ticketChanged: 'helpdesk.ticket.changed',
  countsChanged: 'helpdesk.counts.changed',
  buildingIssueChanged: 'helpdesk.building_issue.changed',
  assignmentChanged: 'helpdesk.assignment.changed',
  safetyRaised: 'helpdesk.safety_issue.raised',
} as const;
export const roomAdmin = (societyId: number): string => `society:${societyId}:admin`;
export const roomGate = (societyId: number): string => `society:${societyId}:gate`;
export const roomUnit = (unitId: number): string => `unit:${unitId}`;

/** Section 10 notification template keys. */
export const NOTIFY = {
  created: 'helpdesk.ticket_created',
  assigned: 'helpdesk.ticket_assigned',
  assignedResident: 'helpdesk.ticket_assigned_resident',
  statusChanged: 'helpdesk.ticket_status_changed',
  waiting: 'helpdesk.ticket_waiting_on_resident',
  waitingReminder: 'helpdesk.waiting_reminder',
  resolved: 'helpdesk.ticket_resolved',
  closed: 'helpdesk.ticket_closed',
  reopened: 'helpdesk.ticket_reopened',
  cancelled: 'helpdesk.ticket_cancelled',
  merged: 'helpdesk.ticket_merged',
  comment: 'helpdesk.ticket_comment',
  estimateSent: 'helpdesk.estimate_sent',
  estimateDecided: 'helpdesk.estimate_decided',
  slaEscalated: 'helpdesk.sla_escalated',
  escalationRequested: 'helpdesk.escalation_requested',
  lowCsat: 'helpdesk.low_csat',
  recurring: 'helpdesk.recurring_issue',
  unassignedReminder: 'helpdesk.unassigned_reminder',
  dailyDigest: 'helpdesk.daily_digest',
  buildingRaised: 'helpdesk.building_issue_raised',
  buildingUpdate: 'helpdesk.building_issue_update',
  urgentGate: 'helpdesk.building_issue_urgent_gate',
} as const;

/** Section 12 error codes. */
export const ERR = {
  validation: 'VALIDATION_FAILED',
  featureNotInPlan: 'FEATURE_NOT_IN_PLAN',
  permissionDenied: 'PERMISSION_DENIED',
  estimateApproverNotAllowed: 'ESTIMATE_APPROVER_NOT_ALLOWED',
  ticketNotFound: 'TICKET_NOT_FOUND',
  categoryNotFound: 'CATEGORY_NOT_FOUND',
  slaPolicyNotFound: 'SLA_POLICY_NOT_FOUND',
  escalationRuleNotFound: 'ESCALATION_RULE_NOT_FOUND',
  commentNotFound: 'COMMENT_NOT_FOUND',
  assigneeNotFound: 'ASSIGNEE_NOT_FOUND',
  residentNotFound: 'RESIDENT_NOT_FOUND',
  upvoteNotFound: 'UPVOTE_NOT_FOUND',
  qrNotFound: 'QR_NOT_FOUND',
  unitNotFound: 'UNIT_NOT_FOUND',
  locationNotFound: 'LOCATION_NOT_FOUND',
  invoiceNotFound: 'INVOICE_NOT_FOUND',
  fileNotFound: 'FILE_NOT_FOUND',
  invalidTransition: 'TICKET_INVALID_TRANSITION',
  invalidState: 'INVALID_STATE',
  staleVersion: 'STALE_VERSION',
  similarIssueExists: 'SIMILAR_ISSUE_EXISTS',
  alreadyUpvoted: 'ALREADY_UPVOTED',
  alreadyAssigned: 'ALREADY_ASSIGNED',
  invoiceDisputeOpen: 'INVOICE_DISPUTE_OPEN',
  categoryNameTaken: 'CATEGORY_NAME_TAKEN',
  slaPolicyNameTaken: 'SLA_POLICY_NAME_TAKEN',
  slaPolicyInUse: 'SLA_POLICY_IN_USE',
  categoryArchived: 'CATEGORY_ARCHIVED',
  categoryScopeMismatch: 'CATEGORY_SCOPE_MISMATCH',
  subcategoryParentMismatch: 'SUBCATEGORY_PARENT_MISMATCH',
  categoryDepthExceeded: 'CATEGORY_DEPTH_EXCEEDED',
  categoryDefaultsRequired: 'CATEGORY_DEFAULTS_REQUIRED',
  categoryLimitReached: 'CATEGORY_LIMIT_REACHED',
  defaultAssigneeInvalid: 'DEFAULT_ASSIGNEE_INVALID',
  slaTargetsInvalid: 'SLA_TARGETS_INVALID',
  defaultPolicyRequired: 'DEFAULT_POLICY_REQUIRED',
  slaPolicyLimitReached: 'SLA_POLICY_LIMIT_REACHED',
  escalationTargetInvalid: 'ESCALATION_TARGET_INVALID',
  escalationRuleLimitReached: 'ESCALATION_RULE_LIMIT_REACHED',
  locationArchived: 'LOCATION_ARCHIVED',
  affectedLevelInvalid: 'AFFECTED_LEVEL_INVALID',
  urgencyNotAllowed: 'URGENCY_NOT_ALLOWED',
  invoiceNotDisputable: 'INVOICE_NOT_DISPUTABLE',
  assigneeNotEligible: 'ASSIGNEE_NOT_ELIGIBLE',
  afterPhotoRequired: 'AFTER_PHOTO_REQUIRED',
  reopenWindowExpired: 'REOPEN_WINDOW_EXPIRED',
  reopenLimitReached: 'REOPEN_LIMIT_REACHED',
  ticketHasUpvotes: 'TICKET_HAS_UPVOTES',
  upvoteNotBuildingIssue: 'UPVOTE_NOT_BUILDING_ISSUE',
  upvoteOwnTicket: 'UPVOTE_OWN_TICKET',
  mergeSelf: 'MERGE_SELF',
  mergeTargetInvalid: 'MERGE_TARGET_INVALID',
  commentNotAllowed: 'COMMENT_NOT_ALLOWED',
  commentDeleteWindowExpired: 'COMMENT_DELETE_WINDOW_EXPIRED',
  estimateNotAllowed: 'ESTIMATE_NOT_ALLOWED',
  chargeStateLocked: 'CHARGE_STATE_LOCKED',
  chargeFinalRequired: 'CHARGE_FINAL_REQUIRED',
  chargeExceedsEstimate: 'CHARGE_EXCEEDS_ESTIMATE',
  chargeInvoiced: 'CHARGE_INVOICED',
  ratingNotAllowed: 'RATING_NOT_ALLOWED',
  ratingWindowExpired: 'RATING_WINDOW_EXPIRED',
  escalationNotAllowed: 'ESCALATION_NOT_ALLOWED',
  escalationTooSoon: 'ESCALATION_TOO_SOON',
  exportTooLarge: 'EXPORT_TOO_LARGE',
  fileNotLinkable: 'FILE_NOT_LINKABLE',
  rateLimited: 'RATE_LIMITED',
  societySuspended: 'SOCIETY_SUSPENDED',
  notImplemented: 'NOT_IMPLEMENTED_IN_FOUNDATION',
  internal: 'INTERNAL_ERROR',
} as const;
