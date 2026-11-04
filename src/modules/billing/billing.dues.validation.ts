import { z } from 'zod';
import { NOTE_REASON_CODES, NOTE_STATUSES, NOTE_TYPES } from './billing.constants';

/** Zod schemas of sub-module 11.5 (sections 8.18, 8.19, 8.22). Queries and bodies are `.strict()`. */
const id = z.coerce.number().int().positive();
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const page = z.coerce.number().int().min(1).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(20);

export const duesSchemas = {
  idParam: z.object({ id }),
  /** `month` is `YYYY-MM`, default the current month of the society. */
  summaryQuery: z
    .object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
        .optional(),
    })
    .strict(),
  defaultersQuery: z
    .object({
      minDaysOverdue: z.coerce.number().int().min(1).max(3650).default(90),
      minAmountPaise: z.coerce.number().int().min(0).max(1_000_000_000).default(500_000),
      buildingId: id.optional(),
      sortBy: z.enum(['overduePaise', 'daysOverdue', 'unitLabel']).default('overduePaise'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      format: z.enum(['json', 'csv']).default('json'),
      page,
      limit,
    })
    .strict(),
  remindBody: z.object({}).strict(),
  bulkRemindBody: z
    .object({ scope: z.literal('OVERDUE'), buildingId: z.number().int().positive().optional() })
    .strict(),
  notesQuery: z
    .object({
      noteType: z.enum(NOTE_TYPES).optional(),
      status: z.enum(NOTE_STATUSES).optional(),
      reasonCode: z.enum(NOTE_REASON_CODES).optional(),
      invoiceId: id.optional(),
      unitId: id.optional(),
      from: ymd.optional(),
      to: ymd.optional(),
      sortBy: z.enum(['createdAt', 'noteDate', 'totalPaise']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      page,
      limit,
    })
    .strict(),
};
