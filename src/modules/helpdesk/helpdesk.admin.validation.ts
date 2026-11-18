import { z } from 'zod';
import {
  ACTIONS,
  ASSIGNEE_TYPES,
  AFFECTED_LEVELS,
  LIMITS,
  PRIORITIES,
  TICKET_KINDS,
  TICKET_STATUSES,
  URGENCIES,
  VISIBILITIES,
} from './helpdesk.constants';

/** Zod schemas of part 15.2 (sections 8.7 to 8.21). Bodies and queries are `.strict()`. */
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
const title = z
  .string()
  .trim()
  .min(LIMITS.titleMin)
  .max(LIMITS.titleMax)
  .regex(NO_CONTROL, 'No control characters');
const fileIds = z
  .array(z.number().int().positive())
  .max(LIMITS.maxFiles)
  .refine(a => new Set(a).size === a.length, 'Duplicate file ids');
const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform(v => new Date(v));
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform(s =>
      s
        .split(',')
        .map(x => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).min(1).max(values.length));

const range = <T extends { from?: string; to?: string }>(v: T, c: z.RefinementCtx, a = 'from', b = 'to') => {
  if (!v.from || !v.to) return;
  const x = Date.parse(`${v.from}T00:00:00Z`);
  const y = Date.parse(`${v.to}T00:00:00Z`);
  if (x > y) c.addIssue({ code: 'custom', path: [a], message: `${a} must not be after ${b}` });
  else if ((y - x) / 86_400_000 > 366)
    c.addIssue({ code: 'custom', path: [b], message: 'The range may be at most 366 days' });
};

export const LIST_VIEWS = [
  'OPEN',
  'BUILDING',
  'FLATS',
  'URGENT',
  'RESOLVED',
  'UNASSIGNED',
  'BREACHED',
  'ALL',
] as const;
export const SORT_COLUMNS = [
  'lastActivityAt',
  'createdAt',
  'priority',
  'resolutionDueAt',
  'upvoteCount',
  'ticketNo',
] as const;

const filters = {
  view: z.enum(LIST_VIEWS).default('OPEN'),
  status: csv(TICKET_STATUSES).optional(),
  kind: z.enum(TICKET_KINDS).optional(),
  priority: csv(PRIORITIES).optional(),
  categoryId: idNum.optional(),
  assigneeUserId: idNum.optional(),
  assigneeType: z.enum(ASSIGNEE_TYPES).optional(),
  unitId: idNum.optional(),
  buildingId: idNum.optional(),
  locationNodeId: idNum.optional(),
  isRecurring: bool.optional(),
  createdFrom: ymd.optional(),
  createdTo: ymd.optional(),
  q: z.string().trim().min(2).max(60).optional(),
  sortBy: z.enum(SORT_COLUMNS).default('lastActivityAt'),
  sortOrder: z.enum(['asc', 'desc']).optional(),
};
const checkRange = (v: { createdFrom?: string; createdTo?: string }, c: z.RefinementCtx) =>
  range({ from: v.createdFrom, to: v.createdTo }, c, 'createdFrom', 'createdTo');

const list = z
  .object({
    ...filters,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine(checkRange);
const exportQuery = z.object(filters).strict().superRefine(checkRange);

const stats = z
  .object({
    from: ymd.optional(),
    to: ymd.optional(),
    kind: z.enum(TICKET_KINDS).optional(),
    categoryId: idNum.optional(),
  })
  .strict()
  .superRefine((v, c) => range(v, c));

const assignees = z
  .object({
    q: z.string().trim().max(60).optional(),
    type: z.enum(['MEMBER', 'STAFF', 'VENDOR']).optional(),
  })
  .strict();

const idParam = z.object({ id }).strict();
const commentParam = z.object({ id, commentId: id }).strict();
const fileParam = z.object({ id, fileId: id }).strict();

const onBehalf = z
  .object({
    unitId: z.number().int().positive(),
    requesterResidentId: z.number().int().positive().optional(),
    channel: z.enum(['PHONE', 'WALK_IN']),
    categoryId: z.number().int().positive(),
    subCategoryId: z.number().int().positive().optional(),
    title,
    description: z.string().trim().min(LIMITS.personalDescMin).max(LIMITS.descMax),
    priority: z.enum(PRIORITIES).optional(),
    preferredSlotFrom: isoDate.optional(),
    preferredSlotTo: isoDate.optional(),
    invoiceId: z.number().int().positive().optional(),
    fileIds: fileIds.optional(),
  })
  .strict();

const buildingBase = {
  locationNodeId: z.number().int().positive().optional(),
  qrToken: z
    .string()
    .regex(/^[A-Za-z0-9]{12}$/, 'A 12-character code')
    .optional(),
  affectedLevel: z.enum(AFFECTED_LEVELS).optional(),
  categoryId: z.number().int().positive(),
  subCategoryId: z.number().int().positive().optional(),
  title: title.optional(),
  description: z.string().trim().max(LIMITS.descMax).optional(),
  assetId: z.number().int().positive().optional(),
  duplicateReason: z.string().trim().min(10).max(300).optional(),
  fileIds: fileIds.optional(),
};
const needsLocation = (v: { locationNodeId?: number; qrToken?: string }, c: z.RefinementCtx) => {
  if (!v.locationNodeId && !v.qrToken)
    c.addIssue({ code: 'custom', path: ['locationNodeId'], message: 'Choose a location or scan a QR code' });
};
const buildingIssue = z
  .object({ ...buildingBase, urgency: z.enum(URGENCIES).optional(), priority: z.enum(PRIORITIES).optional() })
  .strict()
  .superRefine(needsLocation);
/** The staff app route and `helpdeskWork.reportBuildingIssue`: urgency required, no priority override. */
const workBuildingIssue = z
  .object({ ...buildingBase, urgency: z.enum(URGENCIES) })
  .strict()
  .superRefine(needsLocation);

const similar = z
  .object({
    locationNodeId: idNum,
    categoryId: idNum,
    q: z.string().trim().min(2).max(100).optional(),
  })
  .strict();

const patch = z
  .object({
    title: title.optional(),
    description: z.string().trim().max(LIMITS.descMax).optional(),
    categoryId: z.number().int().positive().optional(),
    subCategoryId: z.number().int().positive().nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    priorityReason: z.string().trim().min(5).max(300).optional(),
    affectedLevel: z.enum(AFFECTED_LEVELS).optional(),
    preferredSlotFrom: isoDate.nullable().optional(),
    preferredSlotTo: isoDate.nullable().optional(),
    isChargeable: z.boolean().optional(),
    version,
  })
  .strict()
  .refine(v => Object.keys(v).some(k => k !== 'version'), { message: 'Nothing to change' });

const assign = z
  .object({
    assigneeType: z.enum(ASSIGNEE_TYPES),
    userId: z.number().int().positive().optional(),
    staffId: z.number().int().positive().optional(),
    vendorId: z.number().int().positive().optional(),
    createWorkOrder: z.boolean().optional(),
    externalName: z.string().trim().min(2).max(120).optional(),
    externalMobile: z
      .string()
      .regex(/^[6-9]\d{9}$/, 'A 10-digit Indian mobile number')
      .optional(),
    note: z.string().trim().max(300).optional(),
    noteInternal: z.boolean().optional(),
    version,
  })
  .strict()
  .superRefine((v, c) => {
    const need: Record<string, keyof typeof v> = {
      MEMBER: 'userId',
      STAFF: 'staffId',
      VENDOR: 'vendorId',
    };
    if (v.assigneeType !== 'EXTERNAL' && !v[need[v.assigneeType]!])
      c.addIssue({
        code: 'custom',
        path: [need[v.assigneeType]!],
        message: 'Required for this assignee type',
      });
    if (v.assigneeType === 'EXTERNAL') {
      if (!v.externalName) c.addIssue({ code: 'custom', path: ['externalName'], message: 'Required' });
      if (!v.externalMobile) c.addIssue({ code: 'custom', path: ['externalMobile'], message: 'Required' });
    }
  });

const unassign = z.object({ reason: z.string().trim().min(5).max(300), version }).strict();

const transition = z
  .object({
    action: z.enum(ACTIONS),
    note: z.string().trim().max(2000).optional(),
    reason: z.string().trim().max(500).optional(),
    waitingReason: z.enum(['INFORMATION', 'ACCESS_TO_FLAT', 'CONFIRMATION', 'OTHER']).optional(),
    fileIds: fileIds.optional(),
    chargeFinalPaise: z.number().int().min(1).optional(),
    waiveReason: z.string().trim().max(300).optional(),
    version,
  })
  .strict();

const merge = z
  .object({
    intoTicketId: z.number().int().positive(),
    note: z.string().trim().max(300).optional(),
    version,
  })
  .strict();

const estimate = z
  .object({
    estimatePaise: z.number().int().min(LIMITS.chargeMinPaise).max(LIMITS.chargeMaxPaise),
    note: z.string().trim().min(5).max(300),
    version,
  })
  .strict();

const commentList = z
  .object({
    before: idNum.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const commentPost = z
  .object({
    body: z.string().trim().min(1).max(LIMITS.commentMax),
    visibility: z.enum(VISIBILITIES).optional(),
    notifyAffected: z.boolean().optional(),
    fileIds: fileIds.optional(),
  })
  .strict();
const commentDelete = z.object({ reason: z.string().trim().min(5).max(300).optional() }).strict();
const download = z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }).strict();

export const adminSchemas = {
  list,
  exportQuery,
  stats,
  assignees,
  idParam,
  commentParam,
  fileParam,
  onBehalf,
  buildingIssue,
  workBuildingIssue,
  similar,
  patch,
  assign,
  unassign,
  transition,
  merge,
  estimate,
  commentList,
  commentPost,
  commentDelete,
  download,
};

export type ListQuery = z.infer<typeof list>;
export type ExportQuery = z.infer<typeof exportQuery>;
export type StatsQuery = z.infer<typeof stats>;
export type BuildingIssueBody = z.infer<typeof buildingIssue>;
export type WorkBuildingIssueBody = z.infer<typeof workBuildingIssue>;
