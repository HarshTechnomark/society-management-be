/** Shared constants of module 07 (Platform Operations). Audit actions follow section 9.2, error codes section 12. */
export const PLATFORM_OPS_QUEUE = 'platform-ops';

export const JOBS = {
  ticketSlaScan: 'platform-ops:ticket-sla-scan',
  ticketHousekeeping: 'platform-ops:ticket-housekeeping',
  providerHealthCheck: 'platform-ops:provider-health-check',
  providerUptimeRollup: 'platform-ops:provider-uptime-rollup',
  announcementScheduler: 'platform-ops:announcement-scheduler',
  announcementFanout: 'platform-ops:announcement-fanout',
  failedJobsAlert: 'platform-ops:failed-jobs-alert',
  auditArchive: 'platform-ops:audit-archive',
  metricsTrim: 'platform-ops:metrics-trim',
} as const;

export const AUDIT = {
  ticketCreated: 'platform.ticket.created',
  ticketUpdated: 'platform.ticket.updated',
  ticketClosed: 'platform.ticket.closed',
  ticketReopened: 'platform.ticket.reopened',
  ticketRated: 'platform.ticket.rated',
  ticketAutoResolved: 'platform.ticket.auto_resolved',
  ticketAutoClosed: 'platform.ticket.auto_closed',
  ticketMessageAdded: 'platform.ticket.message_added',
  settingUpdated: 'platform.setting.updated',
  organizationCreated: 'platform.organization.created',
  organizationUpdated: 'platform.organization.updated',
  organizationStatusChanged: 'platform.organization.status_changed',
  providerCreated: 'platform.provider.created',
  providerUpdated: 'platform.provider.updated',
  providerCredentialsUpdated: 'platform.provider.credentials_updated',
  providerCredentialsRekeyed: 'platform.provider.credentials_rekeyed',
  providerDeleted: 'platform.provider.deleted',
  providerStatusSet: 'platform.provider.status_set',
  providerStatusChanged: 'platform.provider.status_changed',
  providerTestSent: 'platform.provider.test_sent',
  incidentCreated: 'platform.incident.created',
  incidentUpdated: 'platform.incident.updated',
  incidentUpdatePosted: 'platform.incident.update_posted',
  incidentResolved: 'platform.incident.resolved',
  announcementCreated: 'platform.announcement.created',
  announcementUpdated: 'platform.announcement.updated',
  announcementScheduled: 'platform.announcement.scheduled',
  announcementPublished: 'platform.announcement.published',
  announcementCancelled: 'platform.announcement.cancelled',
  announcementDeleted: 'platform.announcement.deleted',
  announcementExpired: 'platform.announcement.expired',
  jobRetried: 'platform.job.retried',
  jobDiscarded: 'platform.job.discarded',
  queuePaused: 'platform.queue.paused',
  queueResumed: 'platform.queue.resumed',
  queueBulkRetried: 'platform.queue.bulk_retried',
  auditExported: 'platform.audit_log.exported',
  auditArchived: 'platform.audit_log.archived',
  auditDownloadIssued: 'platform.audit_archive.download_issued',
  societyAuditExported: 'society.audit_log.exported',
} as const;

export const ENTITY = {
  ticket: 'platform_ticket',
  setting: 'platform_setting',
  organization: 'organization',
  provider: 'service_provider',
  incident: 'incident',
  announcement: 'platform_notification',
  job: 'job',
  queue: 'queue',
  auditLog: 'audit_log',
} as const;

/** Status page component catalogue (section 8.6): key, public name and the provider channel mapped to it. */
export const STATUS_COMPONENTS = [
  { key: 'api', name: 'Sign-in and API', channel: null },
  { key: 'admin_app', name: 'Society admin app', channel: null },
  { key: 'resident_app', name: 'Resident app', channel: null },
  { key: 'gate_console', name: 'Guard console', channel: null },
  { key: 'work_app', name: 'Staff app', channel: null },
  { key: 'payments', name: 'Online payments', channel: 'PAYMENT_GATEWAY' },
  { key: 'notifications_sms', name: 'SMS', channel: 'SMS' },
  { key: 'notifications_whatsapp', name: 'WhatsApp', channel: 'WHATSAPP' },
  { key: 'notifications_email', name: 'Email', channel: 'EMAIL' },
  { key: 'notifications_push', name: 'Push notifications', channel: 'PUSH' },
  { key: 'file_storage', name: 'Documents and photos', channel: 'STORAGE' },
  { key: 'visitor_calls', name: 'Visitor calls', channel: 'IVR' },
] as const;
export type StatusComponentKey = (typeof STATUS_COMPONENTS)[number]['key'];
export const COMPONENT_KEYS = STATUS_COMPONENTS.map(c => c.key) as [
  StatusComponentKey,
  ...StatusComponentKey[],
];
export const COMPONENT_FOR_CHANNEL: Record<string, StatusComponentKey | undefined> = Object.fromEntries(
  STATUS_COMPONENTS.filter(c => c.channel).map(c => [c.channel!, c.key]),
);

export const incidentNo = (id: number): string => `INC-${String(id).padStart(6, '0')}`;

/** `TKT-` + id zero-padded to 6 digits (BR-07-2). */
export const ticketNo = (id: number): string => `TKT-${String(id).padStart(6, '0')}`;
export const parseTicketNo = (q: string): number | null => {
  const m = /^TKT-(\d{1,6})$/i.exec(q.trim());
  return m ? Number(m[1]) : null;
};
