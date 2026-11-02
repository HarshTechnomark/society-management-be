import { z } from 'zod';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '../../models/platform-ticket.model';
import { SLUG_PATTERN } from '../societies/societies.slug';

/** Zod schemas of module 07 (section 8). Bodies are `.strict()`; ids are positive integers. */
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
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const fileIds = z
  .array(z.number().int().positive())
  .max(5)
  .refine(a => new Set(a).size === a.length, 'Duplicate file');
const category = z.enum(TICKET_CATEGORIES);
const priority = z.enum(TICKET_PRIORITIES);
const q = text(2, 100, 'Search');

const dateRange = <T extends z.ZodTypeAny>(s: T) =>
  s.superRefine((v: any, ctx) => {
    if (v.createdFrom && v.createdTo && v.createdFrom > v.createdTo)
      ctx.addIssue({
        code: 'custom',
        path: ['createdTo'],
        message: 'createdTo must not be before createdFrom',
      });
  });

export const opsSchemas = {
  idParam: z.object({ id }),

  // ---- 8.3 platform tickets
  ticketList: dateRange(
    z.object({
      status: many(z.enum(TICKET_STATUSES)),
      priority: many(priority),
      category: category.optional(),
      societyId: id.optional(),
      assignee: z
        .string()
        .regex(/^(me|none|[1-9]\d{0,18})$/, 'Use me, none or a user id')
        .optional(),
      slaBreached: bool.optional(),
      q: q.optional(),
      createdFrom: ymd.optional(),
      createdTo: ymd.optional(),
      sortBy: z
        .enum(['createdAt', 'updatedAt', 'priority', 'resolutionDueAt', 'lastMessageAt'])
        .default('createdAt'),
      sortOrder,
      ...page,
    }),
  ),
  platformTicketCreate: z
    .object({
      societyId: z.number().int().positive(),
      raisedByUserId: z.number().int().positive(),
      subject: text(5, 150, 'Subject'),
      category,
      priority: priority.optional(),
      body: text(10, 5000, 'Message'),
      fileIds: fileIds.optional(),
    })
    .strict(),
  ticketPatch: z
    .object({
      version: z.number().int().min(1),
      status: z.enum(['IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED']).optional(),
      closeReason: text(5, 500, 'Reason').optional(),
      priority: priority.optional(),
      category: category.optional(),
      assigneeUserId: z.number().int().positive().nullable().optional(),
    })
    .strict(),
  platformMessage: z
    .object({
      body: text(1, 5000, 'Message'),
      visibility: z.enum(['PUBLIC', 'INTERNAL']).optional(),
      fileIds: fileIds.optional(),
    })
    .strict(),

  // ---- 8.4 society tickets
  societyTicketList: z.object({
    status: many(z.enum(TICKET_STATUSES)),
    q: q.optional(),
    sortBy: z.enum(['createdAt', 'lastMessageAt']).default('createdAt'),
    sortOrder,
    ...page,
  }),
  societyTicketCreate: z
    .object({
      subject: text(5, 150, 'Subject'),
      category,
      priority: priority.optional(),
      body: text(10, 5000, 'Message'),
      fileIds: fileIds.optional(),
    })
    .strict(),
  societyMessage: z.object({ body: text(1, 5000, 'Message'), fileIds: fileIds.optional() }).strict(),
  reopen: z.object({ body: text(10, 5000, 'Message') }).strict(),
  close: z.object({ reason: text(0, 500, 'Reason').optional() }).strict(),
  rating: z
    .object({ rating: z.number().int().min(1).max(5), comment: text(0, 500, 'Comment').optional() })
    .strict(),

  // ---- 8.10 settings
  settingsPatch: z
    .object({
      changes: z
        .array(
          z
            .object({ key: z.string().min(1).max(80), value: z.unknown(), version: z.number().int().min(1) })
            .strict(),
        )
        .min(1)
        .max(30),
      reason: z.string().trim().max(500).optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      const keys = v.changes.map(c => c.key);
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: 'custom', path: ['changes'], message: 'Each key may appear once' });
      if (v.reason !== undefined && v.reason !== '' && v.reason.length < 5)
        ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Reason must be at least 5 characters' });
    }),

  // ---- 8.12 organizations
  organizationList: z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional(),
    q: q.optional(),
    sortBy: z.enum(['name', 'createdAt']).default('name'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
    ...page,
  }),
  organizationCreate: z
    .object({
      name: text(2, 150, 'Name'),
      slug: z.string().min(3).max(60).regex(SLUG_PATTERN, 'Use lowercase letters, digits and single dashes'),
      gstin: z
        .string()
        .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN')
        .nullable()
        .optional(),
      contactEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable().optional(),
      contactMobile: z
        .string()
        .regex(/^[6-9]\d{9}$/, 'Use a 10-digit Indian mobile number')
        .nullable()
        .optional(),
    })
    .strict(),
  organizationUpdate: z
    .object({
      name: text(2, 150, 'Name').optional(),
      gstin: z
        .string()
        .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN')
        .nullable()
        .optional(),
      contactEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable().optional(),
      contactMobile: z
        .string()
        .regex(/^[6-9]\d{9}$/, 'Use a 10-digit Indian mobile number')
        .nullable()
        .optional(),
    })
    .strict(),
  organizationStatus: z
    .object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']), reason: text(5, 500, 'Reason') })
    .strict(),
};
