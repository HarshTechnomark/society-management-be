import { formatRupees, rate4, roundHalfUpBig } from '../../lib/money';
import type { ExceptionCode, GstTreatment, HeadType, PayerRouting, WarningCode } from './billing.constants';
import { gstApplies, gstOf, roundOffOf } from './billing.calc.gst';
import { periodLabelOf } from './billing.calc.period';
import { rateOf, type MeterReading, type RateUnit } from './billing.calc.rates';
import { winningRule, type RuleCandidate, type ScopeUnit } from './billing.calc.rules';
import type { Party, Segment } from './billing.calc.segments';
import type { BillingCycle } from './billing.constants';

/**
 * The calculator for one flat and one period (section 6.3 steps 3 and 4, BR-11-14 to BR-11-30). Pure: the compute engine loads
 * the data and calls this once per flat. It never reads the database, the clock or a port.
 *
 * Every line is rounded once, at the end of its own formula (BR-11-3); the round-off line makes each document a whole rupee.
 * Parties: `OWNER` heads go to the owner of each segment, `BILL_TO` heads to the segment's bill-to party (BR-11-27); the days a
 * party holds a head are summed over its segments, so a party is rounded once per head even when a tenancy cut the month.
 */
export interface CalcHead {
  id: number;
  key: string;
  name: string;
  headType: HeadType;
  payerRouting: PayerRouting;
  gstTreatment: GstTreatment;
  sacCode: string | null;
  prorate: boolean;
  ledgerAccountCode: string;
  sortOrder: number;
}

export interface CalcSettings {
  cycle: BillingCycle;
  months: number;
  periodStart: string;
  periodEnd: string;
  periodDays: number;
  applyGst: boolean;
  gstExemptLimitPaise: number;
  roundToRupee: boolean;
  /** Feature `billing.prorated_billing`: off bills the full period to the party liable on the first day. */
  prorated: boolean;
  /** Feature `billing.owner_and_tenant_bill_split`: off routes every `BILL_TO` head to the owner. */
  ownerTenantSplit: boolean;
  /** `billing.areaBasis` (module 08): copied into every line's explanation. */
  areaBasis: string;
}

export interface CalcUnit extends RateUnit, ScopeUnit {
  label: string;
}

export interface CalcLine {
  lineKind: 'CHARGE' | 'CGST' | 'SGST' | 'ROUND_OFF';
  chargeHeadId: number | null;
  headKey: string | null;
  description: string;
  quantity: string | null;
  ratePaise: number | null;
  amountPaise: number;
  isTaxable: boolean;
  billingRuleVersionId: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  prorationDays: number | null;
  periodDays: number | null;
  computation: Record<string, unknown> | null;
  ledgerAccountCode: string;
  /** SAC of the head, kept so that publish can refuse a taxed line without one (BR-11-32). */
  sacCode: string | null;
}

export interface CalcItem {
  party: Party;
  lines: CalcLine[];
  subtotalPaise: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  warnings: WarningCode[];
}

export type UnitCalc =
  | { status: 'SKIPPED' }
  | { status: 'EXCEPTION'; code: ExceptionCode; message: string }
  | { status: 'OK'; thresholdBasePaise: number; gstApplied: boolean; items: CalcItem[] };

export interface CalcInput {
  unit: CalcUnit;
  segments: Segment[];
  heads: CalcHead[];
  /** Rule candidates (rules with a version effective on `periodStart`), all heads. */
  candidates: RuleCandidate[];
  settings: CalcSettings;
  /** Share of the flat in a split rule's total, or the reason it has none. */
  splitFor?: (billSplitRuleId: number) => { share?: number; exception?: ExceptionCode } | undefined;
  meterFor?: (meterType: string) => MeterReading | undefined;
}

const LEDGER_CGST = '2310';
const LEDGER_SGST = '2320';
const LEDGER_ROUND_OFF = '4990';

interface PartyBucket {
  party: Party;
  lines: (CalcLine & { sort: number; headId: number })[];
  warnings: Set<WarningCode>;
}

const big = (n: number): bigint => BigInt(n);
const div = (n: bigint, d: bigint): number => Number(roundHalfUpBig(n, d));

export function calcUnit(input: CalcInput): UnitCalc {
  const { unit, segments, settings: s } = input;
  if (!segments.length) return { status: 'SKIPPED' };
  const label = periodLabelOf(s.cycle, s.periodStart);
  const periodDays = s.periodDays;

  const byHead = new Map<number, RuleCandidate[]>();
  for (const c of input.candidates) byHead.set(c.chargeHeadId, [...(byHead.get(c.chargeHeadId) ?? []), c]);

  const partyOf = (seg: Segment, head: CalcHead): Party =>
    head.payerRouting === 'OWNER' || head.headType === 'NON_OCCUPANCY' || !s.ownerTenantSplit
      ? seg.owner
      : seg.billTo;

  const buckets = new Map<number, PartyBucket>();
  const bucketOf = (party: Party): PartyBucket => {
    let b = buckets.get(party.residentId);
    if (!b) {
      b = { party, lines: [], warnings: new Set() };
      buckets.set(party.residentId, b);
    }
    return b;
  };
  const fullByHead = new Map<number, number>();
  const heads = [...input.heads].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const addLine = (
    party: Party,
    head: CalcHead,
    versionId: number,
    amount: number,
    d: {
      text: string;
      from: string;
      to: string;
      days: number | null;
      quantity: string | null;
      ratePaise: number | null;
      computation: Record<string, unknown>;
      warnings: WarningCode[];
    },
  ): void => {
    if (amount <= 0) return;
    const prorated = d.days !== null && d.days < periodDays;
    const b = bucketOf(party);
    for (const w of d.warnings) b.warnings.add(w);
    if (prorated) b.warnings.add('PRORATED');
    b.lines.push({
      lineKind: 'CHARGE',
      chargeHeadId: head.id,
      headKey: head.key,
      description:
        `${head.name}: ${d.text} (${label})${prorated ? `, ${d.days} of ${periodDays} days` : ''}`.slice(
          0,
          300,
        ),
      quantity: d.quantity,
      ratePaise: d.ratePaise,
      amountPaise: amount,
      isTaxable: false,
      billingRuleVersionId: versionId,
      periodFrom: d.from,
      periodTo: d.to,
      prorationDays: prorated ? d.days : null,
      periodDays: prorated ? periodDays : null,
      computation: { ...d.computation, ...(prorated ? { liableDays: d.days, periodDays } : {}) },
      ledgerAccountCode: head.ledgerAccountCode,
      sacCode: head.sacCode,
      sort: head.sortOrder,
      headId: head.id,
    });
  };

  /** Days of each party over the segments for which `applies` holds (BR-11-27, BR-11-19). */
  const daysByParty = (head: CalcHead, applies: (seg: Segment) => boolean) => {
    const m = new Map<number, { party: Party; days: number; from: string; to: string }>();
    for (const seg of segments) {
      if (!applies(seg)) continue;
      const party = partyOf(seg, head);
      const cur = m.get(party.residentId);
      if (cur) {
        cur.days += seg.days;
        if (seg.from < cur.from) cur.from = seg.from;
        if (seg.to > cur.to) cur.to = seg.to;
      } else m.set(party.residentId, { party, days: seg.days, from: seg.from, to: seg.to });
    }
    return [...m.values()];
  };

  const percentHeads: { head: CalcHead; cand: RuleCandidate }[] = [];

  for (const head of heads) {
    const cands = byHead.get(head.id);
    if (!cands) continue;
    const win = winningRule(cands, unit);
    if (!win) continue;
    const v = win.version;
    if (v.rateType === 'NONE') continue;
    if (v.rateType === 'PERCENT_OF_HEADS') {
      percentHeads.push({ head, cand: win });
      continue;
    }
    const split =
      v.rateType === 'SPLIT_TOTAL' && v.billSplitRuleId ? input.splitFor?.(v.billSplitRuleId) : undefined;
    const meter = v.rateType === 'METERED' && v.meterType ? input.meterFor?.(v.meterType) : undefined;
    const r = rateOf(v, {
      unit,
      months: s.months,
      splitShare: split?.share,
      splitException: split?.exception,
      meter,
    });
    if (r.kind === 'exception') return { status: 'EXCEPTION', code: r.code, message: r.message };
    if (r.kind === 'none') continue;
    const full = div(r.num, r.den);
    if (full <= 0) continue; // a zero rate is an exemption: no line
    fullByHead.set(head.id, full);
    const base = {
      quantity: r.quantity,
      ratePaise: r.ratePaise,
      computation: { ...r.computation, ruleVersionNo: v.versionNo, areaBasis: s.areaBasis },
      warnings: r.warnings,
      text: r.computation.text,
    };
    if (head.prorate && s.prorated && r.prorates) {
      for (const p of daysByParty(head, () => true)) {
        const amount = p.days === periodDays ? full : div(r.num * big(p.days), r.den * big(periodDays));
        addLine(p.party, head, v.id, amount, { ...base, from: p.from, to: p.to, days: p.days });
      }
    } else {
      const seg = segments[0]!;
      addLine(partyOf(seg, head), head, v.id, full, {
        ...base,
        from: s.periodStart,
        to: s.periodEnd,
        days: null,
      });
    }
  }

  // PERCENT_OF_HEADS after every other head (BR-11-17): base = full-period unprorated amounts of the base heads
  for (const { head, cand } of percentHeads) {
    const v = cand.version;
    const baseTotal = (v.baseChargeHeadIds ?? []).reduce((a, id) => a + (fullByHead.get(id) ?? 0), 0);
    if (baseTotal <= 0 || !v.percent) continue;
    const rate = rate4(v.percent);
    const applies = (seg: Segment) => (head.headType === 'NON_OCCUPANCY' ? seg.tenancyActive : true);
    let parts = daysByParty(head, applies);
    if (!parts.length) continue;
    const prorating = head.prorate && s.prorated;
    if (!prorating) {
      const first = parts[0]!;
      parts = [{ ...first, days: periodDays, from: s.periodStart, to: s.periodEnd }];
    }
    const fullAmount = div(big(baseTotal) * rate, 1_000_000n);
    fullByHead.set(head.id, fullAmount);
    const baseNames = (v.baseChargeHeadIds ?? [])
      .map(id => heads.find(h => h.id === id)?.name)
      .filter(Boolean)
      .join(', ');
    for (const p of parts) {
      const amount = div(
        big(baseTotal) * rate * big(Math.min(p.days, periodDays)),
        1_000_000n * big(periodDays),
      );
      addLine(p.party, head, v.id, amount, {
        text: `${v.percent}% of ${baseNames || 'base heads'} (${formatRupees(baseTotal)})`,
        from: p.from,
        to: p.to,
        days: p.days,
        quantity: null,
        ratePaise: null,
        warnings: [],
        computation: {
          method: 'PERCENT_OF_HEADS',
          formula: 'roundHalfUp(base × rate4(percent) × liableDays, 1000000 × periodDays)',
          inputs: { basePaise: baseTotal, percent: v.percent, liableDays: p.days, periodDays },
          text: `${v.percent}% of ${formatRupees(baseTotal)}`,
          ruleVersionNo: v.versionNo,
        },
      });
    }
  }

  // GST per flat across all parties (BR-11-30)
  let thresholdBase = 0;
  for (const head of heads)
    if (head.gstTreatment === 'THRESHOLD') thresholdBase += fullByHead.get(head.id) ?? 0;
  const gstApplied = gstApplies(s.applyGst, thresholdBase, s.gstExemptLimitPaise, s.months);
  const taxed = (h: CalcHead): boolean =>
    (h.gstTreatment === 'THRESHOLD' && gstApplied) || (h.gstTreatment === 'ALWAYS' && s.applyGst);

  const items: CalcItem[] = [];
  for (const b of buckets.values()) {
    const lines = [...b.lines]
      .sort((x, y) => x.sort - y.sort || x.headId - y.headId)
      .map(({ sort: _s, headId, ...l }) => ({ ...l, isTaxable: taxed(heads.find(h => h.id === headId)!) }));
    if (!lines.length) continue;
    const subtotal = lines.reduce((a, l) => a + l.amountPaise, 0);
    const taxable = lines.filter(l => l.isTaxable).reduce((a, l) => a + l.amountPaise, 0);
    const { cgstPaise, sgstPaise } = gstOf(taxable);
    const tax = cgstPaise + sgstPaise;
    const roundOff = roundOffOf(subtotal + tax, s.roundToRupee);
    const out: CalcLine[] = [...lines];
    const taxLine = (kind: 'CGST' | 'SGST', amount: number, code: string): CalcLine => ({
      lineKind: kind,
      chargeHeadId: null,
      headKey: null,
      description: `${kind} 9% on ${formatRupees(taxable)}`,
      quantity: null,
      ratePaise: null,
      amountPaise: amount,
      isTaxable: false,
      billingRuleVersionId: null,
      periodFrom: null,
      periodTo: null,
      prorationDays: null,
      periodDays: null,
      computation: null,
      ledgerAccountCode: code,
      sacCode: null,
    });
    if (cgstPaise > 0) {
      out.push(taxLine('CGST', cgstPaise, LEDGER_CGST), taxLine('SGST', sgstPaise, LEDGER_SGST));
    }
    if (roundOff !== 0)
      out.push({
        ...taxLine('CGST', roundOff, LEDGER_ROUND_OFF),
        lineKind: 'ROUND_OFF',
        description: 'Round off',
      });
    items.push({
      party: b.party,
      lines: out,
      subtotalPaise: subtotal,
      taxableValuePaise: taxable,
      cgstPaise,
      sgstPaise,
      taxPaise: tax,
      roundOffPaise: roundOff,
      totalPaise: subtotal + tax + roundOff,
      warnings: [...b.warnings],
    });
  }
  return { status: 'OK', thresholdBasePaise: thresholdBase, gstApplied, items };
}
