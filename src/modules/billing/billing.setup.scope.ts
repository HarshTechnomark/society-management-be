import { Op } from 'sequelize';
import { z } from 'zod';
import { Building, Unit } from '../../models';
import { SCOPE_TYPES, type ScopeType } from './billing.constants';
import { unitClass } from './billing.setup.shared';
import { ValidationError } from '../../utils/errors';

/**
 * Unit scope of billing rules and bill split rules (BR-11-14, section 8.2): `scopeType` and `scopeValues`.
 * `ALL_UNITS` has no values; `BUILDINGS` 1 to 200 building ids; `UNIT_TYPES` 1 to 14 unique `unitType`/`bhk` values;
 * `UNITS` 1 to 1,000 unit ids. The ids are checked against the society by `assertScopeValues`.
 */
export const scopeTypeField = z.enum(SCOPE_TYPES);
const ids = (max: number) => z.array(z.number().int().positive()).min(1).max(max);
const scopeValuesField = z.union([ids(1000), z.array(unitClass).min(1).max(14)]);

export interface ScopeShape {
  scopeType: ScopeType;
  scopeValues?: (number | string)[] | null;
}

/** Cross-field check used by `superRefine` of the create and patch bodies. */
export function checkScopeShape(b: ScopeShape, addIssue: (path: string, message: string) => void): void {
  const v = b.scopeValues;
  if (b.scopeType === 'ALL_UNITS') {
    if (v !== undefined && v !== null) addIssue('scopeValues', 'Not allowed for ALL_UNITS');
    return;
  }
  if (!v) return addIssue('scopeValues', 'Required unless the scope is ALL_UNITS');
  const unique = new Set(v).size === v.length;
  if (!unique) addIssue('scopeValues', 'Values must be unique');
  if (b.scopeType === 'UNIT_TYPES') {
    if (!v.every(x => typeof x === 'string')) addIssue('scopeValues', 'Use unit type or BHK values');
  } else {
    if (!v.every(x => typeof x === 'number')) addIssue('scopeValues', 'Use ids');
    if (b.scopeType === 'BUILDINGS' && v.length > 200) addIssue('scopeValues', 'At most 200 buildings');
  }
}
export const scopeValues = scopeValuesField;

/** BUILDINGS: buildings of the society; UNITS: ACTIVE units of the society (400 with the unknown ids listed). */
export async function assertScopeValues(societyId: number, b: ScopeShape): Promise<void> {
  if (b.scopeType === 'BUILDINGS' || b.scopeType === 'UNITS') {
    const wanted = (b.scopeValues ?? []) as number[];
    const found =
      b.scopeType === 'BUILDINGS'
        ? await Building.findAll({ where: { societyId, id: { [Op.in]: wanted } }, attributes: ['id'] })
        : await Unit.findAll({
            where: { societyId, status: 'ACTIVE', id: { [Op.in]: wanted } },
            attributes: ['id'],
          });
    const have = new Set(found.map(r => Number(r.id)));
    const unknown = wanted.filter(id => !have.has(id));
    if (unknown.length)
      throw new ValidationError([
        {
          field: 'scopeValues',
          message: `${b.scopeType === 'BUILDINGS' ? 'Unknown buildings' : 'Unknown or archived units'}: ${unknown.slice(0, 20).join(', ')}`,
        },
      ]);
  }
}

/** Do two scopes of the same type share a value (BR-11-14)? `ALL_UNITS` always overlaps another `ALL_UNITS`. */
export function scopesOverlap(a: ScopeShape, b: ScopeShape): boolean {
  if (a.scopeType !== b.scopeType) return false;
  if (a.scopeType === 'ALL_UNITS') return true;
  const set = new Set((a.scopeValues ?? []).map(String));
  return (b.scopeValues ?? []).some(x => set.has(String(x)));
}
