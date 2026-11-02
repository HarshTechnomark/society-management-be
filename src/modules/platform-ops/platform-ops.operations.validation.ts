import { z } from 'zod';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from '../../models/incident.model';
import {
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_SEVERITIES,
  ANNOUNCEMENT_STATUSES,
  AUDIENCE_TYPES,
} from '../../models/platform-notification.model';
import { PROVIDER_CHANNELS, PROVIDER_HEALTH, PROVIDER_VENDORS } from '../../models/service-provider.model';
import { COMPONENT_KEYS } from './platform-ops.types';
import { ROLE_KEYS } from './platform-ops.announcements.audience';
import { SOURCES } from './platform-ops.audit.service';

/** Zod schemas of module 07 part 2 (sections 8.2 and 8.5 to 8.9). Bodies are `.strict()`. */
const id = z.coerce.number().int().positive();
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const sortOrder = z.enum(['asc', 'desc']).default('desc');
const bool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform(v => v === true || v === 'true');
const many = <T extends z.ZodType>(s: T) =>
  z.preprocess(
    v => (v === undefined || v === '' ? undefined : Array.isArray(v) ? v : String(v).split(',')),
    z.array(s).min(1).optional(),
  );
const text = (min: number, max: number, what = 'Text') =>
  z
    .string()
    .trim()
    .min(min, `${what} must be at least ${min} characters`)
    .max(max, `${what} must be at most ${max} characters`);
const version = z.number().int().min(1);
const reason = text(5, 500, 'Reason');
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(s => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a real date');
const isoDate = z
  .string()
  .datetime({ message: 'Use an ISO UTC time such as 2026-11-01T04:30:00.000Z' })
  .transform(s => new Date(s));
const uniqueArray = <T extends z.ZodType>(s: T, min: number, max: number) =>
  z
    .array(s)
    .min(min)
    .max(max)
    .refine(a => new Set(a as unknown[]).size === a.length, 'Duplicate entries');

// ------------------------------------------------------------------ announcements
const audienceFields = {
  audienceType: z.enum(AUDIENCE_TYPES),
  audiencePlanKeys: uniqueArray(z.string().trim().min(2).max(40), 1, 10).optional(),
  audienceSocietyStatuses: uniqueArray(z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED']), 1, 4).optional(),
  audienceSocietyIds: uniqueArray(z.number().int().positive(), 1, 500).optional(),
  audienceRoleKeys: uniqueArray(z.enum(ROLE_KEYS), 1, 9),
};
type AudienceShape = {
  audienceType?: string;
  audiencePlanKeys?: unknown;
  audienceSocietyStatuses?: unknown;
  audienceSocietyIds?: unknown;
};
/** The list matching the type is required and the other two must be absent (section 8.7). */
function audienceRule(v: AudienceShape, ctx: z.RefinementCtx): void {
  if (!v.audienceType) {
    for (const f of ['audiencePlanKeys', 'audienceSocietyStatuses', 'audienceSocietyIds'] as const)
      if (v[f] !== undefined)
        ctx.addIssue({ code: 'custom', path: [f], message: 'Send audienceType with the audience lists' });
    return;
  }
  const need: Record<string, keyof AudienceShape> = {
    PLANS: 'audiencePlanKeys',
    SOCIETY_STATUSES: 'audienceSocietyStatuses',
    SOCIETIES: 'audienceSocietyIds',
  };
  for (const f of ['audiencePlanKeys', 'audienceSocietyStatuses', 'audienceSocietyIds'] as const) {
    const wanted = need[v.audienceType] === f;
    if (wanted && v[f] === undefined)
      ctx.addIssue({ code: 'custom', path: [f], message: 'Required for this audience' });
    if (!wanted && v[f] !== undefined)
      ctx.addIssue({ code: 'custom', path: [f], message: 'Not allowed for this audience' });
  }
}
const ctaRule = (v: { ctaLabel?: string | null; ctaUrl?: string | null }, ctx: z.RefinementCtx) => {
  if ((v.ctaLabel === undefined || v.ctaLabel === null) !== (v.ctaUrl === undefined || v.ctaUrl === null))
    ctx.addIssue({ code: 'custom', path: ['ctaUrl'], message: 'Send ctaLabel and ctaUrl together' });
};
const announcementBase = {
  title: text(5, 120, 'Title'),
  body: text(10, 2000, 'Body'),
  kind: z.enum(ANNOUNCEMENT_KINDS),
  severity: z.enum(ANNOUNCEMENT_SEVERITIES),
  channels: uniqueArray(z.enum(['EMAIL', 'PUSH', 'WHATSAPP']), 0, 3),
  publishAt: isoDate.nullable(),
  expiresAt: isoDate,
  isDismissible: z.boolean(),
  ctaLabel: text(2, 30, 'Label').nullable(),
  ctaUrl: z.string().trim().max(500).nullable(),
};

// ------------------------------------------------------------------ audit
const auditFilters = {
  actorUserId: id.optional(),
  actorRole: z.string().min(1).max(40).optional(),
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]+){0,2}\.?\*?$/, 'Not a valid action filter')
    .optional(),
  entityType: z.string().min(1).max(40).optional(),
  entityId: z.string().min(1).max(60).optional(),
  q: text(2, 100, 'Search').optional(),
  from: ymd.optional(),
  to: ymd.optional(),
};
const rangeRule = (v: { from?: string; to?: string }, ctx: z.RefinementCtx) => {
  if (v.from && v.to && v.from > v.to)
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must not be before from' });
};

const queueName = z.string().regex(/^[a-z][a-z0-9-]{0,49}$/, 'Not a queue name');
const jobId = z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/, 'Not a job id');
const jobName = z.string().regex(/^[a-z-]+:[a-z0-9-]+$/, 'Not a job name');

export const opsSchemas2 = {
  idParam: z.object({ id }),

  // ---- 8.2 dashboard
  dashboardQuery: z.object({ period: z.enum(['7', '30', '90']).default('30') }),

  // ---- 8.5 providers
  providerList: z.object({
    channel: z.enum(PROVIDER_CHANNELS).optional(),
    isEnabled: bool.optional(),
    healthStatus: z.enum(PROVIDER_HEALTH).optional(),
  }),
  providerCreate: z
    .object({
      providerKey: z
        .string()
        .regex(/^[a-z][a-z0-9_]{2,39}$/, 'Use lowercase letters, digits and underscores'),
      channel: z.enum(PROVIDER_CHANNELS),
      vendor: z.enum(PROVIDER_VENDORS),
      displayName: text(3, 80, 'Name'),
      description: text(0, 200, 'Description').optional(),
      priority: z.number().int().min(1).max(9),
      config: z.record(z.string(), z.unknown()),
      credentials: z.record(z.string(), z.unknown()).optional(),
      degradedLatencyMs: z.number().int().min(500).max(30000).optional(),
    })
    .strict(),
  providerPatch: z
    .object({
      version,
      displayName: text(3, 80, 'Name').optional(),
      description: text(0, 200, 'Description').nullable().optional(),
      priority: z.number().int().min(1).max(9).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      isEnabled: z.boolean().optional(),
      degradedLatencyMs: z.number().int().min(500).max(30000).optional(),
    })
    .strict(),
  providerCredentials: z.object({ version, credentials: z.record(z.string(), z.unknown()) }).strict(),
  providerDelete: z.object({ version, reason }).strict(),
  providerTestSend: z
    .object({ to: z.string().trim().max(254).optional(), pushSubscriptionOfMe: z.boolean().optional() })
    .strict(),
  providerStatus: z
    .object({
      version,
      mode: z.enum(['MANUAL', 'AUTOMATIC']),
      status: z.enum(['OPERATIONAL', 'DEGRADED', 'OUTAGE']).optional(),
      reason: text(5, 300, 'Reason').optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.mode === 'MANUAL') {
        if (!v.status)
          ctx.addIssue({ code: 'custom', path: ['status'], message: 'Required for manual mode' });
        if (!v.reason)
          ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Required for manual mode' });
      }
    }),

  // ---- 8.6 incidents
  incidentList: z.object({
    status: many(z.enum(INCIDENT_STATUSES)),
    severity: many(z.enum(INCIDENT_SEVERITIES)),
    serviceProviderId: id.optional(),
    from: ymd.optional(),
    to: ymd.optional(),
    sortBy: z.enum(['startedAt', 'severity']).default('startedAt'),
    sortOrder,
    ...page,
  }),
  incidentCreate: z
    .object({
      title: text(5, 150, 'Title'),
      severity: z.enum(INCIDENT_SEVERITIES),
      components: uniqueArray(z.enum(COMPONENT_KEYS), 1, 12),
      serviceProviderId: z.number().int().positive().optional(),
      isPublic: z.boolean().optional(),
      startedAt: isoDate.optional(),
      message: text(10, 1000, 'Message'),
      notifySocieties: z.boolean().optional(),
    })
    .strict(),
  incidentPatch: z
    .object({
      version,
      title: text(5, 150, 'Title').optional(),
      severity: z.enum(INCIDENT_SEVERITIES).optional(),
      components: uniqueArray(z.enum(COMPONENT_KEYS), 1, 12).optional(),
      isPublic: z.boolean().optional(),
      notifySocieties: z.boolean().optional(),
    })
    .strict(),
  incidentUpdate: z
    .object({
      version,
      status: z.enum(['INVESTIGATING', 'IDENTIFIED', 'MONITORING']).optional(),
      message: text(10, 1000, 'Message'),
      isPublic: z.boolean().optional(),
    })
    .strict(),
  incidentResolve: z
    .object({
      version,
      message: text(10, 1000, 'Message'),
      rootCause: text(0, 2000, 'Root cause').optional(),
    })
    .strict(),

  // ---- 8.7 announcements
  announcementList: z.object({
    status: many(z.enum(ANNOUNCEMENT_STATUSES)),
    kind: z.enum(ANNOUNCEMENT_KINDS).optional(),
    severity: z.enum(ANNOUNCEMENT_SEVERITIES).optional(),
    sortBy: z.enum(['createdAt', 'publishAt']).default('createdAt'),
    sortOrder,
    ...page,
  }),
  announcementCreate: z
    .object({
      ...announcementBase,
      ...audienceFields,
      channels: announcementBase.channels.default([]),
      publishAt: announcementBase.publishAt.default(null),
      isDismissible: z.boolean().default(true),
      ctaLabel: announcementBase.ctaLabel.default(null),
      ctaUrl: announcementBase.ctaUrl.default(null),
    })
    .strict()
    .superRefine(audienceRule)
    .superRefine(ctaRule),
  announcementPatch: z
    .object({
      version,
      title: announcementBase.title.optional(),
      body: announcementBase.body.optional(),
      kind: announcementBase.kind.optional(),
      severity: announcementBase.severity.optional(),
      channels: announcementBase.channels.optional(),
      publishAt: announcementBase.publishAt.optional(),
      expiresAt: announcementBase.expiresAt.optional(),
      isDismissible: announcementBase.isDismissible.optional(),
      ctaLabel: announcementBase.ctaLabel.optional(),
      ctaUrl: announcementBase.ctaUrl.optional(),
      audienceType: audienceFields.audienceType.optional(),
      audiencePlanKeys: audienceFields.audiencePlanKeys,
      audienceSocietyStatuses: audienceFields.audienceSocietyStatuses,
      audienceSocietyIds: audienceFields.audienceSocietyIds,
      audienceRoleKeys: audienceFields.audienceRoleKeys.optional(),
    })
    .strict()
    .superRefine(audienceRule)
    .superRefine(ctaRule),
  audiencePreview: z.object(audienceFields).strict().superRefine(audienceRule),
  announcementVersion: z.object({ version }).strict(),
  announcementCancel: z.object({ version, reason }).strict(),

  // ---- 8.8 queues
  queueParam: z.object({ name: queueName }),
  jobParam: z.object({ name: queueName, jobId }),
  queueJobsQuery: z.object({
    state: z.enum(['failed', 'delayed', 'waiting', 'active']).default('failed'),
    jobName: jobName.optional(),
    societyId: id.optional(),
    ...page,
  }),
  failedJobsQuery: z.object({
    queue: queueName.optional(),
    jobName: jobName.optional(),
    societyId: id.optional(),
    ...page,
  }),
  reasonBody: z.object({ reason }).strict(),
  bulkRetry: z
    .object({
      queue: queueName.optional(),
      includePermanent: z.boolean().optional(),
      max: z.number().int().min(1).max(500).optional(),
    })
    .strict(),

  // ---- 8.9 audit
  platformAuditQuery: z
    .object({
      societyId: z
        .string()
        .regex(/^([1-9]\d{0,18}|platform)$/, 'Use a society id or platform')
        .optional(),
      source: z.enum(SOURCES).optional(),
      ...auditFilters,
      cursor: z.string().min(1).max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .superRefine(rangeRule),
  platformAuditExport: z
    .object({
      societyId: z
        .string()
        .regex(/^([1-9]\d{0,18}|platform)$/, 'Use a society id or platform')
        .optional(),
      source: z.enum(SOURCES).optional(),
      ...auditFilters,
    })
    .superRefine(rangeRule),
  societyAuditQuery: z
    .object({
      source: z.enum(SOURCES).exclude(['PLATFORM_CONSOLE']).optional(),
      ...auditFilters,
      cursor: z.string().min(1).max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .superRefine(rangeRule),
  societyAuditExport: z
    .object({ source: z.enum(SOURCES).exclude(['PLATFORM_CONSOLE']).optional(), ...auditFilters })
    .superRefine(rangeRule),
  archiveDownload: z
    .object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
      part: z.number().int().min(1).max(99).default(1),
    })
    .strict(),
};
