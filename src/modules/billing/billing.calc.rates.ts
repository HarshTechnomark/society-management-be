import { areaMilli, formatRupees, roundHalfUpBig } from '../../lib/money';
import type {
  ExceptionCode,
  MeterType,
  MissingReadingPolicy,
  RateType,
  WarningCode,
} from './billing.constants';

/**
 * Rate type formulas of BR-11-17 (the amount of one head for one flat for the whole period, before proration). Every formula is
 * kept as a fraction `num / den` so that proration (BR-11-28) can fold `liableDays / periodDays` into the same single division:
 * `full = roundHalfUp(num, den)`, `prorated = roundHalfUp(num × liableDays, den × periodDays)`. Pure functions: no database.
 */
export interface RateUnit {
  id: number;
  unitType: string;
  bhk: string | null;
  areaSqft: string | null;
}

export interface MeterSlab {
  uptoMilli: number | null;
  ratePaise: number;
}
export interface RateVersion {
  id: number;
  versionNo: number;
  rateType: RateType;
  amountPaise: number | null;
  ratePerSqftPaise: number | null;
  unitTypeRates: Record<string, number> | null;
  meterType: MeterType | null;
  slabs: MeterSlab[] | null;
  minimumChargePaise: number | null;
  missingReadingPolicy: MissingReadingPolicy | null;
  billSplitRuleId: number | null;
  percent: string | null;
  baseChargeHeadIds: number[] | null;
}

/** What module 21 reported for one flat (BR-11-17 meter source). */
export interface MeterReading {
  quantityMilli: bigint;
  readingIds: number[];
  isEstimated: boolean;
}

export interface RateInput {
  unit: RateUnit;
  /** Months in the period (1, 3, 6, 12). */
  months: number;
  /** Share of a split total for this flat (paise), or undefined when the flat has none; `SPLIT_TOTAL` only. */
  splitShare?: number;
  /** Set when the flat could not be weighed by the split rule (missing area or type weight). */
  splitException?: ExceptionCode;
  meter?: MeterReading;
}

export interface RateComputation {
  method: RateType;
  formula: string;
  inputs: Record<string, unknown>;
  text: string;
  readingIds?: number[];
}

export type RateResult =
  | {
      kind: 'amount';
      num: bigint;
      den: bigint;
      /** Metered and split-share amounts are not prorated. */
      prorates: boolean;
      quantity: string | null;
      ratePaise: number | null;
      computation: RateComputation;
      warnings: WarningCode[];
    }
  | { kind: 'none' }
  | { kind: 'exception'; code: ExceptionCode; message: string };

const monthsText = (m: number): string => (m === 1 ? '' : ` × ${m} months`);
const fixed = (milli: bigint, digits: number): string => {
  const s = (milli < 0n ? -milli : milli).toString().padStart(digits + 1, '0');
  return `${milli < 0n ? '-' : ''}${s.slice(0, s.length - digits)}.${s.slice(s.length - digits)}`;
};
/** Plain number text for areas: `1150 sq ft`, `1150.5 sq ft`. */
export const areaText = (milli: bigint): string => fixed(milli, 3).replace(/\.?0+$/, '');

export function rateOf(v: RateVersion, input: RateInput): RateResult {
  const m = BigInt(input.months);
  const { unit } = input;
  switch (v.rateType) {
    case 'NONE':
      return { kind: 'none' };
    case 'FLAT_PER_UNIT': {
      const amt = BigInt(v.amountPaise ?? 0);
      return {
        kind: 'amount',
        num: amt * m,
        den: 1n,
        prorates: true,
        quantity: null,
        ratePaise: Number(amt),
        warnings: [],
        computation: {
          method: 'FLAT_PER_UNIT',
          formula: 'amountPaise × months',
          inputs: { amountPaise: Number(amt), months: input.months },
          text: `${formatRupees(Number(amt))} per month${monthsText(input.months)}`,
        },
      };
    }
    case 'PER_SQFT': {
      const area = unit.areaSqft ? areaMilli(unit.areaSqft) : 0n;
      if (area <= 0n)
        return {
          kind: 'exception',
          code: 'MISSING_AREA',
          message: 'The flat has no area. Add its area in Society setup, then recompute.',
        };
      const rate = BigInt(v.ratePerSqftPaise ?? 0);
      return {
        kind: 'amount',
        num: area * rate * m,
        den: 1000n,
        prorates: true,
        quantity: fixed(area, 3) + '0',
        ratePaise: Number(rate),
        warnings: [],
        computation: {
          method: 'PER_SQFT',
          formula: 'roundHalfUp(areaMilli × ratePerSqftPaise × months, 1000)',
          inputs: {
            areaSqft: unit.areaSqft,
            areaMilli: area.toString(),
            ratePerSqftPaise: Number(rate),
            months: input.months,
          },
          text: `${areaText(area)} sq ft × ${formatRupees(Number(rate))} per sq ft${monthsText(input.months)}`,
        },
      };
    }
    case 'PER_UNIT_TYPE': {
      const cls = unit.bhk ?? unit.unitType;
      const rate = v.unitTypeRates?.[cls];
      if (rate === undefined)
        return {
          kind: 'exception',
          code: 'MISSING_UNIT_TYPE_RATE',
          message: `The rule has no rate for ${cls} flats. Add one to the rule, then recompute.`,
        };
      return {
        kind: 'amount',
        num: BigInt(rate) * m,
        den: 1n,
        prorates: true,
        quantity: null,
        ratePaise: rate,
        warnings: [],
        computation: {
          method: 'PER_UNIT_TYPE',
          formula: 'unitTypeRates[class] × months',
          inputs: { class: cls, ratePaise: rate, months: input.months },
          text: `${cls}: ${formatRupees(rate)} per month${monthsText(input.months)}`,
        },
      };
    }
    case 'METERED':
      return meteredAmount(v, input);
    case 'SPLIT_TOTAL': {
      if (input.splitException)
        return {
          kind: 'exception',
          code: input.splitException,
          message:
            input.splitException === 'MISSING_AREA'
              ? 'The flat has no area, so its share of the split bill cannot be worked out.'
              : 'The split rule has no weight for this type of flat.',
        };
      const share = input.splitShare ?? 0;
      return {
        kind: 'amount',
        num: BigInt(share),
        den: 1n,
        prorates: false,
        quantity: null,
        ratePaise: null,
        warnings: [],
        computation: {
          method: 'SPLIT_TOTAL',
          formula: 'floor(T × w / W) with the remainder paise to the largest fractions',
          inputs: { sharePaise: share, billSplitRuleId: v.billSplitRuleId },
          text: `Share of a shared bill: ${formatRupees(share)}`,
        },
      };
    }
    case 'PERCENT_OF_HEADS':
      // computed by the unit calculator once the base heads are known (BR-11-17)
      return { kind: 'none' };
  }
}

function meteredAmount(v: RateVersion, input: RateInput): RateResult {
  const minimum = BigInt(v.minimumChargePaise ?? 0) * BigInt(input.months);
  const reading = input.meter;
  if (!reading) {
    if (v.missingReadingPolicy === 'MINIMUM_CHARGE')
      return {
        kind: 'amount',
        num: minimum * 1000n,
        den: 1000n,
        prorates: false,
        quantity: null,
        ratePaise: null,
        warnings: ['ESTIMATED_READING', 'MINIMUM_CHARGE_APPLIED'],
        computation: {
          method: 'METERED',
          formula: 'minimumChargePaise × months (no reading)',
          inputs: { minimumChargePaise: v.minimumChargePaise, months: input.months },
          text: `No reading: minimum charge ${formatRupees(Number(minimum))}`,
          readingIds: [],
        },
      };
    return {
      kind: 'exception',
      code: 'MISSING_READING',
      message: 'No meter reading for this flat. Add the reading, then recompute, or exclude the flat.',
    };
  }
  const q = reading.quantityMilli;
  let total = 0n;
  let from = 0n;
  const used: { uptoMilli: number | null; quantityMilli: string; ratePaise: number }[] = [];
  for (const s of v.slabs ?? []) {
    if (q <= from) break;
    const upto = s.uptoMilli === null ? q : BigInt(s.uptoMilli);
    const inSlab = (q < upto ? q : upto) - from;
    if (inSlab > 0n) {
      total += inSlab * BigInt(s.ratePaise);
      used.push({ uptoMilli: s.uptoMilli, quantityMilli: inSlab.toString(), ratePaise: s.ratePaise });
    }
    from = upto;
  }
  const warnings: WarningCode[] = reading.isEstimated ? ['ESTIMATED_READING'] : [];
  let amountTimes1000 = total;
  let formula = 'roundHalfUp(Σ slab quantity × slab rate, 1000)';
  if (roundHalfUpBig(total, 1000n) < minimum) {
    amountTimes1000 = minimum * 1000n;
    warnings.push('MINIMUM_CHARGE_APPLIED');
    formula = 'minimumChargePaise × months (consumption below the minimum)';
  }
  return {
    kind: 'amount',
    num: amountTimes1000,
    den: 1000n,
    prorates: false,
    quantity: fixed(q, 3).replace(/\.?0+$/, '') + '',
    ratePaise: null,
    warnings,
    computation: {
      method: 'METERED',
      formula,
      inputs: {
        consumptionMilli: q.toString(),
        slabs: used,
        minimumChargePaise: v.minimumChargePaise,
        months: input.months,
      },
      text: `${q.toString()} units metered`,
      readingIds: reading.readingIds,
    },
  };
}
