import { roundHalfUp } from '../../lib/money';
import type { FeeMethod } from './payments.constants';

/**
 * Convenience fee (BR-12-37). The fee is grossed up so the society receives at least the base amount:
 * `gross = ceil(base x 1,000,000 / (1,000,000 - rateBp x 118))`; fee = gross - base; fee ex GST = round-half-up(fee x 100 / 118);
 * GST = fee - fee ex GST. Pure function; worked example: card 180 bp, base 680,900 gives gross 695,677, fee 12,523 + GST 2,254.
 */
export interface FeeSplit {
  basePaise: number;
  feePaise: number;
  feeGstPaise: number;
  grossPaise: number;
}

export function grossUp(basePaise: number, rateBp: number): FeeSplit {
  if (rateBp <= 0) return { basePaise, feePaise: 0, feeGstPaise: 0, grossPaise: basePaise };
  const denom = 1_000_000n - BigInt(rateBp) * 118n;
  const num = BigInt(basePaise) * 1_000_000n;
  const gross = Number((num + denom - 1n) / denom);
  const feeTotal = gross - basePaise;
  const feeExGst = roundHalfUp(feeTotal * 100, 118);
  return { basePaise, feePaise: feeExGst, feeGstPaise: feeTotal - feeExGst, grossPaise: gross };
}

/** Placeholder rates (basis points) until module 29 supplies them per gateway account. */
export const DEFAULT_FEE_RATES_BP: Record<FeeMethod, number> = {
  UPI: 0,
  CARD: 180,
  NETBANKING: 120,
  WALLET: 190,
};
