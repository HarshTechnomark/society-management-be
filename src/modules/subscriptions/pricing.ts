/**
 * Pure pricing and calendar functions (module 04 BR-04-5 to BR-04-7, BR-04-20). Dates are society-local `YYYY-MM-DD`
 * strings; money is integer paise. Nothing here touches the database or the clock.
 */
import type { BillingCycle } from './subscriptions.types';

const pad = (n: number): string => String(n).padStart(2, '0');
export const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
export const parseYmd = (s: string): { y: number; m: number; d: number } => {
  const [y, m, d] = s.split('-').map(Number);
  return { y: y!, m: m!, d: d! };
};
export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const utc = (s: string): number => {
  const p = parseYmd(s);
  return Date.UTC(p.y, p.m - 1, p.d);
};
export const addDaysYmd = (s: string, days: number): string => {
  const t = new Date(utc(s) + days * 86_400_000);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
/** Whole days from `a` to `b` (b - a). */
export const diffDays = (a: string, b: string): number => Math.round((utc(b) - utc(a)) / 86_400_000);

/** Society-local calendar date of an instant. */
export function localDate(at: Date, timezone = 'Asia/Kolkata'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return parts; // en-CA is YYYY-MM-DD
}

/** First day of the period that starts `months` after `start`, on `min(anchorDay, days in that month)` (BR-04-6). */
export function addMonthsAnchored(start: string, anchorDay: number, months: number): string {
  const p = parseYmd(start);
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return ymd(y, m, Math.min(anchorDay, daysInMonth(y, m)));
}

export const monthsOf = (cycle: BillingCycle): number => (cycle === 'ANNUAL' ? 12 : 1);

export interface Period {
  periodStart: string;
  periodEnd: string;
  periodDays: number;
}
/** The period starting on `start`: end is the next start minus one day. */
export function periodFrom(start: string, anchorDay: number, months: number): Period {
  const next = addMonthsAnchored(start, anchorDay, months);
  const periodEnd = addDaysYmd(next, -1);
  return { periodStart: start, periodEnd, periodDays: diffDays(start, periodEnd) + 1 };
}
export const nextPeriodStart = (periodEnd: string): string => addDaysYmd(periodEnd, 1);

/** `max(billableFlats, minBillableFlats)`; `customMinFlats` replaces the version minimum when set (Enterprise). */
export const chargedFlats = (billable: number, minBillable: number, customMin?: number | null): number =>
  Math.max(billable, customMin ?? minBillable);

/** module 06's `periodValue` (BR-04-5), exact paise. */
export const periodValue = (
  flats: number,
  pricePerFlatPerMonthPaise: number,
  months: number,
  freeMonths: number,
): number => flats * pricePerFlatPerMonthPaise * (months - freeMonths);

export const freeMonthsFor = (cycle: BillingCycle, annualFreeMonths: number): number =>
  cycle === 'ANNUAL' ? annualFreeMonths : 0;

/** `roundHalfUp(a / b)` for non-negative integers (BR-04-7). */
export const roundHalfUpDiv = (a: number, b: number): number => Math.floor((2 * a + b) / (2 * b));

export interface Proration {
  effectiveDate: string;
  periodEnd: string;
  daysRemaining: number;
  periodDays: number;
  creditPaise: number;
  chargePaise: number;
  netPaise: number;
}
/** Day-based proration of a plan change inside a period (BR-04-7, BR-04-8). Values are full-period values. */
export function proration(
  effectiveDate: string,
  periodStart: string,
  periodEnd: string,
  fromValuePaise: number,
  toValuePaise: number,
): Proration {
  const periodDays = diffDays(periodStart, periodEnd) + 1;
  const daysRemaining = Math.max(0, diffDays(effectiveDate, periodEnd) + 1);
  const creditPaise = roundHalfUpDiv(fromValuePaise * daysRemaining, periodDays);
  const chargePaise = roundHalfUpDiv(toValuePaise * daysRemaining, periodDays);
  return {
    effectiveDate,
    periodEnd,
    daysRemaining,
    periodDays,
    creditPaise,
    chargePaise,
    netPaise: chargePaise - creditPaise,
  };
}

/** Month-long usage window containing `date`, lined up with the billing anchor (BR-04-20). */
export function usageMonth(date: string, anchorDay: number): Period {
  const p = parseYmd(date);
  const inMonth = ymd(p.y, p.m, Math.min(anchorDay, daysInMonth(p.y, p.m)));
  const start = date >= inMonth ? inMonth : addMonthsAnchored(inMonth, anchorDay, -1);
  return periodFrom(start, anchorDay, 1);
}

/** Effective plan value of a limit with the per-flats formula (section 2.5): `max(base, ceil(flats / perFlats))`. */
export function planLimitValue(
  base: number | null,
  perFlats: number | null | undefined,
  flats: number,
): number | null {
  if (base === null) return null;
  return perFlats ? Math.max(base, Math.ceil(flats / perFlats)) : base;
}
