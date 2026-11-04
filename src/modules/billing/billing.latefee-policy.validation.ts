import { z } from 'zod';
import { paginationQuery } from '../../utils/pagination';
import { rateUnits } from '../../lib/money';
import {
  INTEREST_FROM,
  LATE_FEE_POLICY_TYPES,
  LATE_FEE_STATUSES,
  MAX_INTEREST_PCT,
} from './billing.constants';
import { text, ymd } from './billing.setup.shared';

/** Zod schema of section 8.4 (late fee policies). */
const create = z
  .object({
    policyType: z.enum(LATE_FEE_POLICY_TYPES),
    interestRatePct: z
      .string()
      .regex(/^\d{1,2}\.\d{4}$/, 'Use 4 decimals, e.g. 18.0000')
      .refine(
        v => rateUnits(v) >= 1n && rateUnits(v) <= rateUnits(MAX_INTEREST_PCT),
        'Between 0.0001 and 21.0000',
      )
      .optional(),
    interestFrom: z.enum(INTEREST_FROM).optional(),
    flatFeePaise: z.number().int().min(100).max(1_000_000).optional(),
    graceDays: z.number().int().min(0).max(30),
    minChargePaise: z.number().int().min(0).max(100_000).optional(),
    effectiveFrom: ymd,
    reason: text(5, 500),
    resolutionRef: z.string().trim().max(100).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (b.policyType === 'SIMPLE_INTEREST') {
      if (b.interestRatePct === undefined) add('interestRatePct', 'Required for simple interest');
      if (b.interestFrom === undefined) add('interestFrom', 'Required for simple interest');
      if (b.flatFeePaise !== undefined) add('flatFeePaise', 'Not allowed for simple interest');
    } else if (b.policyType === 'FLAT') {
      if (b.flatFeePaise === undefined) add('flatFeePaise', 'Required for a flat fee');
      if (b.interestRatePct !== undefined) add('interestRatePct', 'Not allowed for a flat fee');
      if (b.interestFrom !== undefined) add('interestFrom', 'Not allowed for a flat fee');
    } else {
      for (const k of ['interestRatePct', 'interestFrom', 'flatFeePaise'] as const)
        if (b[k] !== undefined) add(k, 'Not allowed when there is no late fee');
    }
  });

const listQuery = paginationQuery(['effectiveFrom', 'id'] as const, 'effectiveFrom').extend({
  status: z.enum(LATE_FEE_STATUSES).optional(),
});

export const policySchemas = { create, listQuery };
export type PolicyCreateInput = z.infer<typeof create>;
export type PolicyListQuery = z.infer<typeof listQuery>;
