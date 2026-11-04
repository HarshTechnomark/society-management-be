import { z } from 'zod';
import { paginationQuery } from '../../utils/pagination';
import { rateUnits } from '../../lib/money';
import { METER_TYPES, MISSING_READING_POLICIES, SCOPE_TYPES } from './billing.constants';
import { checkScopeShape, scopeTypeField, scopeValues } from './billing.setup.scope';
import {
  archiveBody,
  idParam,
  positiveInt,
  statusQuery,
  text,
  unitClass,
  versionField,
  ymd,
} from './billing.setup.shared';

/**
 * Zod schemas of section 8.2 (billing rules and versions). Each rate type is its own strict object, so a field that does not
 * belong to the `rateType` is `400 VALIDATION_FAILED`. Rules that need the database (heads, split rules, dates, plan) are in the service.
 */
const money = (max: number, min = 0) => z.number().int().min(min).max(max);

const slab = z
  .object({
    uptoMilli: z.number().int().min(1).max(1_000_000_000_000).nullable(),
    ratePaise: money(10_000_000),
  })
  .strict();
/** 1 to 10 slabs, strictly ascending `uptoMilli`, only the last one open (`null`), and the last one must be open. */
const slabs = z
  .array(slab)
  .min(1)
  .max(10)
  .superRefine((a, ctx) => {
    a.forEach((s, i) => {
      const last = i === a.length - 1;
      if (last && s.uptoMilli !== null)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'uptoMilli'],
          message: 'The last slab must have no upper limit (null)',
        });
      if (!last && s.uptoMilli === null)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'uptoMilli'],
          message: 'Only the last slab can have no upper limit',
        });
      const prev = a[i - 1]?.uptoMilli;
      if (i > 0 && s.uptoMilli !== null && prev !== null && prev !== undefined && s.uptoMilli <= prev)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'uptoMilli'],
          message: 'Slab limits must be strictly ascending',
        });
    });
  });

const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Use up to 4 decimals, e.g. 10.0000')
  .refine(v => rateUnits(v) >= 1n && rateUnits(v) <= 1_000_000n, 'Between 0.0001 and 100.0000');

const common = {
  effectiveFrom: ymd,
  reason: text(5, 500),
  resolutionRef: z.string().trim().max(100).optional(),
};
const variant = <T extends string, S extends z.ZodRawShape>(rateType: T, shape: S) =>
  z.object({ rateType: z.literal(rateType), ...shape, ...common }).strict();

const versionFields = z.discriminatedUnion('rateType', [
  variant('FLAT_PER_UNIT', { amountPaise: money(100_000_000) }),
  variant('PER_SQFT', { ratePerSqftPaise: money(100_000, 1) }),
  variant('PER_UNIT_TYPE', {
    unitTypeRates: z
      .record(unitClass, money(100_000_000))
      .refine(r => Object.keys(r).length >= 1 && Object.keys(r).length <= 14, 'Between 1 and 14 unit types'),
  }),
  variant('METERED', {
    meterType: z.enum(METER_TYPES),
    slabs,
    minimumChargePaise: money(10_000_000),
    missingReadingPolicy: z.enum(MISSING_READING_POLICIES),
  }),
  variant('SPLIT_TOTAL', { billSplitRuleId: positiveInt }),
  variant('PERCENT_OF_HEADS', {
    percent,
    baseChargeHeadIds: z
      .array(positiveInt)
      .min(1)
      .max(10)
      .refine(a => new Set(a).size === a.length, 'Head ids must be unique'),
  }),
  variant('NONE', {}),
]);

const createRule = z
  .object({
    chargeHeadId: positiveInt,
    name: text(2, 100),
    scopeType: scopeTypeField,
    scopeValues: scopeValues.optional(),
    firstVersion: versionFields,
  })
  .strict()
  .superRefine((b, ctx) =>
    checkScopeShape(b, (path, message) => ctx.addIssue({ code: 'custom', path: [path], message })),
  );

const patchRule = z
  .object({
    name: text(2, 100).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    scopeType: scopeTypeField.optional(),
    scopeValues: scopeValues.nullable().optional(),
    version: versionField,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), { message: 'Nothing to change' })
  .refine(b => b.scopeValues === undefined || b.scopeType !== undefined, {
    path: ['scopeType'],
    message: 'Send scopeType together with scopeValues',
  });

const listQuery = paginationQuery(['sortOrder', 'name', 'id'] as const, 'sortOrder').extend({
  status: statusQuery,
  chargeHeadId: z.coerce.number().int().positive().optional(),
  scopeType: z.enum(SCOPE_TYPES).optional(),
  sortBy: z.enum(['sortOrder', 'name', 'id']).default('sortOrder'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const ruleSchemas = {
  idParam,
  listQuery,
  createRule,
  patchRule,
  archive: archiveBody,
  addVersion: versionFields,
};
export type VersionInput = z.infer<typeof versionFields>;
export type RuleCreateInput = z.infer<typeof createRule>;
export type RulePatchInput = z.infer<typeof patchRule>;
export type RuleListQuery = z.infer<typeof listQuery>;
