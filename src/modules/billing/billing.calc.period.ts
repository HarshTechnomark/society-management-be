import { CYCLE_MONTHS, type BillingCycle } from './billing.constants';

/**
 * Dates and billing periods (BR-11-16, BR-11-24). Pure functions on `YYYY-MM-DD` strings: no clock, no time zone. Periods are
 * aligned to the financial year: monthly = calendar months, quarterly from 1 Apr / 1 Jul / 1 Oct / 1 Jan, half-yearly from
 * 1 Apr and 1 Oct, annual from 1 Apr. `periodEnd` is the day before the next period starts.
 */
const MS_DAY = 86_400_000;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toUtc = (ymd: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new RangeError(`not a date: ${ymd}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDaysYmd = (ymd: string, n: number): string => fromUtc(toUtc(ymd) + n * MS_DAY);
/** Days from `a` to `b` (b - a). */
export const diffDays = (a: string, b: string): number => Math.round((toUtc(b) - toUtc(a)) / MS_DAY);
/** Days in `from..to`, both ends counted (12 to 30 November = 19). */
export const daysInclusive = (from: string, to: string): number => diffDays(from, to) + 1;
export const maxYmd = (a: string, b: string): string => (a >= b ? a : b);
export const minYmd = (a: string, b: string): string => (a <= b ? a : b);

/** First day of the month `n` months after the month of `ymd` (n may be negative). */
export function addMonthsFirst(ymd: string, n: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7)) - 1 + n;
  return fromUtc(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
}

export const monthsOf = (cycle: BillingCycle): number => CYCLE_MONTHS[cycle];

/** Start month numbers (1 to 12) of the periods of a cycle. */
const STARTS: Record<BillingCycle, number[]> = {
  MONTHLY: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  QUARTERLY: [1, 4, 7, 10],
  HALF_YEARLY: [4, 10],
  ANNUAL: [4],
};

/** BR-11-24: `periodStart` is the first day of a period of the cycle. */
export function isPeriodStart(cycle: BillingCycle, periodStart: string): boolean {
  return periodStart.endsWith('-01') && STARTS[cycle].includes(Number(periodStart.slice(5, 7)));
}

export const nextPeriodStart = (cycle: BillingCycle, periodStart: string): string =>
  addMonthsFirst(periodStart, monthsOf(cycle));
export const periodEndOf = (cycle: BillingCycle, periodStart: string): string =>
  addDaysYmd(nextPeriodStart(cycle, periodStart), -1);
export const periodDaysOf = (cycle: BillingCycle, periodStart: string): number =>
  daysInclusive(periodStart, periodEndOf(cycle, periodStart));

/** The start of the period of the cycle that contains `ymd`. */
export function periodStartContaining(cycle: BillingCycle, ymd: string): string {
  const month = Number(ymd.slice(5, 7));
  const starts = STARTS[cycle];
  const startMonth = [...starts].reverse().find(s => s <= month) ?? starts[starts.length - 1]!;
  const year = Number(ymd.slice(0, 4)) - (startMonth <= month ? 0 : 1);
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}

/** BR-11-24: the bill date is the `billingDay`-th day of the period's first month. */
export const billDateOf = (periodStart: string, billingDay: number): string =>
  `${periodStart.slice(0, 8)}${String(billingDay).padStart(2, '0')}`;

/** `BR-2026-11` (BR-11 run label of the month of `periodStart`); supplementary runs add `-S<n>`. */
export const runLabelOf = (periodStart: string, supplementaryNo?: number): string =>
  `BR-${periodStart.slice(0, 7)}${supplementaryNo ? `-S${supplementaryNo}` : ''}`;

/** `Nov 2026`, or `Oct to Dec 2026` for a longer period (descriptions and run titles). */
export function periodLabelOf(cycle: BillingCycle, periodStart: string): string {
  const y = periodStart.slice(0, 4);
  const mi = Number(periodStart.slice(5, 7)) - 1;
  if (cycle === 'MONTHLY') return `${MONTH_SHORT[mi]} ${y}`;
  const end = periodEndOf(cycle, periodStart);
  const ei = Number(end.slice(5, 7)) - 1;
  const ey = end.slice(0, 4);
  return `${MONTH_SHORT[mi]}${y === ey ? '' : ` ${y}`} to ${MONTH_SHORT[ei]} ${ey}`;
}
