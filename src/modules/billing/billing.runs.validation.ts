import { z } from 'zod';
import { EXCEPTION_CODES, ITEM_STATUSES, RUN_STATUSES, RUN_TYPES, WARNING_CODES } from './billing.constants';

/** Zod schemas of the run routes (sections 8.5 to 8.10). Bodies are strict; ids are positive integers. */
const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

const splitInputs = z
  .array(
    z
      .object({
        billSplitRuleId: z.number().int().positive(),
        amountPaise: z.number().int().min(1).max(1_000_000_000),
      })
      .strict(),
  )
  .max(50)
  .refine(a => new Set(a.map(x => x.billSplitRuleId)).size === a.length, 'Split rule ids must be unique');

const createRun = z
  .object({
    runType: z.enum(RUN_TYPES),
    periodStart: ymd,
    scopeType: z.enum(['ALL_UNITS', 'BUILDINGS', 'UNITS']).optional(),
    scopeValues: z.array(z.number().int().positive()).min(1).max(1000).optional(),
    splitInputs: splitInputs.optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scopeType === 'BUILDINGS' && (v.scopeValues?.length ?? 0) > 200)
      ctx.addIssue({ code: 'custom', path: ['scopeValues'], message: 'At most 200 buildings' });
  });

const patchRun = z
  .object({
    splitInputs: splitInputs.optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    version,
  })
  .strict();

const versionOnly = z.object({ version }).strict();
const exclude = z.object({ reason: text(5, 300), version }).strict();
const publish = z
  .object({
    confirmLabel: z.string().min(1).max(30),
    version,
    previewHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
const cancel = z.object({ reason: text(5, 500), version }).strict();

const runList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(RUN_STATUSES).optional(),
  runType: z.enum(RUN_TYPES).optional(),
  periodFrom: ymd.optional(),
  periodTo: ymd.optional(),
  sortBy: z.enum(['periodStart', 'createdAt', 'totalPaise']).default('periodStart'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
const itemList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(ITEM_STATUSES).optional(),
  exceptionCode: z.enum(EXCEPTION_CODES).optional(),
  warningCode: z.enum(WARNING_CODES).optional(),
  q: text(1, 40).optional(),
  sortBy: z.enum(['unitLabel', 'totalPaise', 'variancePct']).default('unitLabel'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

const idParam = z.object({ id });
const itemParam = z.object({ id, itemId: id });

export const runSchemas = {
  createRun,
  patchRun,
  versionOnly,
  exclude,
  publish,
  cancel,
  runList,
  itemList,
  idParam,
  itemParam,
};
export type CreateRunInput = z.infer<typeof createRun>;
export type RunListQuery = z.infer<typeof runList>;
export type ItemListQuery = z.infer<typeof itemList>;
