import { describe, expect, it } from 'vitest';
import {
  areaMilli,
  floorShare,
  percentOf,
  rate4,
  rateUnits,
  roundHalfUp,
  roundHalfUpBig,
  rupeesToPaise,
} from '../../src/lib/money';

/** Deterministic pseudo-random numbers so that a failing property is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

describe('roundHalfUp (BR-11-3)', () => {
  it('rounds half away from zero', () => {
    expect(roundHalfUp(5, 2)).toBe(3);
    expect(roundHalfUp(-5, 2)).toBe(-3);
    expect(roundHalfUp(4, 3)).toBe(1);
    expect(roundHalfUp(49, 100)).toBe(0);
    expect(roundHalfUp(50, 100)).toBe(1);
    expect(roundHalfUp(-49, 100)).toBe(0);
    expect(roundHalfUp(-50, 100)).toBe(-1);
  });

  it('worked example US-11-06: 19 of 30 days of 3,680 rupees is 233,067 paise', () => {
    expect(roundHalfUp(368_000 * 19, 30)).toBe(233_067);
  });

  it('property: |n/d − round| ≤ 1/2 and the result equals the bigint version', () => {
    const r = rng(11);
    for (let i = 0; i < 2000; i++) {
      const n = int(r, -1_000_000_000, 1_000_000_000);
      const d = int(r, 1, 100_000);
      const q = roundHalfUp(n, d);
      expect(Math.abs(2 * (n - q * d))).toBeLessThanOrEqual(d);
      expect(BigInt(q)).toBe(roundHalfUpBig(BigInt(n), BigInt(d)));
      expect(roundHalfUp(-n, d)).toBe(-q); // symmetric around zero
    }
  });

  it('refuses a non-positive divisor and unsafe integers', () => {
    expect(() => roundHalfUp(1, 0)).toThrow(RangeError);
    expect(() => roundHalfUp(2 ** 60, 1)).toThrow(RangeError);
    expect(() => roundHalfUpBig(1n, 0n)).toThrow(RangeError);
  });

  it('handles products beyond 2^53 with bigint input (principal × days × rate)', () => {
    const n = 9_007_199_254_740_993n * 3n;
    expect(roundHalfUpBig(n, 3n)).toBe(9_007_199_254_740_993n);
  });
});

describe('rate4 and percentOf (BR-11-2, BR-11-30)', () => {
  it('rate4 reads a DECIMAL(9,4) string digit by digit', () => {
    expect(rate4('21.0000')).toBe(210_000n);
    expect(rate4('9')).toBe(90_000n);
    expect(rate4('0.0001')).toBe(1n);
    expect(rate4('10.5')).toBe(105_000n);
    expect(rate4('100.0000')).toBe(rateUnits('100'));
    expect(() => rate4('1.23456')).toThrow(RangeError);
    expect(() => rate4('abc')).toThrow(RangeError);
  });

  it('GST: 18 % of 823,000 paise is CGST 74,070 + SGST 74,070 (US-11-05)', () => {
    expect(percentOf(823_000, '9.0000')).toBe(74_070);
    expect(percentOf(823_000, '18.0000')).toBe(148_140);
  });

  it('property: percentOf is within half a paisa of the exact value', () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      const a = int(r, 0, 5_000_000);
      const p = int(r, 1, 1_000_000); // 0.0001 .. 100.0000 %
      const rate = `${Math.floor(p / 10_000)}.${String(p % 10_000).padStart(4, '0')}`;
      const got = percentOf(a, rate);
      expect(Math.abs(2 * (a * p - got * 1_000_000))).toBeLessThanOrEqual(1_000_000);
    }
  });
});

describe('areaMilli (BR-11-2)', () => {
  it('converts a DECIMAL(10,3) string to milli-sq-ft', () => {
    expect(areaMilli('1150.500')).toBe(1_150_500n);
    expect(areaMilli('1150.5')).toBe(1_150_500n);
    expect(areaMilli('1150')).toBe(1_150_000n);
    expect(areaMilli('0.001')).toBe(1n);
    expect(areaMilli(980)).toBe(980_000n);
  });

  it('rejects bad input and more than 3 decimals', () => {
    for (const bad of ['', '-1', '1.2345', 'x', '1,150']) expect(() => areaMilli(bad)).toThrow(RangeError);
  });

  it('PER_SQFT worked example: 1,150.5 sq ft at 320 paise a month, one rounding', () => {
    expect(roundHalfUp(areaMilli('1150.500') * 320n * 1n, 1000)).toBe(368_160);
  });
});

describe('rupeesToPaise (BR-11-65)', () => {
  it('parses rupees with at most two decimals without floats', () => {
    expect(rupeesToPaise('1234')).toBe(123_400);
    expect(rupeesToPaise('1234.5')).toBe(123_450);
    expect(rupeesToPaise('0.07')).toBe(7);
    expect(rupeesToPaise('19.99')).toBe(1999);
  });
  it('rejects negatives, 3 decimals and junk', () => {
    for (const bad of ['-1', '1.234', '1e3', '', ' ']) expect(() => rupeesToPaise(bad)).toThrow(RangeError);
  });
});

describe('floorShare (BR-11-22)', () => {
  it('property: shares plus the remainder add up exactly to the total', () => {
    const r = rng(3);
    for (let i = 0; i < 300; i++) {
      const total = int(r, 1, 1_000_000_000);
      const weights = Array.from({ length: int(r, 1, 30) }, () => BigInt(int(r, 1, 5000)));
      const W = weights.reduce((a, b) => a + b, 0n);
      const shares = weights.map(w => floorShare(total, w, W));
      const sum = shares.reduce((a, b) => a + b, 0n);
      expect(sum <= BigInt(total)).toBe(true);
      expect(BigInt(total) - sum < BigInt(weights.length)).toBe(true);
    }
    expect(() => floorShare(1, 1n, 0n)).toThrow(RangeError);
  });
});
