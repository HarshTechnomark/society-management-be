/**
 * Money helpers (module 01, module 06 BR-06-16). Money is integer paise. Divisions use BigInt and round half away from
 * zero to the nearest paisa; floating point is never used for amounts.
 */

const toBig = (n: number | bigint): bigint => {
  if (typeof n === 'bigint') return n;
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer: ${n}`);
  return BigInt(n);
};

const toSafeNumber = (b: bigint): number => {
  const n = Number(b);
  if (!Number.isSafeInteger(n)) throw new RangeError(`result out of range: ${b}`);
  return n;
};

/** `sign(n) × floor((2|n| + d) / (2d))`: n ÷ d rounded half away from zero. `d` must be positive. */
export function roundHalfUp(n: number | bigint, d: number | bigint): number {
  const nb = toBig(n);
  const db = toBig(d);
  if (db <= 0n) throw new RangeError('divisor must be positive');
  const abs = nb < 0n ? -nb : nb;
  const q = (2n * abs + db) / (2n * db);
  return toSafeNumber(nb < 0n ? -q : q);
}

/** Scale of a percentage string: 4 decimal places, as stored in DECIMAL(9,4) columns. */
const RATE_SCALE = 10_000n;

/**
 * A percentage such as `"18.0000"`, `"9"` or `9` as an integer number of 1/10,000ths of a percent. Strings are parsed
 * digit by digit (never through a float); more than 4 decimals are refused.
 */
export function rateUnits(ratePct: string | number): bigint {
  const s = typeof ratePct === 'number' ? String(ratePct) : ratePct.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,4}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid percentage: ${ratePct}`);
  const units = BigInt(m[2]!) * RATE_SCALE + BigInt((m[3] ?? '').padEnd(4, '0'));
  return m[1] ? -units : units;
}

/** `roundHalfUp(amount × ratePct / 100)`; `divisor` divides the rate further (2 for half the GST rate). */
export function percentOf(amountPaise: number | bigint, ratePct: string | number, divisor = 1): number {
  return roundHalfUp(toBig(amountPaise) * rateUnits(ratePct), 100n * RATE_SCALE * toBig(divisor));
}

/** `₹1,16,252.78` style (Indian grouping) for descriptions and messages; whole rupees drop the paise. */
export function formatRupees(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${neg ? '−' : ''}₹${grouped}${p ? `.${String(p).padStart(2, '0')}` : ''}`;
}

/** `rateUnits` under the name of module 11 BR-11-2: `rate4('21.0000') = 210000n`. */
export const rate4 = rateUnits;

/**
 * `units.areaSqft` (a `DECIMAL(10,3)` string such as `'1150.500'`) as integer milli-sq-ft (`1150500n`), parsed digit by digit.
 * More than 3 decimals are refused. Module 11 BR-11-2.
 */
export function areaMilli(areaSqft: string | number): bigint {
  const s = typeof areaSqft === 'number' ? String(areaSqft) : areaSqft.trim();
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid area: ${areaSqft}`);
  return BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
}

/** `roundHalfUp` that keeps the result a `bigint` (for intermediate sums that may exceed 2^53). */
export function roundHalfUpBig(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('divisor must be positive');
  const abs = n < 0n ? -n : n;
  const q = (2n * abs + d) / (2n * d);
  return n < 0n ? -q : q;
}

/** `"1234.5"`, `"1234"` or `"1234.56"` rupees (at most 2 decimals) as integer paise; never goes through a float (BR-11-65). */
export function rupeesToPaise(rupees: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(rupees.trim());
  if (!m) throw new RangeError(`invalid rupee amount: ${rupees}`);
  return toSafeNumber(BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0')));
}

/** Share of `totalPaise` for a weight out of the total weight, floored: `floor(T × w / W)` (BR-11-22). */
export function floorShare(totalPaise: number | bigint, weight: bigint, totalWeight: bigint): bigint {
  if (totalWeight <= 0n) throw new RangeError('total weight must be positive');
  return (toBig(totalPaise) * weight) / totalWeight;
}
