/**
 * Module 06 pure calculator (section 16 step 3): period value, invoice lines (BR-06-3 to BR-06-9), place of supply and
 * GST (BR-06-13 to BR-06-15), credit note tax (BR-06-20), amount due and status (BR-06-21, BR-06-22). No database, no
 * clock: dates are `YYYY-MM-DD` strings, money is integer paise, rounding goes through `lib/money.ts`.
 */
import { formatRupees, percentOf, roundHalfUp } from '../../lib/money';
import type { InvoiceStatus, TaxType } from '../../models/platform-invoice.model';
import type { LineType } from '../../models/platform-invoice-line.model';
import { gstStateCode } from './platform-billing.constants';

// ------------------------------------------------------------------ dates
const utc = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
};
/** `b − a + 1` calendar days (both inclusive). */
export const daysInclusive = (a: string, b: string): number => Math.round((utc(b) - utc(a)) / 86_400_000) + 1;
export const addDaysYmd = (s: string, days: number): string =>
  new Date(utc(s) + days * 86_400_000).toISOString().slice(0, 10);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parts = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return { y: y!, m: m!, d: d! };
};
/** `1 Nov 2026`. */
export const fmtDate = (s: string): string => {
  const p = parts(s);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
};
/** `1–30 Nov 2026`, or `1 Oct 2026 – 30 Sep 2027` across months. */
export const fmtRange = (a: string, b: string): string => {
  const x = parts(a);
  const y = parts(b);
  if (x.y === y.y && x.m === y.m) return `${x.d}–${y.d} ${MONTHS[y.m - 1]} ${y.y}`;
  return `${fmtDate(a)} – ${fmtDate(b)}`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ period value (BR-04-5, 9.3)
/** flats × price × (months − freeMonths); freeMonths = annualFreeMonths for ANNUAL, 0 for MONTHLY. */
export const periodValue = (
  flats: number,
  pricePerFlatPerMonthPaise: number,
  months: number,
  freeMonths: number,
): number => flats * pricePerFlatPerMonthPaise * (months - freeMonths);

// ------------------------------------------------------------------ place of supply and tax
export interface PlaceOfSupply {
  stateCode: string;
  taxType: TaxType;
}

/**
 * BR-06-14: the first two digits of the buyer GSTIN when it has one, else the GST code of the address state;
 * INTRA_STATE when that equals the platform's state. An unknown state without GSTIN is treated as the platform's state.
 */
export function placeOfSupply(
  buyer: { gstin?: string | null; state?: string | null },
  companyStateCode: string,
): PlaceOfSupply {
  const stateCode = buyer.gstin ? buyer.gstin.slice(0, 2) : (gstStateCode(buyer.state) ?? companyStateCode);
  return { stateCode, taxType: stateCode === companyStateCode ? 'INTRA_STATE' : 'INTER_STATE' };
}

export interface TaxAmounts {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
}
export interface DocumentAmounts extends TaxAmounts {
  subtotalPaise: number;
  totalPaise: number;
}

/** BR-06-15: tax once per document on the subtotal. */
export function computeTax(subtotalPaise: number, taxType: TaxType, gstRatePct: string): DocumentAmounts {
  const cgst = taxType === 'INTRA_STATE' ? percentOf(subtotalPaise, gstRatePct, 2) : 0;
  const igst = taxType === 'INTER_STATE' ? percentOf(subtotalPaise, gstRatePct) : 0;
  const tax = 2 * cgst + igst;
  return {
    subtotalPaise,
    cgstPaise: cgst,
    sgstPaise: cgst,
    igstPaise: igst,
    taxPaise: tax,
    totalPaise: subtotalPaise + tax,
  };
}

/**
 * BR-06-20: tax of a credit note. When `creditedSubtotalPaise` (issued and draft credit notes other than this one)
 * plus this subtotal equals the invoice subtotal, the tax is the invoice tax minus the tax already credited, so a full
 * credit is exact to the paisa; otherwise BR-06-15.
 */
export function creditNoteAmounts(input: {
  invoice: DocumentAmounts & { taxType: TaxType; gstRatePct: string };
  creditedSubtotalPaise: number;
  creditedTax: Pick<TaxAmounts, 'cgstPaise' | 'sgstPaise' | 'igstPaise'>;
  subtotalPaise: number;
}): DocumentAmounts {
  const { invoice, subtotalPaise } = input;
  if (input.creditedSubtotalPaise + subtotalPaise !== invoice.subtotalPaise)
    return computeTax(subtotalPaise, invoice.taxType, invoice.gstRatePct);
  const cgst = invoice.cgstPaise - input.creditedTax.cgstPaise;
  const sgst = invoice.sgstPaise - input.creditedTax.sgstPaise;
  const igst = invoice.igstPaise - input.creditedTax.igstPaise;
  const tax = cgst + sgst + igst;
  return {
    subtotalPaise,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    taxPaise: tax,
    totalPaise: subtotalPaise + tax,
  };
}

/** BR-06-20: last day a credit note may be issued for an invoice of `financialYear` (`2026-27` → `2027-11-30`). */
export const creditNoteDeadline = (financialYear: string): string =>
  `${Number(financialYear.slice(0, 4)) + 1}-11-30`;

// ------------------------------------------------------------------ lines
export interface LineDraft {
  lineType: LineType;
  description: string;
  quantity: number;
  unitPricePaise: number;
  amountPaise: number;
  planVersionId?: number | null;
  addonKey?: string | null;
  limitKey?: string | null;
  servicePeriodStart?: string | null;
  servicePeriodEnd?: string | null;
  prorationDays?: number | null;
  periodDays?: number | null;
}

/** BR-06-11 order of line types. */
export const LINE_ORDER: readonly LineType[] = [
  'PLAN',
  'DISCOUNT',
  'ADDON',
  'FLAT_TRUE_UP',
  'OVERAGE',
  'PRORATION',
  'ONE_TIME',
  'MANUAL',
  'CREDIT_NOTE',
];

/** Lines in BR-06-11 order (stable within a type); zero-amount lines are dropped (the table refuses them). */
export const orderLines = (lines: LineDraft[]): LineDraft[] =>
  lines
    .filter(l => l.amountPaise !== 0)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => LINE_ORDER.indexOf(a.l.lineType) - LINE_ORDER.indexOf(b.l.lineType) || a.i - b.i)
    .map(x => x.l);

export const subtotalOf = (lines: LineDraft[]): number => lines.reduce((s, l) => s + l.amountPaise, 0);

/** Module 04 `getBillingSnapshot` (module 06 section 9.3). */
export interface BillingSnapshot {
  societyId: number;
  planKey: string;
  planName: string;
  planVersionId: number;
  billingCycle: 'MONTHLY' | 'ANNUAL';
  periodStart: string;
  periodEnd: string;
  pricePerFlatPerMonthPaise: number;
  annualFreeMonths: number;
  billableFlats: number;
  addons: { addonKey: string; name: string; quantity: number; monthlyPricePaise: number }[];
  previousPeriod: null | {
    periodStart: string;
    periodEnd: string;
    months: number;
    freeMonths: number;
    pricePerFlatPerMonthPaise: number;
    flatSegments: { fromDate: string; toDate: string; billableFlats: number }[];
    overages: { limitKey: string; label: string; quantity: number; unitPricePaise: number }[];
  };
}

export interface TrueUp {
  flatDays: number;
  daysWithIncrease: number;
  prevPeriodDays: number;
  periodValuePerFlat: number;
  amountPaise: number;
}

/** BR-06-6: flat-days above the billed count in the previous period, valued at the previous period's rate. */
export function flatTrueUp(prev: NonNullable<BillingSnapshot['previousPeriod']>, billed: number): TrueUp {
  const prevPeriodDays = daysInclusive(prev.periodStart, prev.periodEnd);
  let flatDays = 0;
  let daysWithIncrease = 0;
  for (const s of prev.flatSegments) {
    const extra = Math.max(0, s.billableFlats - billed);
    const days = Math.max(0, daysInclusive(s.fromDate, s.toDate));
    flatDays += extra * days;
    if (extra > 0) daysWithIncrease += days;
  }
  const periodValuePerFlat = prev.pricePerFlatPerMonthPaise * (prev.months - prev.freeMonths);
  return {
    flatDays,
    daysWithIncrease,
    prevPeriodDays,
    periodValuePerFlat,
    amountPaise:
      flatDays === 0 ? 0 : roundHalfUp(BigInt(flatDays) * BigInt(periodValuePerFlat), prevPeriodDays),
  };
}

const monthsOf = (cycle: 'MONTHLY' | 'ANNUAL'): number => (cycle === 'ANNUAL' ? 12 : 1);

/**
 * BR-06-3 to BR-06-7: PLAN, DISCOUNT (annual free months), ADDON, FLAT_TRUE_UP and OVERAGE lines of a PERIOD invoice.
 * `previousBilledFlats` is the PLAN quantity of the previous PERIOD invoice (null when there is none: no true-up).
 */
export function buildPeriodLines(snap: BillingSnapshot, previousBilledFlats: number | null): LineDraft[] {
  const months = monthsOf(snap.billingCycle);
  const price = snap.pricePerFlatPerMonthPaise;
  const flats = snap.billableFlats;
  const range = fmtRange(snap.periodStart, snap.periodEnd);
  const service = { servicePeriodStart: snap.periodStart, servicePeriodEnd: snap.periodEnd };
  const lines: LineDraft[] = [
    {
      lineType: 'PLAN',
      description: `${snap.planName} plan, ${flats} flats × ${formatRupees(price)} × ${plural(months, 'month')} (${range})`,
      quantity: flats,
      unitPricePaise: price * months,
      amountPaise: flats * price * months,
      planVersionId: snap.planVersionId,
      ...service,
    },
  ];
  const free = snap.billingCycle === 'ANNUAL' ? snap.annualFreeMonths : 0;
  if (free > 0)
    lines.push({
      lineType: 'DISCOUNT',
      description: `Annual billing: ${plural(free, 'month')} free`,
      quantity: flats,
      unitPricePaise: price * free,
      amountPaise: -(flats * price * free),
      planVersionId: snap.planVersionId,
      ...service,
    });
  for (const a of snap.addons)
    lines.push({
      lineType: 'ADDON',
      description: `${a.name} × ${a.quantity} × ${plural(months, 'month')}`,
      quantity: a.quantity,
      unitPricePaise: a.monthlyPricePaise * months,
      amountPaise: a.quantity * a.monthlyPricePaise * months,
      addonKey: a.addonKey,
      ...service,
    });
  const prev = snap.previousPeriod;
  if (prev && previousBilledFlats !== null) {
    const tu = flatTrueUp(prev, previousBilledFlats);
    if (tu.flatDays > 0)
      lines.push({
        lineType: 'FLAT_TRUE_UP',
        description: `Flats added in the previous period, ${tu.flatDays} flat-days of ${tu.prevPeriodDays} (${fmtRange(prev.periodStart, prev.periodEnd)})`,
        quantity: tu.flatDays,
        unitPricePaise: tu.periodValuePerFlat,
        amountPaise: tu.amountPaise,
        planVersionId: snap.planVersionId,
        servicePeriodStart: prev.periodStart,
        servicePeriodEnd: prev.periodEnd,
        prorationDays: tu.daysWithIncrease,
        periodDays: tu.prevPeriodDays,
      });
  }
  // BR-06-7: overage only on MONTHLY period invoices; annual overage is billed by issueOneTimeInvoice
  if (prev && snap.billingCycle === 'MONTHLY' && prev.months === 1)
    for (const o of prev.overages)
      lines.push({
        lineType: 'OVERAGE',
        description: `${o.label}: ${o.quantity} × ${formatRupees(o.unitPricePaise)} (${fmtRange(prev.periodStart, prev.periodEnd)})`,
        quantity: o.quantity,
        unitPricePaise: o.unitPricePaise,
        amountPaise: o.quantity * o.unitPricePaise,
        limitKey: o.limitKey,
        servicePeriodStart: prev.periodStart,
        servicePeriodEnd: prev.periodEnd,
      });
  return orderLines(lines);
}

export interface ProrationItemInput {
  label?: string;
  planVersionId?: number | null;
  addonKey?: string | null;
  fromPeriodValuePaise: number;
  toPeriodValuePaise: number;
}

/** BR-06-8: per item a credit for the old value and a charge for the new one, for the days remaining. */
export function buildProrationLines(input: {
  items: ProrationItemInput[];
  effectiveDate: string;
  periodStart: string;
  periodEnd: string;
}): LineDraft[] {
  const periodDays = daysInclusive(input.periodStart, input.periodEnd);
  const daysRemaining = daysInclusive(input.effectiveDate, input.periodEnd);
  const lines: LineDraft[] = [];
  const common = (i: ProrationItemInput) => ({
    lineType: 'PRORATION' as const,
    quantity: 1,
    planVersionId: i.planVersionId ?? null,
    addonKey: i.addonKey ?? null,
    servicePeriodStart: input.effectiveDate,
    servicePeriodEnd: input.periodEnd,
    prorationDays: daysRemaining,
    periodDays,
  });
  const label = (i: ProrationItemInput) => i.label ?? i.addonKey ?? 'Plan change';
  for (const i of input.items) {
    const credit = roundHalfUp(BigInt(i.fromPeriodValuePaise) * BigInt(daysRemaining), periodDays);
    const charge = roundHalfUp(BigInt(i.toPeriodValuePaise) * BigInt(daysRemaining), periodDays);
    if (credit)
      lines.push({
        ...common(i),
        description: `${label(i)}: credit for unused ${daysRemaining} of ${periodDays} days (${fmtRange(input.effectiveDate, input.periodEnd)})`,
        unitPricePaise: i.fromPeriodValuePaise,
        amountPaise: -credit,
      });
    if (charge)
      lines.push({
        ...common(i),
        description: `${label(i)}: charge for ${daysRemaining} of ${periodDays} days (${fmtRange(input.effectiveDate, input.periodEnd)})`,
        unitPricePaise: i.toPeriodValuePaise,
        amountPaise: charge,
      });
  }
  return orderLines(lines);
}

/** BR-06-9: the single line of a ONE_TIME invoice (add-on pack or annual overage). */
export function buildOneTimeLine(input: {
  lineType: 'ONE_TIME' | 'OVERAGE';
  label: string;
  quantity: number;
  unitPricePaise: number;
  addonKey?: string | null;
  limitKey?: string | null;
}): LineDraft[] {
  return orderLines([
    {
      lineType: input.lineType,
      description: `${input.label} × ${input.quantity}`,
      quantity: input.quantity,
      unitPricePaise: input.unitPricePaise,
      amountPaise: input.quantity * input.unitPricePaise,
      addonKey: input.lineType === 'ONE_TIME' ? (input.addonKey ?? null) : null,
      limitKey: input.lineType === 'OVERAGE' ? (input.limitKey ?? null) : null,
    },
  ]);
}

/** Section 8.12: manual line amount = roundHalfUp(quantity × 10000 × unitPricePaise, 10000); quantity has ≤ 4 decimals. */
export function manualLineAmount(quantity: string, unitPricePaise: number): number {
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(quantity.trim());
  if (!m) throw new RangeError(`invalid quantity: ${quantity}`);
  const q = BigInt(m[1]!) * 10_000n + BigInt((m[2] ?? '').padEnd(4, '0'));
  return roundHalfUp(q * BigInt(unitPricePaise), 10_000);
}

// ------------------------------------------------------------------ settlement
export interface SettlementFields {
  totalPaise: number;
  creditAppliedPaise: number;
  paidPaise: number;
  tdsPaise: number;
  creditNotedPaise: number;
  writtenOffPaise: number;
  excessToCreditPaise: number;
}

/** BR-06-21. */
export const amountDueOf = (i: SettlementFields): number =>
  i.totalPaise -
  i.creditNotedPaise -
  i.writtenOffPaise -
  i.creditAppliedPaise -
  i.paidPaise -
  i.tdsPaise +
  i.excessToCreditPaise;

/** BR-06-22, in rule order. `amountDuePaise` is recomputed from the components. */
export function deriveInvoiceStatus(
  inv: SettlementFields & { dueDate: string | null },
  todayIst: string,
): InvoiceStatus {
  if (inv.totalPaise > 0 && inv.creditNotedPaise === inv.totalPaise) return 'VOID';
  if (inv.writtenOffPaise > 0) return 'WRITTEN_OFF';
  if (amountDueOf(inv) === 0) return 'PAID';
  if (inv.dueDate && inv.dueDate < todayIst) return 'OVERDUE';
  if (inv.creditAppliedPaise + inv.paidPaise + inv.tdsPaise - inv.excessToCreditPaise > 0)
    return 'PARTIALLY_PAID';
  return 'ISSUED';
}

/** Open = can still take money (BR-06-26). */
export const OPEN_STATUSES: readonly InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'];
