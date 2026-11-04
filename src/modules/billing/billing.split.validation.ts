import { z } from 'zod';
import { paginationQuery } from '../../utils/pagination';
import { SPLIT_AMOUNT_SOURCES, SPLIT_BASES } from './billing.constants';
import { checkScopeShape, scopeTypeField, scopeValues } from './billing.setup.scope';
import { archiveBody, idParam, statusQuery, text, UNIT_CLASSES, versionField } from './billing.setup.shared';

/** Zod schemas of section 8.3 (bill split rules). Weights and amount source are cross-checked here; ids are checked in the service. */
const weightValue = z.number().int().min(0).max(1_000_000);
const weights = z.record(z.string().min(1).max(40), weightValue);

const base = {
  name: text(2, 100),
  description: z.string().trim().max(300).nullable().optional(),
  basis: z.enum(SPLIT_BASES),
  amountSource: z.enum(SPLIT_AMOUNT_SOURCES),
  fixedAmountPaise: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  scopeType: scopeTypeField.default('ALL_UNITS'),
  scopeValues: scopeValues.nullable().optional(),
  weights: weights.nullable().optional(),
};

interface Shape {
  basis: (typeof SPLIT_BASES)[number];
  amountSource: (typeof SPLIT_AMOUNT_SOURCES)[number];
  fixedAmountPaise?: number | null;
  scopeType: Parameters<typeof checkScopeShape>[0]['scopeType'];
  scopeValues?: (number | string)[] | null;
  weights?: Record<string, number> | null;
}
/** Shared by create and by the merged shape of a patch. */
export function checkSplitShape(b: Shape, add: (path: string, message: string) => void): void {
  if (b.amountSource === 'FIXED' && (b.fixedAmountPaise === undefined || b.fixedAmountPaise === null))
    add('fixedAmountPaise', 'Required when the amount is fixed');
  if (b.amountSource === 'RUN_INPUT' && b.fixedAmountPaise !== undefined && b.fixedAmountPaise !== null)
    add('fixedAmountPaise', 'Not allowed when the amount is entered on each run');
  checkScopeShape(b, add);
  const w = b.weights;
  if (b.basis === 'EQUAL' || b.basis === 'AREA') {
    if (w !== undefined && w !== null) add('weights', `Not allowed for ${b.basis}`);
    return;
  }
  if (!w || !Object.keys(w).length) return add('weights', 'Weights are required');
  if (Object.keys(w).length > 1000) add('weights', 'At most 1,000 weights');
  if (b.basis === 'UNIT_TYPE_WEIGHT') {
    const bad = Object.keys(w).filter(k => !UNIT_CLASSES.includes(k));
    if (bad.length) add('weights', `Not unit types or BHK values: ${bad.join(', ')}`);
  } else {
    const bad = Object.keys(w).filter(k => !/^[1-9]\d*$/.test(k));
    if (bad.length) add('weights', 'Keys must be unit ids');
  }
  if (!Object.values(w).some(v => v > 0)) add('weights', 'At least one weight must be above 0');
}

const create = z
  .object(base)
  .strict()
  .superRefine((b, ctx) =>
    checkSplitShape(b as Shape, (path, message) => ctx.addIssue({ code: 'custom', path: [path], message })),
  );

const patch = z
  .object({
    name: base.name.optional(),
    description: base.description,
    basis: base.basis.optional(),
    amountSource: base.amountSource.optional(),
    fixedAmountPaise: base.fixedAmountPaise,
    scopeType: scopeTypeField.optional(),
    scopeValues: base.scopeValues,
    weights: base.weights,
    version: versionField,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), { message: 'Nothing to change' });

const listQuery = paginationQuery(['name', 'id'] as const, 'name').extend({
  status: statusQuery,
  sortBy: z.enum(['name', 'id']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const splitSchemas = { idParam, listQuery, create, patch, archive: archiveBody };
export type SplitCreateInput = z.infer<typeof create>;
export type SplitPatchInput = z.infer<typeof patch>;
export type SplitListQuery = z.infer<typeof listQuery>;
export type SplitShape = Shape;
