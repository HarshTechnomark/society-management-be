import { z } from 'zod';

/** Zod schemas of the fund routes (section 8.13). Bodies and queries are `.strict()`. */
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const version = z.number().int().min(1);
const fundId = z.number().int().positive().nullable();

export const fundSchemas = {
  idParam: z.object({ id: z.coerce.number().int().positive() }).strict(),
  list: z
    .object({
      status: z.enum(['ACTIVE', 'CLOSED', 'ALL']).default('ACTIVE'),
      fundType: z.enum(['SINKING', 'REPAIR', 'CORPUS', 'COLLECTION', 'CUSTOM']).optional(),
    })
    .strict(),
  statement: z.object({ from: ymd.optional(), to: ymd.optional() }).strict(),
  create: z
    .object({
      fundType: z.enum(['COLLECTION', 'CUSTOM']).default('COLLECTION'),
      name: text(2, 80),
      purpose: text(1, 300).optional(),
      usageRequiresResolution: z.boolean().optional(),
      showToResidents: z.boolean().optional(),
    })
    .strict(),
  patch: z
    .object({
      name: text(2, 80).optional(),
      purpose: text(1, 300).nullable().optional(),
      usageRequiresResolution: z.boolean().optional(),
      showToResidents: z.boolean().optional(),
      status: z.literal('CLOSED').optional(),
      version,
    })
    .strict(),
  transfer: z
    .object({
      fromFundId: fundId,
      toFundId: fundId,
      amountPaise: z.number().int().min(100).max(100_000_000_000),
      date: ymd,
      reason: text(5, 500),
    })
    .strict(),
};

export type FundListQuery = z.infer<typeof fundSchemas.list>;
export type FundCreateInput = z.infer<typeof fundSchemas.create>;
export type FundPatchInput = z.infer<typeof fundSchemas.patch>;
export type FundTransferInput = z.infer<typeof fundSchemas.transfer>;
export type FundStatementQuery = z.infer<typeof fundSchemas.statement>;
