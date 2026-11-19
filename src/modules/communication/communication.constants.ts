/**
 * Names, enums, limits and keys of module 16 (sections 2, 5, 6, 7, 9, 10 and 12). The enums are shared with the migrations' CHECKs
 * and with Zod (`z.enum(X)`); keep the lists identical.
 */
export const COMMUNICATION_QUEUE = 'communication';

/** Section 2 permission keys (all exist in module 03; no new keys). */
export const PERM = {
  noticesView: 'communication.notices.view',
  noticesCreate: 'communication.notices.create',
  noticesEdit: 'communication.notices.edit',
  noticesDelete: 'communication.notices.delete',
  noticesApprove: 'communication.notices.approve',
  emergencyCreate: 'communication.emergency.create',
  incidentsView: 'security.incidents.view',
  surveysView: 'communication.surveys.view',
  surveysCreate: 'communication.surveys.create',
  surveysEdit: 'communication.surveys.edit',
  surveysExport: 'communication.surveys.export',
  residentNoticesView: 'resident.notices.view',
  residentNoticesEdit: 'resident.notices.edit',
  gateSosCreate: 'gate.sos.create',
  contactsView: 'residents.contacts.view',
  dashboardToday: 'dashboard.today.view',
  platformSettingsView: 'platform.settings.view',
  platformSettingsEdit: 'platform.settings.edit',
  platformHealthView: 'platform.health.view',
} as const;

/** Section 2 entitlement keys (module 04 catalogue). */
export const ENT = {
  composer: 'communication.notice_composer',
  audienceTargeting: 'communication.audience_targeting',
  scheduling: 'communication.scheduling',
  pinningAndExpiry: 'communication.pinning_and_expiry',
  mandatoryAck: 'communication.mandatory_acknowledgement',
  receiptDashboard: 'communication.read_receipt_dashboard',
  revisionsAndRecall: 'communication.notice_revisions_and_recall',
  makerChecker: 'communication.maker_checker_approval',
  actionButtons: 'communication.notice_action_buttons',
  templateLibrary: 'communication.notice_template_library',
  utilityShutdown: 'communication.utility_shutdown_alerts',
  readAloud: 'communication.read_aloud_notices',
  unreachedFollowUp: 'communication.unreached_residents_follow_up',
  emergencyBroadcast: 'communication.emergency_broadcast',
  safeCheckIn: 'communication.i_m_safe_check_in',
  surveys: 'communication.surveys_with_analytics',
  whatsappMessaging: 'integrations.whatsapp_messaging',
} as const;

/** Limit keys counted by the delivery step (BR-16-24). */
export const LIMIT = { sms: 'limit.sms_per_month', whatsapp: 'limit.whatsapp_per_month' } as const;

/** Section 7.13 settings (module 08 registry). */
export const SETTING = {
  defaultLanguage: 'communication.defaultLanguage',
  quietHoursStart: 'communication.quietHoursStart',
  quietHoursEnd: 'communication.quietHoursEnd',
  maxPinnedNotices: 'communication.maxPinnedNotices',
  ackReminderHours: 'communication.ackReminderHours',
  ackMaxReminders: 'communication.ackMaxReminders',
} as const;

/** Entity types (audit `entityType`, files `linkedEntityType`). */
export const ENTITY = {
  notice: 'notice',
  noticeReceipt: 'notice_receipt',
  template: 'notification_template',
  notification: 'notification',
  inboxItem: 'inbox_item',
  preferences: 'notification_preferences',
  pushSubscription: 'push_subscription',
  emergency: 'emergency_broadcast',
  emergencyResponse: 'emergency_response',
  survey: 'survey',
  surveyResponse: 'survey_response',
} as const;

/** Section 9.1 jobs of queue `communication`. */
export const JOBS = {
  notifyFanout: 'communication:notify-fanout',
  deliver: 'communication:deliver',
  noticeFanout: 'communication:notice-fanout',
  noticeScheduler: 'communication:notice-scheduler',
  noticeExpiry: 'communication:notice-expiry',
  ackReminders: 'communication:ack-reminders',
  ackRemindNotice: 'communication:ack-remind-notice',
  utilityReminders: 'communication:utility-reminders',
  emergencyResolveReminder: 'communication:emergency-resolve-reminder',
  surveyClose: 'communication:survey-close',
  processWebhook: 'communication:process-webhook',
  repairStuck: 'communication:repair-stuck',
  purge: 'communication:purge',
  pushExpiry: 'communication:push-expiry',
  templatesSync: 'communication:templates-sync',
} as const;

/** Redis channels (section 9.4). */
export const BUS = {
  providersChanged: 'platform-ops:providers-changed',
  templatesChanged: 'communication:templates-changed',
} as const;

// ------------------------------------------------------------------ enums (section 7)
export const CHANNELS = ['IN_APP', 'PUSH', 'SMS', 'WHATSAPP', 'EMAIL'] as const;
export type Channel = (typeof CHANNELS)[number];
/** Channels that have a delivery row (6.2: IN_APP has none, the inbox item is the delivery). */
export const EXTERNAL_CHANNELS = ['PUSH', 'SMS', 'WHATSAPP', 'EMAIL'] as const;
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number];
/** Extra channels a notice may add (BR-16-14). */
export const NOTICE_EXTRA_CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'] as const;
export type NoticeExtraChannel = (typeof NOTICE_EXTRA_CHANNELS)[number];

export const NOTICE_KINDS = ['STANDARD', 'UTILITY_SHUTDOWN', 'SYSTEM'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const NOTICE_CATEGORIES = [
  'GENERAL',
  'MAINTENANCE',
  'FINANCE',
  'GOVERNANCE',
  'FESTIVAL',
  'SAFETY',
  'COMMUNITY',
] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];
export const NOTICE_PRIORITIES = ['NORMAL', 'HIGH'] as const;
export type NoticePriority = (typeof NOTICE_PRIORITIES)[number];
export const NOTICE_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'SCHEDULED',
  'PUBLISHED',
  'EXPIRED',
  'RECALLED',
  'ARCHIVED',
] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];
export const AUDIENCE_TYPES = ['ALL', 'BUILDINGS', 'UNITS', 'ROLES'] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];
export const AUDIENCE_RELATIONS = ['ANY', 'OWNERS', 'TENANTS'] as const;
export type AudienceRelation = (typeof AUDIENCE_RELATIONS)[number];
export const UTILITY_TYPES = ['WATER', 'POWER', 'LIFT', 'GAS', 'INTERNET', 'DG_BACKUP', 'OTHER'] as const;
export type UtilityType = (typeof UTILITY_TYPES)[number];
export const ACTION_TYPES = ['PAY_COLLECTION', 'PAY_DUES', 'RSVP', 'VOTE', 'LINK'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const RECEIPT_RELATIONS = ['OWNER', 'CO_OWNER', 'TENANT', 'FAMILY', 'CARETAKER', 'MEMBER'] as const;
export type ReceiptRelation = (typeof RECEIPT_RELATIONS)[number];

export const TEMPLATE_SCOPES = ['USER', 'SOCIETY', 'PLATFORM'] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];
export const TEMPLATE_CATEGORIES = [
  'ACCOUNT',
  'SECURITY',
  'BILLING',
  'PAYMENTS',
  'NOTICES',
  'EMERGENCY',
  'VISITORS',
  'HELPDESK',
  'APPROVALS',
  'COMMUNITY',
  'GOVERNANCE',
  'SYSTEM',
  'PLATFORM',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const DELIVERY_CLASSES = ['OTP', 'SAFETY', 'SECURITY', 'TRANSACTIONAL', 'STANDARD'] as const;
export type DeliveryClass = (typeof DELIVERY_CLASSES)[number];
export const DLT_CATEGORIES = ['SERVICE_IMPLICIT', 'SERVICE_EXPLICIT', 'TRANSACTIONAL'] as const;
export const WHATSAPP_CATEGORIES = ['UTILITY', 'AUTHENTICATION'] as const;
export const WHATSAPP_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED'] as const;
export const VARIABLE_TYPES = ['string', 'number', 'money', 'date', 'datetime', 'url'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const NOTIFICATION_STATUSES = [
  'QUEUED',
  'DEFERRED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const SKIP_REASONS = [
  'PREFERENCE_OFF',
  'NO_CONTACT',
  'NO_SUBSCRIPTION',
  'NO_TEMPLATE',
  'NOT_OPTED_IN',
  'FEATURE_OFF',
  'LIMIT_REACHED',
  'MEMBER_ENDED',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export const TONES = ['info', 'ok', 'warn', 'bad'] as const;
export type Tone = (typeof TONES)[number];

/** BR-16-33: categories a user can switch per channel; EMERGENCY and SECURITY are locked. */
export const PREFERENCE_CATEGORIES = [
  'BILLING',
  'PAYMENTS',
  'NOTICES',
  'VISITORS',
  'HELPDESK',
  'APPROVALS',
  'COMMUNITY',
  'GOVERNANCE',
  'ACCOUNT',
  'SYSTEM',
] as const;
export type PreferenceCategory = (typeof PREFERENCE_CATEGORIES)[number];
export const LOCKED_CATEGORIES = ['EMERGENCY', 'SECURITY'] as const;
export const PREFERENCE_CHANNELS = ['PUSH', 'SMS', 'WHATSAPP', 'EMAIL'] as const;
export const QUIET_HOURS_MODES = ['SOCIETY_DEFAULT', 'CUSTOM', 'OFF'] as const;
export type QuietHoursMode = (typeof QUIET_HOURS_MODES)[number];
export const OPT_IN_SOURCES = ['APP', 'WHATSAPP_REPLY', 'ONBOARDING'] as const;
export const PUSH_APPS = ['PLATFORM', 'ADMIN', 'RESIDENT', 'GATE', 'WORK'] as const;
export type PushApp = (typeof PUSH_APPS)[number];
export const PUSH_REVOKE_REASONS = [
  'USER',
  'LOGOUT',
  'GONE',
  'FAILURES',
  'LIMIT',
  'EXPIRED',
  'USER_DELETED',
] as const;
export type PushRevokeReason = (typeof PUSH_REVOKE_REASONS)[number];

export const EMERGENCY_TYPES = [
  'FIRE',
  'GAS_LEAK',
  'WATER',
  'LIFT_STUCK',
  'SECURITY_THREAT',
  'MEDICAL',
  'POWER',
  'NATURAL_DISASTER',
  'OTHER',
] as const;
export type EmergencyType = (typeof EMERGENCY_TYPES)[number];
export const EMERGENCY_STATUSES = ['ACTIVE', 'RESOLVED', 'CANCELLED'] as const;
export type EmergencyStatus = (typeof EMERGENCY_STATUSES)[number];
export const EMERGENCY_AUDIENCES = ['ALL', 'BUILDINGS'] as const;
export const RESPONSE_STATUSES = ['SAFE', 'NEED_HELP'] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];
export const RESPONSE_CHANNELS = ['APP', 'PUSH_ACTION', 'WHATSAPP', 'GATE', 'ADMIN'] as const;
export type ResponseChannel = (typeof RESPONSE_CHANNELS)[number];

export const SURVEY_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'CANCELLED'] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];
export const RESPONSE_SCOPES = ['PERSON', 'FLAT'] as const;
export type ResponseScope = (typeof RESPONSE_SCOPES)[number];
export const RESULTS_VISIBILITIES = ['ADMINS', 'RESPONDENTS_AFTER_CLOSE', 'ALL_AFTER_CLOSE'] as const;
export type ResultsVisibility = (typeof RESULTS_VISIBILITIES)[number];
export const SURVEY_AUDIENCE_TYPES = ['ALL', 'BUILDINGS', 'UNITS'] as const;
export const QUESTION_TYPES = [
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'YES_NO',
  'RATING',
  'NPS',
  'NUMBER',
  'TEXT',
  'DATE',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Business-rule limits (section 5). */
export const LIMITS = {
  titleMin: 5,
  titleMax: 150,
  bodyTextMin: 10,
  bodyTextMax: 20_000,
  bodyBytesMax: 200_000,
  audienceBuildingsMax: 50,
  audienceUnitsMax: 500,
  audienceRolesMax: 15,
  actionsMax: 2,
  attachmentsMax: 5,
  scheduleMinMinutes: 5,
  scheduleMaxDays: 90,
  expiryMinHours: 1,
  expiryMaxDays: 365,
  ackDueMaxDays: 90,
  editNoteMin: 5,
  editNoteMax: 200,
  recallReasonMin: 10,
  recallReasonMax: 500,
  remindMinHours: 6,
  utilityMaxDays: 7,
  utilityReminderHours: 2,
  schedulerLeadSeconds: 60,
  emergencyMessageMin: 8,
  emergencyMessageMax: 500,
  emergencyUpdateMin: 10,
  emergencyUpdateMax: 500,
  emergencyCancelMin: 10,
  emergencyCancelMax: 300,
  emergencyCancelWindowMinutes: 15,
  emergencyRealertMinutes: 3,
  emergencyResolveReminderMinutes: 30,
  peopleCountMax: 20,
  responseNoteMax: 300,
  surveyQuestionsMax: 30,
  surveyOptionsMin: 2,
  surveyOptionsMax: 20,
  surveyCloseMinHours: 1,
  surveyCloseMaxDays: 90,
  surveyAnonTextMin: 5,
  surveyReminderHours: 24,
  surveyCancelMin: 10,
  surveyCancelMax: 300,
  pushPerUserMax: 10,
  pushFailuresRevoke: 5,
  fanoutPage: 500,
  inlineRecipientsMax: 200,
  explicitRecipientsMax: 10_000,
  smsSegmentGsm: 153,
  smsSegmentUnicode: 67,
  smsMaxSegments: 2,
  smsVariableMax: 30,
  pushBodyMax: 140,
  pushPayloadMax: 3072,
  templateCacheSeconds: 60,
  providerCacheSeconds: 60,
  encClearHours: 24,
  inboxRetentionDays: 365,
  deliveryRetentionDays: 180,
  revokedPushRetentionDays: 90,
  emergencyRetentionDays: 365,
  webhookReplaySeconds: 300,
  defaultQuietStart: '22:00',
  defaultQuietEnd: '07:00',
} as const;

/** BR-16-19 / 6.2: attempts per delivery class and the delay (seconds) after each failure. */
export const RETRY = {
  OTP: { maxAttempts: 2, delaysSec: [5, 15] },
  SAFETY: { maxAttempts: 3, delaysSec: [10, 20, 40] },
  OTHER: { maxAttempts: 5, delaysSec: [30, 120, 600, 1800, 7200] },
} as const;

/** BR-16-23: society `communication.defaultLanguage` to a module 01 locale. */
export const LANGUAGE_TO_LOCALE: Record<string, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  kn: 'kn-IN',
  bn: 'bn-IN',
};
export const LOCALES = Object.values(LANGUAGE_TO_LOCALE);

/** Section 9.2 audit actions. */
export const AUDIT = {
  noticeCreated: 'communication.notice.created',
  noticeUpdated: 'communication.notice.updated',
  noticeDeleted: 'communication.notice.deleted',
  noticeSubmitted: 'communication.notice.submitted',
  noticeWithdrawn: 'communication.notice.withdrawn',
  noticeReturned: 'communication.notice.returned_to_draft',
  noticeScheduled: 'communication.notice.scheduled',
  noticeScheduleCancelled: 'communication.notice.schedule_cancelled',
  noticePublished: 'communication.notice.published',
  noticeExpired: 'communication.notice.expired',
  noticeRecalled: 'communication.notice.recalled',
  noticePinned: 'communication.notice.pinned',
  noticeUnpinned: 'communication.notice.unpinned',
  noticeArchived: 'communication.notice.archived',
  noticeReminded: 'communication.notice.reminded',
  noticeRestored: 'communication.notice.restored',
  noticeAcknowledged: 'communication.notice.acknowledged',
  receiptsExported: 'communication.notice_receipts.exported',
  emergencyStarted: 'communication.emergency.started',
  emergencyUpdated: 'communication.emergency.updated',
  emergencyRealerted: 'communication.emergency.realerted',
  emergencyResolved: 'communication.emergency.resolved',
  emergencyCancelled: 'communication.emergency.cancelled',
  responseRecorded: 'communication.emergency_response.recorded',
  responseAttended: 'communication.emergency_response.attended',
  surveyCreated: 'communication.survey.created',
  surveyUpdated: 'communication.survey.updated',
  surveyDeleted: 'communication.survey.deleted',
  surveyPublished: 'communication.survey.published',
  surveyClosed: 'communication.survey.closed',
  surveyCancelled: 'communication.survey.cancelled',
  surveyExported: 'communication.survey.exported',
  surveyResponseSubmitted: 'communication.survey_response.submitted',
  preferencesUpdated: 'communication.preferences.updated',
  pushCreated: 'communication.push_subscription.created',
  pushRevoked: 'communication.push_subscription.revoked',
  templateUpdated: 'communication.template.updated',
  deliveriesSearched: 'communication.deliveries.searched',
  whatsappOptedOut: 'communication.whatsapp.opted_out',
} as const;

/** Section 9.3 realtime events and rooms. */
export const RT = {
  notificationCreated: 'notification.created',
  notificationRead: 'notification.read',
  emergencyAlert: 'emergency.alert',
  emergencyEnded: 'emergency.ended',
  noticeUpdated: 'notice.updated',
  emergencyStarted: 'emergency.started',
  emergencyUpdated: 'emergency.updated',
  emergencyResponse: 'emergency.response',
  surveyResponseCount: 'survey.response_count',
} as const;
export const roomAdmin = (societyId: number): string => `society:${societyId}:admin`;
export const roomGate = (societyId: number): string => `society:${societyId}:gate`;
export const roomUser = (userId: number): string => `user:${userId}`;

/** Section 10.1 template keys owned by module 16. */
export const NOTIFY = {
  noticePublished: 'communication.notice_published',
  noticeAckRequired: 'communication.notice_ack_required',
  noticeAckReminder: 'communication.notice_ack_reminder',
  noticeRecalled: 'communication.notice_recalled',
  utilityStarting: 'communication.utility_starting',
  utilityRestored: 'communication.utility_restored',
  emergencyAlert: 'communication.emergency_alert',
  emergencyUpdate: 'communication.emergency_update',
  emergencyRealert: 'communication.emergency_realert',
  emergencyAllClear: 'communication.emergency_all_clear',
  emergencyCancelled: 'communication.emergency_cancelled',
  emergencyHelpRequested: 'communication.emergency_help_requested',
  emergencyHelpOnWay: 'communication.emergency_help_on_way',
  emergencyResolveReminder: 'communication.emergency_resolve_reminder',
  surveyPublished: 'communication.survey_published',
  surveyReminder: 'communication.survey_reminder',
  surveyClosed: 'communication.survey_closed',
  pushTest: 'communication.push_test',
  residentExportReady: 'resident.data_export_ready',
  residentExportFailed: 'resident.data_export_failed',
  reportsExportReady: 'reports.export_ready',
  reportsExportFailed: 'reports.export_failed',
  reportsScheduledDelivery: 'reports.scheduled_delivery',
  reportsScheduleFailed: 'reports.schedule_failed',
  reportsSchedulePaused: 'reports.schedule_paused',
  reportsReconciliationFailed: 'reports.reconciliation_failed',
} as const;

/** Section 12 error codes (internal programmer errors last). */
export const ERR = {
  validation: 'VALIDATION_FAILED',
  reauthRequired: 'REAUTH_REQUIRED',
  webhookSignatureInvalid: 'WEBHOOK_SIGNATURE_INVALID',
  featureNotInPlan: 'FEATURE_NOT_IN_PLAN',
  permissionDenied: 'PERMISSION_DENIED',
  platformAccessRequired: 'PLATFORM_ACCESS_REQUIRED',
  notFound: 'NOT_FOUND',
  noticeNotFound: 'NOTICE_NOT_FOUND',
  notificationNotFound: 'NOTIFICATION_NOT_FOUND',
  pushSubscriptionNotFound: 'PUSH_SUBSCRIPTION_NOT_FOUND',
  emergencyNotFound: 'EMERGENCY_NOT_FOUND',
  surveyNotFound: 'SURVEY_NOT_FOUND',
  templateNotFound: 'TEMPLATE_NOT_FOUND',
  fileNotFound: 'FILE_NOT_FOUND',
  staleVersion: 'STALE_VERSION',
  invalidState: 'INVALID_STATE',
  approvalAlreadyPending: 'APPROVAL_ALREADY_PENDING',
  makerCheckerViolation: 'MAKER_CHECKER_VIOLATION',
  noticeAttachmentsPending: 'NOTICE_ATTACHMENTS_PENDING',
  noticePinLimitReached: 'NOTICE_PIN_LIMIT_REACHED',
  emergencyAlreadyActive: 'EMERGENCY_ALREADY_ACTIVE',
  emergencyNotActive: 'EMERGENCY_NOT_ACTIVE',
  surveyNotOpen: 'SURVEY_NOT_OPEN',
  surveyAlreadyResponded: 'SURVEY_ALREADY_RESPONDED',
  fileNotReady: 'FILE_NOT_READY',
  noticeIncomplete: 'NOTICE_INCOMPLETE',
  noticeAudienceInvalid: 'NOTICE_AUDIENCE_INVALID',
  noticeAudienceEmpty: 'NOTICE_AUDIENCE_EMPTY',
  noticeScheduleInvalid: 'NOTICE_SCHEDULE_INVALID',
  noticeExpiryInvalid: 'NOTICE_EXPIRY_INVALID',
  noticeActionInvalid: 'NOTICE_ACTION_INVALID',
  noticeUtilityInvalid: 'NOTICE_UTILITY_INVALID',
  noticeAckNotRequired: 'NOTICE_ACK_NOT_REQUIRED',
  noticeRemindTooSoon: 'NOTICE_REMIND_TOO_SOON',
  noticeRemindLimit: 'NOTICE_REMIND_LIMIT',
  emergencyAudienceInvalid: 'EMERGENCY_AUDIENCE_INVALID',
  emergencyResponsesDisabled: 'EMERGENCY_RESPONSES_DISABLED',
  emergencyUnitRequired: 'EMERGENCY_UNIT_REQUIRED',
  emergencyRealertNotAllowed: 'EMERGENCY_REALERT_NOT_ALLOWED',
  emergencyRealertTooSoon: 'EMERGENCY_REALERT_TOO_SOON',
  emergencyCancelWindowPassed: 'EMERGENCY_CANCEL_WINDOW_PASSED',
  surveyQuestionsRequired: 'SURVEY_QUESTIONS_REQUIRED',
  surveyCloseInvalid: 'SURVEY_CLOSE_INVALID',
  surveyAudienceEmpty: 'SURVEY_AUDIENCE_EMPTY',
  surveyAnswerInvalid: 'SURVEY_ANSWER_INVALID',
  surveyUnitRequired: 'SURVEY_UNIT_REQUIRED',
  preferenceLocked: 'PREFERENCE_LOCKED',
  quietHoursInvalid: 'QUIET_HOURS_INVALID',
  pushEndpointNotAllowed: 'PUSH_ENDPOINT_NOT_ALLOWED',
  templateInvalid: 'TEMPLATE_INVALID',
  templateDltRequired: 'TEMPLATE_DLT_REQUIRED',
  fileNotLinkable: 'FILE_NOT_LINKABLE',
  fileInfected: 'FILE_INFECTED',
  societySuspended: 'SOCIETY_SUSPENDED',
  societyClosed: 'SOCIETY_CLOSED',
  rateLimited: 'RATE_LIMITED',
  pushNotConfigured: 'PUSH_NOT_CONFIGURED',
  internal: 'INTERNAL_ERROR',
  notImplemented: 'NOT_IMPLEMENTED_IN_FOUNDATION',
  // internal programmer errors (thrown to calling code)
  templateVariableMissing: 'TEMPLATE_VARIABLE_MISSING',
  templateVariableInvalid: 'TEMPLATE_VARIABLE_INVALID',
  notifySocietyRequired: 'NOTIFY_SOCIETY_REQUIRED',
  notifyChannelNotAllowed: 'NOTIFY_CHANNEL_NOT_ALLOWED',
  notifyRecipientsInvalid: 'NOTIFY_RECIPIENTS_INVALID',
  notifyInTransaction: 'NOTIFY_IN_TRANSACTION',
} as const;
