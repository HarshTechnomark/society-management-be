import { z } from 'zod';
import { CATALOGUE } from './approvals.catalogue';
import { LIMITS, REQUEST_STATUS } from './approvals.constants';

/** Zod schemas of 14.2a (sections 8.1 to 8.11 and 8.19). Bodies and queries are `.strict()`. */
const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, 'Not a valid id')
  .transform(Number);
const idNum = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const reason = z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax);
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const typeKey = z.string().refine(v => Object.prototype.hasOwnProperty.call(CATALOGUE, v), 'Unknown type');
const DECIDED = ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const;
const entityTypes = [...new Set(Object.values(CATALOGUE).map(c => c.entityType))] as [string, ...string[]];

const listBase = {
  type: typeKey.optional(),
  overdue: bool.optional(),
  q: z.string().trim().min(2).max(60).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  sortBy: z.enum(['createdAt', 'amountPaise', 'dueAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
type RangeCheck = { from?: string; to?: string };
const ranged = <T extends RangeCheck>(v: T, c: z.RefinementCtx) => {
  if (!v.from || !v.to) return;
  const a = Date.parse(`${v.from}T00:00:00Z`);
  const b = Date.parse(`${v.to}T00:00:00Z`);
  if (a > b) c.addIssue({ code: 'custom', path: ['from'], message: 'from must not be after to' });
  else if ((b - a) / 86_400_000 > 366)
    c.addIssue({ code: 'custom', path: ['to'], message: 'The range may be at most 366 days' });
};

const list = z
  .object({
    ...listBase,
    view: z.enum(['FOR_ME', 'ALL_PENDING', 'DECIDED']).default('FOR_ME'),
    status: z.enum(DECIDED).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    ranged(v, c);
    if (v.status && v.view !== 'DECIDED')
      c.addIssue({ code: 'custom', path: ['status'], message: 'status applies to the DECIDED view only' });
  });

const submitted = z
  .object({ ...listBase, status: z.enum(REQUEST_STATUS).optional() })
  .strict()
  .superRefine(ranged);

const items = z
  .array(z.object({ id: idNum, version }).strict())
  .min(1)
  .max(LIMITS.bulkMax)
  .refine(a => new Set(a.map(i => i.id)).size === a.length, 'Ids must be unique');

export const inboxSchemas = {
  idParam: z.object({ id }).strict(),
  list,
  submitted,
  history: z.object({ entityType: z.enum(entityTypes), entityId: idNum }).strict(),
  approve: z
    .object({
      version,
      comment: z.string().trim().max(LIMITS.commentMax).optional(),
      onBehalfOfUserId: idNum.optional(),
    })
    .strict(),
  reject: z.object({ version, reason, onBehalfOfUserId: idNum.optional() }).strict(),
  cancel: z.object({ version, reason }).strict(),
  reassign: z
    .object({
      version,
      userId: idNum,
      slotIndex: z.number().int().min(0).max(LIMITS.maxSlotsPerStep).optional(),
      reason,
    })
    .strict(),
  bulk: z.object({ items }).strict(),
  residentList: z
    .object({
      status: z.enum(REQUEST_STATUS).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
};

export type ListQuery = z.infer<typeof list>;
export type SubmittedQuery = z.infer<typeof submitted>;
