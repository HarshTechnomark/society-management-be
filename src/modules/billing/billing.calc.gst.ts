import { percentOf, roundHalfUp } from '../../lib/money';
import { GST_HALF_RATE_PCT } from './billing.constants';

/**
 * GST (BR-11-30) and round-off (BR-11-4). Pure functions on integer paise.
 *
 * The Rs 7,500 test is per flat per period across all its parties: `B` (the full-period unprorated amounts of the THRESHOLD
 * heads) must be greater than the limit times the months of the period. Exactly the limit is exempt. When it applies the
 * whole taxable value is taxed, not the part above the limit.
 */
export function gstApplies(
  applyGst: boolean,
  thresholdBasePaise: number,
  exemptLimitPerMonthPaise: number,
  months: number,
): boolean {
  return applyGst && thresholdBasePaise > exemptLimitPerMonthPaise * months;
}

/** CGST and SGST of one document: `percentOf(taxable, '9.0000')` once on the total taxable value; SGST equals CGST. */
export function gstOf(taxableValuePaise: number): { cgstPaise: number; sgstPaise: number } {
  const half = taxableValuePaise > 0 ? percentOf(taxableValuePaise, GST_HALF_RATE_PCT) : 0;
  return { cgstPaise: half, sgstPaise: half };
}

/**
 * `R = roundHalfUp(T, 100) × 100`, `roundOffPaise = R − T`: remainders 0 to 49 round down, 50 to 99 round up, so the result
 * is between -49 and +50. Zero when `roundToRupee` is off.
 */
export function roundOffOf(totalBeforeRoundOffPaise: number, roundToRupee: boolean): number {
  if (!roundToRupee) return 0;
  return roundHalfUp(totalBeforeRoundOffPaise, 100) * 100 - totalBeforeRoundOffPaise;
}
