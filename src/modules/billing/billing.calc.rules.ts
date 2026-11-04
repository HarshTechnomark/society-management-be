import type { ScopeType } from './billing.constants';
import type { RateVersion } from './billing.calc.rates';

/**
 * Which rule applies to a flat (BR-11-14). Pure functions. For one flat and one head the most specific matching rule wins:
 * `UNITS` > `UNIT_TYPES` > `BUILDINGS` > `ALL_UNITS`. A `UNITS` rule with a zero rate is an exemption; the rule that wins may
 * also be a `NONE` version (billing stopped for that scope).
 */
export interface ScopeUnit {
  id: number;
  buildingId: number;
  unitType: string;
  bhk: string | null;
}
export interface RuleCandidate {
  ruleId: number;
  chargeHeadId: number;
  scopeType: ScopeType;
  scopeValues: (number | string)[] | null;
  version: RateVersion;
}

const SPECIFICITY: Record<ScopeType, number> = { UNITS: 4, UNIT_TYPES: 3, BUILDINGS: 2, ALL_UNITS: 1 };

/** True when the flat is inside the scope (`UNIT_TYPES` matches either its `unitType` or its `bhk`, case-insensitively). */
export function scopeMatches(
  scopeType: ScopeType,
  scopeValues: (number | string)[] | null,
  unit: ScopeUnit,
): boolean {
  if (scopeType === 'ALL_UNITS') return true;
  const values = (scopeValues ?? []).map(v => String(v).toUpperCase());
  switch (scopeType) {
    case 'BUILDINGS':
      return values.includes(String(unit.buildingId));
    case 'UNITS':
      return values.includes(String(unit.id));
    case 'UNIT_TYPES':
      return (
        values.includes(unit.unitType.toUpperCase()) ||
        (unit.bhk !== null && values.includes(unit.bhk.toUpperCase()))
      );
    default:
      return false;
  }
}

/** The most specific matching candidate of one head for a flat; ties (which BR-11-14 forbids) go to the lowest rule id. */
export function winningRule(candidates: RuleCandidate[], unit: ScopeUnit): RuleCandidate | undefined {
  let best: RuleCandidate | undefined;
  for (const c of candidates) {
    if (!scopeMatches(c.scopeType, c.scopeValues, unit)) continue;
    if (
      !best ||
      SPECIFICITY[c.scopeType] > SPECIFICITY[best.scopeType] ||
      (SPECIFICITY[c.scopeType] === SPECIFICITY[best.scopeType] && c.ruleId < best.ruleId)
    )
      best = c;
  }
  return best;
}
