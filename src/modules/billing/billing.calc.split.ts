import { areaMilli, floorShare } from '../../lib/money';
import type { SplitBasis } from './billing.constants';

/**
 * Splitting a total bill across flats with exact paise (BR-11-22, F05). Pure functions. `splitPaise` is the only place that
 * divides; everything else only builds the weights.
 */
export interface SplitWeight {
  unitId: number;
  weight: bigint;
}

/**
 * `s_i = floor(T × w_i / W)`; the remainder `r = T − Σ s_i` (less than the number of flats) goes one paisa each to the flats
 * with the largest fractional part `(T × w_i) mod W`, ties by ascending `unitId`. The shares always add up to `T`.
 * Flats of weight 0 get nothing. `W = 0` throws (the caller reports `SPLIT_NO_ELIGIBLE_UNITS`).
 */
export function splitPaise(totalPaise: number, weights: SplitWeight[]): Map<number, number> {
  const w = weights.filter(x => x.weight > 0n);
  const sum = w.reduce((a, x) => a + x.weight, 0n);
  if (sum <= 0n) throw new RangeError('no weight to split by');
  const t = BigInt(totalPaise);
  const parts = w.map(x => ({
    unitId: x.unitId,
    share: floorShare(t, x.weight, sum),
    frac: (t * x.weight) % sum,
  }));
  let remainder = t - parts.reduce((a, p) => a + p.share, 0n);
  const order = [...parts].sort((a, b) =>
    a.frac === b.frac ? a.unitId - b.unitId : a.frac > b.frac ? -1 : 1,
  );
  for (const p of order) {
    if (remainder <= 0n) break;
    p.share += 1n;
    remainder -= 1n;
  }
  return new Map(parts.map(p => [p.unitId, Number(p.share)]));
}

export interface SplitUnit {
  id: number;
  unitType: string;
  bhk: string | null;
  areaSqft: string | null;
}
export interface SplitRuleData {
  basis: SplitBasis;
  weights: Record<string, number> | null;
}
export type SplitWeightResult = { weight: bigint } | { exception: 'MISSING_AREA' | 'MISSING_UNIT_TYPE_RATE' };

/** BR-11-22: the weight of one flat. `CUSTOM_WEIGHT` without an entry is weight 0 (the flat gets nothing). */
export function splitWeightOf(rule: SplitRuleData, unit: SplitUnit): SplitWeightResult {
  switch (rule.basis) {
    case 'EQUAL':
      return { weight: 1n };
    case 'AREA': {
      const a = unit.areaSqft ? areaMilli(unit.areaSqft) : 0n;
      return a > 0n ? { weight: a } : { exception: 'MISSING_AREA' };
    }
    case 'UNIT_TYPE_WEIGHT': {
      const w = rule.weights?.[unit.bhk ?? unit.unitType];
      return w === undefined ? { exception: 'MISSING_UNIT_TYPE_RATE' } : { weight: BigInt(w) };
    }
    case 'CUSTOM_WEIGHT':
      return { weight: BigInt(rule.weights?.[String(unit.id)] ?? 0) };
  }
}
