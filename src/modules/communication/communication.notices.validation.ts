import { z } from 'zod';
import {
  ACTION_TYPES,
  AUDIENCE_RELATIONS,
  AUDIENCE_TYPES,
  LIMITS,
  LOCALES,
  NOTICE_CATEGORIES,
  NOTICE_EXTRA_CHANNELS,
  NOTICE_PRIORITIES,
  NOTICE_STATUSES,
  NOTICE_KINDS,
  UTILITY_TYPES,
} from './communication.constants';

/** Zod schemas of part 16.1 (sections 8.1 to 8.17). Bodies and queries are `.strict()`. */
const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, 'Not a valid id')
  .transform(Number);
const idNum = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform(v => new Date(v));
const title = z
  .string()
  .trim()
  .min(LIMITS.titleMin)
  .max(LIMITS.titleMax)
  .regex(NO_CONTROL, 'No control characters');
const body = z
  .string()
  .refine(v => Buffer.byteLength(v, 'utf8') <= LIMITS.bodyBytesMax, 'The body is too large (200,000 bytes)');
const fileIds = z
  .array(z.number().int().positive())
  .max(LIMITS.attachmentsMax)
  .refine(a => new Set(a).size === a.length, 'Duplicate file ids');
const reason = (min: number, max: number) => z.string().trim().min(min).max(max).regex(NO_CONTROL);

const action = z
  .object({
    type: z.enum(ACTION_TYPES),
    refId: z.number().int().positive().optional(),
    url: z.string().max(300).optional(),
    label: z.string().trim().min(2).max(30).optional(),
  })
  .strict()
  .superRefine((a, c) => {
    if ((a.type === 'PAY_COLLECTION' || a.type === 'RSVP' || a.type === 'VOTE') && !a.refId)
      c.addIssue({ code: 'custom', path: ['refId'], message: 'refId is required' });
    if (a.type === 'PAY_DUES' && (a.refId || a.url || a.label))
      c.addIssue({ code: 'custom', path: ['refId'], message: 'PAY_DUES takes no fields' });
    if (a.type === 'LINK') {
      if (!a.url || !/^https:\/\/[^\s]+$/.test(a.url))
        c.addIssue({ code: 'custom', path: ['url'], message: 'url must start with https://' });
      if (!a.label) c.addIssue({ code: 'custom', path: ['label'], message: 'label is required' });
    }
  });
const actions = z.array(action).max(LIMITS.actionsMax);

export const audience = z
  .object({
    type: z.enum(AUDIENCE_TYPES),
    relation: z.enum(AUDIENCE_RELATIONS).optional(),
    ids: z
      .array(z.number().int().positive())
      .max(LIMITS.audienceUnitsMax)
      .refine(a => new Set(a).size === a.length, 'Duplicate ids')
      .optional(),
    roleKeys: z
      .array(z.string().trim().min(1).max(60))
      .max(LIMITS.audienceRolesMax)
      .refine(a => new Set(a).size === a.length, 'Duplicate role keys')
      .optional(),
  })
  .strict()
  .superRefine((a, c) => {
    if ((a.type === 'BUILDINGS' || a.type === 'UNITS') && !a.ids?.length)
      c.addIssue({ code: 'custom', path: ['ids'], message: 'ids are required' });
    if (a.type === 'BUILDINGS' && (a.ids?.length ?? 0) > LIMITS.audienceBuildingsMax)
      c.addIssue({ code: 'custom', path: ['ids'], message: 'At most 50 buildings' });
    if (a.type === 'ROLES' && !a.roleKeys?.length)
      c.addIssue({ code: 'custom', path: ['roleKeys'], message: 'roleKeys are required' });
    if (a.type !== 'ROLES' && a.roleKeys?.length)
      c.addIssue({ code: 'custom', path: ['roleKeys'], message: 'roleKeys only for ROLES' });
    if ((a.type === 'ALL' || a.type === 'ROLES') && a.ids?.length)
      c.addIssue({ code: 'custom', path: ['ids'], message: 'ids only for BUILDINGS and UNITS' });
    if (a.type === 'ROLES' && a.relation && a.relation !== 'ANY')
      c.addIssue({ code: 'custom', path: ['relation'], message: 'relation must be ANY for ROLES' });
  });

const channels = z
  .array(z.enum(NOTICE_EXTRA_CHANNELS))
  .max(3)
  .refine(a => new Set(a).size === a.length, 'Duplicate channels');

const fields = {
  title,
  body,
  category: z.enum(NOTICE_CATEGORIES),
  priority: z.enum(NOTICE_PRIORITIES),
  locale: z.enum(LOCALES as [string, ...string[]]),
  audience,
  channels,
  actions,
  requiresAck: z.boolean(),
  ackDueAt: isoDate.nullable(),
  isPinned: z.boolean(),
  expiresAt: isoDate.nullable(),
  utilityType: z.enum(UTILITY_TYPES),
  outageStartsAt: isoDate,
  outageEndsAt: isoDate,
  fileIds,
};

const createBody = z
  .object({ kind: z.enum(['STANDARD', 'UTILITY_SHUTDOWN']).optional() })
  .extend(z.object(fields).partial().shape)
  .extend({ title })
  .strict()
  .superRefine((v, c) => {
    if (v.ackDueAt && !v.requiresAck)
      c.addIssue({ code: 'custom', path: ['ackDueAt'], message: 'ackDueAt needs requiresAck' });
    const u = v.kind === 'UTILITY_SHUTDOWN';
    if (u && (!v.utilityType || !v.outageStartsAt || !v.outageEndsAt))
      c.addIssue({
        code: 'custom',
        path: ['utilityType'],
        message: 'utilityType and the outage window are required',
      });
    if (!u && (v.utilityType || v.outageStartsAt || v.outageEndsAt))
      c.addIssue({ code: 'custom', path: ['utilityType'], message: 'Only for UTILITY_SHUTDOWN notices' });
  });

const patchBody = z
  .object({ version, editNote: reason(LIMITS.editNoteMin, LIMITS.editNoteMax).optional() })
  .extend(z.object(fields).partial().shape)
  .strict();

const withVersion = z.object({ version }).strict();
const versionReason = z.object({ version, reason: reason(5, 300).optional() }).strict();

const idParam = z.object({ id }).strict();

const list = z
  .object({
    status: z.enum([...NOTICE_STATUSES, 'ACTIVE'] as [string, ...string[]]).optional(),
    category: z.enum(NOTICE_CATEGORIES).optional(),
    kind: z.enum(NOTICE_KINDS).optional(),
    pinned: bool.optional(),
    q: z.string().trim().min(2).max(60).optional(),
    createdBy: idNum.optional(),
    from: ymd.optional(),
    to: ymd.optional(),
    sortBy: z.enum(['publishedAt', 'createdAt', 'title', 'readPct', 'ackPct']).default('publishedAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine((v, c) => {
    if (!v.from || !v.to) return;
    const a = Date.parse(`${v.from}T00:00:00Z`);
    const b = Date.parse(`${v.to}T00:00:00Z`);
    if (a > b) c.addIssue({ code: 'custom', path: ['from'], message: 'from must not be after to' });
    else if ((b - a) / 86_400_000 > 366)
      c.addIssue({ code: 'custom', path: ['to'], message: 'The range may be at most 366 days' });
  });

const receiptFilters = {
  filter: z.enum(['ALL', 'NOT_READ', 'NOT_ACKED', 'ACKED', 'UNREACHED']).default('ALL'),
  buildingId: idNum.optional(),
  q: z.string().trim().min(2).max(40).optional(),
  sortBy: z.enum(['unitLabel', 'firstReadAt', 'acknowledgedAt']).default('unitLabel'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
};

export const noticeSchemas = {
  idParam,
  list,
  create: createBody,
  patch: patchBody,
  del: z.object({ version: z.coerce.number().int().min(1) }).strict(),
  publish: z.object({ version, scheduledAt: isoDate.optional() }).strict(),
  withReason: versionReason,
  recall: z
    .object({
      version,
      reason: reason(LIMITS.recallReasonMin, LIMITS.recallReasonMax),
      notifyRecall: z.boolean().default(true),
    })
    .strict(),
  withVersion,
  restored: z.object({ version, message: reason(5, 300).optional() }).strict(),
  templates: z.object({ locale: z.enum(['en-IN', 'hi-IN', 'mr-IN']).optional() }).strict(),
  preview: z.object({ audience }).strict(),
  receipts: z
    .object({
      ...receiptFilters,
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
  receiptsExport: z.object(receiptFilters).strict(),
  fileParams: z.object({ id, fileId: id }).strict(),
  fileQuery: z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment') }).strict(),
  ack: z.object({ appVersion: z.string().max(20).optional() }).strict(),
};
