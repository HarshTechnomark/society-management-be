import type { SplitBasis } from './billing.constants';
import { areaMilli } from '../../lib/money';

/**
 * The exact-paise split of a total bill across flats (BR-11-22). Pure: no database, no clock. The compute engine (11.3)
 * calls `splitPaise` with the weights it got from `splitWeight`.
 */
export interface WeightedUnit {
  unitId: number;
  weight: bigint;
}
export interface UnitShare {
  unitId: number;
  sharePaise: number;
}

/**
 * `s_i = floor(T x w_i / W)`; the remainder `r = T - sum(s_i)` (less than the number of flats) goes one paisa each to the flats
 * with the largest fractional part `(T x w_i) mod W`, ties broken by ascending `unitId`. The shares add up to `T` exactly.
 * The result keeps the order of `units`. `W = 0` throws (the caller reports `SPLIT_NO_ELIGIBLE_UNITS`).
 */
export function splitPaise(totalPaise: number | bigint, units: readonly WeightedUnit[]): UnitShare[] {
  const total = BigInt(totalPaise);
  if (total < 0n) throw new RangeError('total must not be negative');
  const sumW = units.reduce((a, u) => a + u.weight, 0n);
  if (sumW <= 0n) throw new RangeError('total weight must be positive');
  const rows = units.map(u => {
    if (u.weight < 0n) throw new RangeError('weights must not be negative');
    const product = total * u.weight;
    return { unitId: u.unitId, share: product / sumW, frac: product % sumW };
  });
  let remainder = total - rows.reduce((a, r) => a + r.share, 0n);
  const ranked = [...rows].sort((a, b) =>
    a.frac === b.frac ? a.unitId - b.unitId : a.frac > b.frac ? -1 : 1,
  );
  for (const r of ranked) {
    if (remainder <= 0n) break;
    r.share += 1n;
    remainder -= 1n;
  }
  return rows.map(r => ({ unitId: r.unitId, sharePaise: Number(r.share) }));
}

export type SplitWeight = { weight: bigint } | { exception: 'MISSING_AREA' | 'MISSING_UNIT_TYPE_RATE' };

/**
 * Weight of one flat for a basis: `EQUAL` 1; `AREA` the milli-sq-ft (a flat without area is the exception `MISSING_AREA`);
 * `UNIT_TYPE_WEIGHT` `weights[bhk ?? unitType]` (missing is `MISSING_UNIT_TYPE_RATE`); `CUSTOM_WEIGHT` `weights[unitId]`
 * (missing is weight 0: the flat gets nothing).
 */
export function splitWeight(
  basis: SplitBasis,
  unit: { id: number; unitType: string; bhk: string | null; areaSqft: string | null },
  weights: Record<string, number> | null,
): SplitWeight {
  switch (basis) {
    case 'EQUAL':
      return { weight: 1n };
    case 'AREA': {
      const a = unit.areaSqft ? areaMilli(unit.areaSqft) : 0n;
      return a > 0n ? { weight: a } : { exception: 'MISSING_AREA' };
    }
    case 'UNIT_TYPE_WEIGHT': {
      const w = weights?.[unit.bhk ?? unit.unitType];
      return w === undefined ? { exception: 'MISSING_UNIT_TYPE_RATE' } : { weight: BigInt(w) };
    }
    case 'CUSTOM_WEIGHT':
      return { weight: BigInt(weights?.[String(unit.id)] ?? 0) };
  }
}
