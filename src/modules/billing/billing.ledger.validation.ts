import { z } from 'zod';
import { OPENING_STATUSES } from './billing.constants';

/** Zod schemas of sub-module 11.2 (sections 8.20 and 8.23). Bodies and queries are `.strict()`; the business rules are in the services. */
const id = z.coerce.number().int().positive();
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const version = z.number().int().min(1);

export const ledgerSchemas = {
  unitParam: z.object({ unitId: id }),
  idParam: z.object({ id }),
  statementQuery: z
    .object({ from: ymd.optional(), to: ymd.optional(), format: z.enum(['json', 'csv']).default('json') })
    .strict(),
  openingList: z
    .object({
      status: z.enum(OPENING_STATUSES).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
  openingImport: z
    .object({
      fileId: z.number().int().positive(),
      asOfDate: ymd,
      dryRun: z.boolean().default(false),
    })
    .strict(),
  openingPost: z.object({ confirmTotalPaise: z.number().int().safe() }).strict(),
  openingReverse: z.object({ reason: z.string().trim().min(10).max(500), version }).strict(),
  openingDelete: z.object({ version }).strict(),
};
