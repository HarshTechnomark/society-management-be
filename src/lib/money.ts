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
