import type { SocietyStatus } from '../../models/society.model';

export type { SocietyStatus };
export type SupportScope = 'READ_ONLY' | 'READ_WRITE';

/** States and union territories of India (module 01 list), as stored in `societies.state`. */
export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
] as const;

export const SOCIETY_LOCALES = [
  'en-IN',
  'hi-IN',
  'mr-IN',
  'gu-IN',
  'ta-IN',
  'te-IN',
  'kn-IN',
  'bn-IN',
] as const;
export const PLAN_KEYS = ['STARTER', 'STANDARD', 'PREMIUM', 'ENTERPRISE'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export const SELF_SERVE_PLAN_KEYS = ['STARTER', 'STANDARD', 'PREMIUM'] as const;
export const HEALTH_BANDS = ['HEALTHY', 'WATCH', 'AT_RISK'] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];
export const SUSPEND_REASON_CATEGORIES = [
  'NON_PAYMENT',
  'POLICY_VIOLATION',
  'FRAUD_SUSPECTED',
  'CUSTOMER_REQUEST',
  'LEGAL_DISPUTE',
  'OTHER',
] as const;
export const LIFECYCLE_ACTIONS = [
  'CONVERT',
  'EXTEND_TRIAL',
  'SUSPEND',
  'REACTIVATE',
  'CLOSE',
  'REOPEN',
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** BR-05-14 job tags. */
export const JOB_TAGS = ['safety', 'payments', 'export', 'support', 'lifecycle', 'health', 'normal'] as const;
export type JobTag = (typeof JOB_TAGS)[number];

/** Route policy read by the society state guard (6.2.1). */
export interface StatePolicy {
  suspended?: 'block-writes' | 'allow';
  closed?: 'block' | 'allow';
  /** 6.4: routes that expose secrets or raw personal documents refuse support grant holders. */
  noSupportAccess?: boolean;
}

/** Module 07 `platform_settings` keys used here, with the code defaults that apply until module 07 exists. */
export const SETTING_DEFAULTS = {
  'lifecycle.trialDays': 14,
  'lifecycle.trialMaxExtensions': 2,
  'lifecycle.autoCloseSuspendedDays': 60,
  'lifecycle.retentionDaysAfterClose': 90,
  'exports.fullExportDownloadDays': 7,
  'exports.closureExportDownloadDays': 30,
  'exports.maxPerSocietyPer24h': 2,
  'supportAccess.consentTimeoutMinutes': 1440,
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;

export const AUDIT = {
  created: 'societies.society.created',
  signedUp: 'societies.society.signed_up',
  updated: 'societies.society.updated',
  listExported: 'societies.society.list_exported',
  trialExtended: 'societies.society.trial_extended',
  converted: 'societies.society.converted',
  pastDue: 'societies.society.past_due',
  suspended: 'societies.society.suspended',
  reactivated: 'societies.society.reactivated',
  closed: 'societies.society.closed',
  reopened: 'societies.society.reopened',
  purgeHoldSet: 'societies.society.purge_hold_set',
  purgeHoldCleared: 'societies.society.purge_hold_cleared',
  purged: 'societies.society.purged',
  financialDeleted: 'societies.society.financial_records_deleted',
  nudged: 'societies.society.nudged',
  consentChanged: 'societies.society.support_consent_changed',
  grantRequested: 'societies.support_grant.requested',
  grantStarted: 'societies.support_grant.started',
  grantApproved: 'societies.support_grant.approved',
  grantDenied: 'societies.support_grant.denied',
  grantCancelled: 'societies.support_grant.cancelled',
  grantEntered: 'societies.support_grant.entered',
  grantEnded: 'societies.support_grant.ended',
  grantRevoked: 'societies.support_grant.revoked',
  grantExpired: 'societies.support_grant.expired',
  grantConsentExpired: 'societies.support_grant.consent_expired',
  grantViewed: 'societies.support_grant.viewed',
  exportRequested: 'societies.data_export.requested',
  exportReady: 'societies.data_export.ready',
  exportFailed: 'societies.data_export.failed',
  exportDownloaded: 'societies.data_export.downloaded',
  exportExpired: 'societies.data_export.expired',
  noteCreated: 'societies.note.created',
  noteUpdated: 'societies.note.updated',
  noteDeleted: 'societies.note.deleted',
} as const;

export const QUEUE = 'societies';
export const JOBS = {
  expireTrials: 'societies:expire-trials',
  trialReminders: 'societies:trial-reminders',
  autoClose: 'societies:auto-close',
  purgeClosed: 'societies:purge-closed',
  buildExport: 'societies:build-export',
  expireExports: 'societies:expire-exports',
  endSupportGrant: 'societies:end-support-grant',
  expireSupportGrants: 'societies:expire-support-grants',
  expireSupportConsents: 'societies:expire-support-consents',
  expireFinancialRetention: 'societies:expire-financial-retention',
  computeHealth: 'societies:compute-health',
} as const;
