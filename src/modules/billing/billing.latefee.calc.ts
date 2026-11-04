import { rate4, roundHalfUpBig } from '../../lib/money';
import { addDaysYmd, diffDays, maxYmd, minYmd } from './billing.calc.period';
import type { InterestFrom, InvoiceStatus, InvoiceType, LateFeePolicyType } from './billing.constants';

/**
 * Pure late-fee arithmetic (BR-11-52 to BR-11-55); no database, no clock. Money is integer paise, the rate has 4 implied
 * decimals, the year is always 365 days and one rounding is done per invoice per window.
 */

/** One dated change of an invoice's balances (BR-11-53). Payments carry `dPaid` and a negative `dOutstanding`. */
export interface BalanceEvent {
  /** `YYYY-MM-DD`: the balances after this event apply from this day on. */
  date: string;
  dOutstanding: number;
  dNonInterestBearing: number;
  dPaid: number;
}

/** Interest-bearing principal on one day: `max(0, O - max(0, N - P))` (BR-11-53). */
export const principalOf = (o: number, n: number, p: number): number => Math.max(0, o - Math.max(0, n - p));

/**
 * `roundHalfUp(sum over days d in from..to of principal_d x rate4, 10,000 x 100 x 365)` (BR-11-54). The balances are those after
 * all events dated on or before the day, so a payment allocated on day `d` stops interest for day `d`.
 */
export function simpleInterestPaise(
  events: readonly BalanceEvent[],
  from: string,
  to: string,
  ratePct: string,
): number {
  if (from > to) return 0;
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let o = 0;
  let n = 0;
  let p = 0;
  let i = 0;
  const apply = (day: string) => {
    while (i < sorted.length && sorted[i]!.date <= day) {
      o += sorted[i]!.dOutstanding;
      n += sorted[i]!.dNonInterestBearing;
      p += sorted[i]!.dPaid;
      i += 1;
    }
  };
  apply(from);
  let day = from;
  let sum = 0n;
  while (day <= to) {
    const next = i < sorted.length ? sorted[i]!.date : null;
    const segEnd = next && next <= to ? addDaysYmd(next, -1) : to;
    const days = diffDays(day, segEnd) + 1;
    if (days > 0) sum += BigInt(principalOf(o, n, p)) * BigInt(days);
    day = addDaysYmd(segEnd, 1);
    apply(day);
  }
  return Number(roundHalfUpBig(sum * rate4(ratePct), 10_000n * 100n * 365n));
}

export interface InterestPolicy {
  policyType: LateFeePolicyType;
  interestRatePct: string | null;
  interestFrom: InterestFrom | null;
  flatFeePaise: number | null;
  graceDays: number;
  minChargePaise: number;
}

export interface LateFeeInvoice {
  invoiceType: InvoiceType;
  status: InvoiceStatus;
  isDisputed: boolean;
  invoiceDate: string;
  dueDate: string;
  settledOn: string | null;
  interestPostedToDate: string | null;
  lateFeeChargedAt: string | null;
  /** True when at least one `CHARGE` line belongs to an interest-bearing head (BR-11-52 flat fee). */
  hasInterestBearingCharge: boolean;
}

export type SkipReason =
  | 'POLICY_NONE'
  | 'CANCELLED'
  | 'DISPUTED'
  | 'WITHIN_GRACE'
  | 'IN_GRACE'
  | 'NOTHING_TO_CHARGE'
  | 'BELOW_MINIMUM'
  | 'ALREADY_CHARGED'
  | 'NO_INTEREST_BEARING_LINE'
  | 'OPENING_NO_FLAT_FEE';

/** Last day of the grace period: an invoice settled on or before it never attracts interest or a fee (BR-11-52). */
export const graceEndOf = (dueDate: string, graceDays: number): string => addDaysYmd(dueDate, graceDays);

/** First day interest accrues (BR-11-52): `OPENING` from `asOfDate + 1`, else the due date + 1 or the end of grace + 1. */
export function accrualStartOf(
  inv: Pick<LateFeeInvoice, 'invoiceType' | 'invoiceDate' | 'dueDate'>,
  p: InterestPolicy,
): string {
  if (inv.invoiceType === 'OPENING') return addDaysYmd(inv.invoiceDate, 1);
  return p.interestFrom === 'GRACE_END'
    ? addDaysYmd(graceEndOf(inv.dueDate, p.graceDays), 1)
    : addDaysYmd(inv.dueDate, 1);
}

export type InterestPlan =
  { skip: SkipReason } | { skip: null; from: string; to: string; interestPaise: number };

/**
 * BR-11-55 for `SIMPLE_INTEREST`: the window is `max(accrual start, interestPostedToDate + 1)` to `windowEnd` (the last day of
 * the previous month), not after `settledOn - 1`. Interest below `minChargePaise` posts nothing and does not advance the window.
 * Not charged while the grace period of an open invoice is still running (`today`).
 */
export function planInterest(
  inv: LateFeeInvoice,
  p: InterestPolicy,
  events: readonly BalanceEvent[],
  windowEnd: string,
  today: string,
): InterestPlan {
  if (p.policyType !== 'SIMPLE_INTEREST' || !p.interestRatePct) return { skip: 'POLICY_NONE' };
  if (inv.status === 'CANCELLED') return { skip: 'CANCELLED' };
  if (inv.isDisputed) return { skip: 'DISPUTED' };
  const graceEnd = graceEndOf(inv.dueDate, p.graceDays);
  if (inv.settledOn && inv.settledOn <= graceEnd) return { skip: 'WITHIN_GRACE' };
  if (!inv.settledOn && today <= graceEnd) return { skip: 'IN_GRACE' };
  const start = accrualStartOf(inv, p);
  const from = inv.interestPostedToDate ? maxYmd(start, addDaysYmd(inv.interestPostedToDate, 1)) : start;
  let to = windowEnd;
  if (inv.settledOn) to = minYmd(to, addDaysYmd(inv.settledOn, -1));
  if (from > to) return { skip: 'NOTHING_TO_CHARGE' };
  const interestPaise = simpleInterestPaise(events, from, to, p.interestRatePct);
  if (interestPaise <= 0 || interestPaise < p.minChargePaise) return { skip: 'BELOW_MINIMUM' };
  return { skip: null, from, to, interestPaise };
}

export type FlatFeePlan = { skip: SkipReason } | { skip: null; feePaise: number };

/**
 * BR-11-55 for `FLAT`: an invoice not settled by `dueDate + graceDays` and not yet charged gets one fee, only when it has an
 * interest-bearing `CHARGE` line (so `COLLECTION` and `FESTIVAL` invoices never do) and is not an `OPENING` invoice.
 */
export function planFlatFee(inv: LateFeeInvoice, p: InterestPolicy, today: string): FlatFeePlan {
  if (p.policyType !== 'FLAT' || !p.flatFeePaise) return { skip: 'POLICY_NONE' };
  if (inv.status === 'CANCELLED') return { skip: 'CANCELLED' };
  if (inv.isDisputed) return { skip: 'DISPUTED' };
  if (inv.invoiceType === 'OPENING') return { skip: 'OPENING_NO_FLAT_FEE' };
  if (inv.lateFeeChargedAt) return { skip: 'ALREADY_CHARGED' };
  if (!inv.hasInterestBearingCharge) return { skip: 'NO_INTEREST_BEARING_LINE' };
  const graceEnd = graceEndOf(inv.dueDate, p.graceDays);
  if (inv.settledOn && inv.settledOn <= graceEnd) return { skip: 'WITHIN_GRACE' };
  if (!inv.settledOn && today <= graceEnd) return { skip: 'IN_GRACE' };
  return { skip: null, feePaise: p.flatFeePaise };
}

/** `INT:<invoiceId>:<windowEnd>` and `LFEE:<invoiceId>` (7.9). */
export const interestDedupeKey = (invoiceId: number, windowEnd: string): string =>
  `INT:${invoiceId}:${windowEnd}`;
export const lateFeeDedupeKey = (invoiceId: number): string => `LFEE:${invoiceId}`;

/** Last day of the month before the month of `today`. */
export const previousMonthEnd = (today: string): string => addDaysYmd(`${today.slice(0, 7)}-01`, -1);
