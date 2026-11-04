import { z } from 'zod';
import { METER_TYPES, MISSING_READING_POLICIES, RATE_TYPES } from './billing.constants';

/** Body of `POST /billing/rules/simulate` (section 8.2): a draft version without `reason`, the head, 1 to 20 flats, the period. */
const id = z.number().int().positive();
const paise = (max: number) => z.number().int().min(0).max(max);
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v, 'Not a real date');

const version = z
  .object({
    rateType: z.enum(RATE_TYPES),
    amountPaise: paise(100_000_000).optional(),
    ratePerSqftPaise: z.number().int().min(1).max(100_000).optional(),
    unitTypeRates: z.record(z.string().min(1).max(20), paise(100_000_000)).optional(),
    meterType: z.enum(METER_TYPES).optional(),
    slabs: z
      .array(
        z
          .object({ uptoMilli: z.number().int().positive().nullable(), ratePaise: paise(10_000_000) })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
    minimumChargePaise: paise(10_000_000).optional(),
    missingReadingPolicy: z.enum(MISSING_READING_POLICIES).optional(),
    billSplitRuleId: id.optional(),
    percent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,4})?$/)
      .optional(),
    baseChargeHeadIds: z.array(id).min(1).max(10).optional(),
    effectiveFrom: ymd.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const need: Record<string, string[]> = {
      FLAT_PER_UNIT: ['amountPaise'],
      PER_SQFT: ['ratePerSqftPaise'],
      PER_UNIT_TYPE: ['unitTypeRates'],
      METERED: ['meterType', 'slabs', 'minimumChargePaise', 'missingReadingPolicy'],
      SPLIT_TOTAL: ['billSplitRuleId'],
      PERCENT_OF_HEADS: ['percent', 'baseChargeHeadIds'],
      NONE: [],
    };
    for (const k of need[v.rateType]!)
      if ((v as Record<string, unknown>)[k] === undefined)
        ctx.addIssue({ code: 'custom', path: [k], message: `Required for ${v.rateType}` });
  });

const simulateBody = z
  .object({
    chargeHeadId: id,
    version,
    unitIds: z.array(id).min(1).max(20),
    periodStart: ymd,
  })
  .strict();

export const simSchemas = { simulateBody };
export type SimulateInput = z.infer<typeof simulateBody>;
