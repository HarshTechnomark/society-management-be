import { describe, expect, it } from 'vitest';
import { roundHalfUp } from '../../../src/lib/money';
import {
  billDateOf,
  isPeriodStart,
  periodDaysOf,
  periodEndOf,
  periodLabelOf,
  periodStartContaining,
  runLabelOf,
} from '../../../src/modules/billing/billing.calc.period';
import { splitPaise, splitWeightOf } from '../../../src/modules/billing/billing.calc.split';
import { gstApplies, gstOf, roundOffOf } from '../../../src/modules/billing/billing.calc.gst';
import { rateOf, type RateVersion } from '../../../src/modules/billing/billing.calc.rates';
import {
  scopeMatches,
  winningRule,
  type RuleCandidate,
} from '../../../src/modules/billing/billing.calc.rules';
import { liableSegments, type LinkRow } from '../../../src/modules/billing/billing.calc.segments';
import {
  calcUnit,
  type CalcHead,
  type CalcInput,
  type CalcSettings,
  type CalcUnit,
} from '../../../src/modules/billing/billing.calc.unit';
import type { Party, Segment } from '../../../src/modules/billing/billing.calc.segments';

/** Pure calculator tests: worked examples A to F of spec 6.7 and T11-01 to T11-13 (no database). */

const version = (
  o: Partial<RateVersion> & { id: number; rateType: RateVersion['rateType'] },
): RateVersion => ({
  versionNo: 1,
  amountPaise: null,
  ratePerSqftPaise: null,
  unitTypeRates: null,
  meterType: null,
  slabs: null,
  minimumChargePaise: null,
  missingReadingPolicy: null,
  billSplitRuleId: null,
  percent: null,
  baseChargeHeadIds: null,
  ...o,
});

const head = (o: Partial<CalcHead> & { id: number; key: string }): CalcHead => ({
  name: o.key,
  headType: 'OTHER',
  payerRouting: 'BILL_TO',
  gstTreatment: 'THRESHOLD',
  sacCode: '995411',
  prorate: true,
  ledgerAccountCode: '4190',
  sortOrder: o.id * 10,
  ...o,
});

const H = {
  maint: head({
    id: 1,
    key: 'MAINTENANCE',
    name: 'Maintenance',
    headType: 'MAINTENANCE',
    ledgerAccountCode: '4100',
  }),
  sinking: head({
    id: 2,
    key: 'SINKING_FUND',
    name: 'Sinking fund',
    headType: 'SINKING_FUND',
    payerRouting: 'OWNER',
    ledgerAccountCode: '2410',
  }),
  repair: head({
    id: 3,
    key: 'REPAIR_FUND',
    name: 'Repair fund',
    headType: 'REPAIR_FUND',
    payerRouting: 'OWNER',
    ledgerAccountCode: '2420',
  }),
  parking: head({ id: 4, key: 'PARKING', name: 'Parking', headType: 'PARKING', ledgerAccountCode: '4120' }),
  water: head({
    id: 5,
    key: 'WATER',
    name: 'Water',
    headType: 'WATER',
    gstTreatment: 'NONE',
    sacCode: null,
    ledgerAccountCode: '4130',
  }),
  noc: head({
    id: 6,
    key: 'NOC',
    name: 'Non-occupancy charges',
    headType: 'NON_OCCUPANCY',
    payerRouting: 'OWNER',
    ledgerAccountCode: '4110',
  }),
};

const cand = (
  h: CalcHead,
  v: RateVersion,
  scopeType: RuleCandidate['scopeType'] = 'ALL_UNITS',
  scopeValues: (number | string)[] | null = null,
): RuleCandidate => ({
  ruleId: h.id,
  chargeHeadId: h.id,
  scopeType,
  scopeValues,
  version: v,
});

const standardRules = (): RuleCandidate[] => [
  cand(H.maint, version({ id: 11, rateType: 'PER_SQFT', ratePerSqftPaise: 320 })),
  cand(H.sinking, version({ id: 12, rateType: 'FLAT_PER_UNIT', amountPaise: 60_000 })),
  cand(H.repair, version({ id: 13, rateType: 'FLAT_PER_UNIT', amountPaise: 25_000 })),
  cand(
    H.parking,
    version({ id: 14, rateType: 'FLAT_PER_UNIT', amountPaise: 50_000 }),
    'UNITS',
    [1203, 801, 504, 102],
  ),
  cand(H.water, version({ id: 15, rateType: 'FLAT_PER_UNIT', amountPaise: 35_000 })),
];

const settings = (o: Partial<CalcSettings> = {}): CalcSettings => ({
  cycle: 'MONTHLY',
  months: 1,
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  periodDays: 30,
  applyGst: false,
  gstExemptLimitPaise: 750_000,
  roundToRupee: true,
  prorated: true,
  ownerTenantSplit: true,
  areaBasis: 'CARPET',
  ...o,
});

const owner: Party = { residentId: 1, relation: 'OWNER', name: 'Owner' };
const tenant: Party = { residentId: 2, relation: 'TENANT', name: 'Tenant' };
const seg = (o: Partial<Segment> = {}): Segment => ({
  from: '2026-11-01',
  to: '2026-11-30',
  days: 30,
  owner,
  tenancyActive: false,
  billTo: owner,
  ...o,
});
const unit = (o: Partial<CalcUnit> = {}): CalcUnit => ({
  id: 1203,
  label: 'A-1203',
  buildingId: 1,
  unitType: 'FLAT',
  bhk: '3BHK',
  areaSqft: '1150.000',
  ...o,
});
const calc = (o: Partial<CalcInput> & { unit?: CalcUnit } = {}) =>
  calcUnit({
    unit: unit(),
    segments: [seg()],
    heads: Object.values(H),
    candidates: standardRules(),
    settings: settings(),
    ...o,
  });
const ok = (r: ReturnType<typeof calcUnit>) => {
  if (r.status !== 'OK') throw new Error(`expected OK, got ${JSON.stringify(r)}`);
  return r;
};
const amountOf = (item: { lines: { headKey: string | null; amountPaise: number }[] }, key: string) =>
  item.lines.find(l => l.headKey === key)?.amountPaise;

describe('periods (BR-11-24)', () => {
  it('aligns periods to the financial year and counts days', () => {
    expect(isPeriodStart('MONTHLY', '2026-11-01')).toBe(true);
    expect(isPeriodStart('MONTHLY', '2026-11-02')).toBe(false);
    expect(isPeriodStart('QUARTERLY', '2026-10-01')).toBe(true);
    expect(isPeriodStart('QUARTERLY', '2026-11-01')).toBe(false);
    expect(isPeriodStart('HALF_YEARLY', '2026-04-01')).toBe(true);
    expect(isPeriodStart('HALF_YEARLY', '2026-07-01')).toBe(false);
    expect(isPeriodStart('ANNUAL', '2026-04-01')).toBe(true);
    expect(periodEndOf('MONTHLY', '2026-11-01')).toBe('2026-11-30');
    expect(periodEndOf('QUARTERLY', '2027-01-01')).toBe('2027-03-31');
    expect(periodEndOf('ANNUAL', '2026-04-01')).toBe('2027-03-31');
    expect(periodDaysOf('MONTHLY', '2028-02-01')).toBe(29);
    expect(periodStartContaining('QUARTERLY', '2026-11-15')).toBe('2026-10-01');
    expect(periodStartContaining('QUARTERLY', '2027-02-15')).toBe('2027-01-01');
    expect(periodStartContaining('HALF_YEARLY', '2027-02-15')).toBe('2026-10-01');
    expect(periodStartContaining('ANNUAL', '2027-02-15')).toBe('2026-04-01');
    expect(billDateOf('2026-11-01', 5)).toBe('2026-11-05');
    expect(runLabelOf('2026-11-01')).toBe('BR-2026-11');
    expect(runLabelOf('2026-11-01', 2)).toBe('BR-2026-11-S2');
    expect(periodLabelOf('MONTHLY', '2026-11-01')).toBe('Nov 2026');
    expect(periodLabelOf('QUARTERLY', '2026-10-01')).toBe('Oct to Dec 2026');
  });
});

describe('rate types (T11-01, T11-10, BR-11-17)', () => {
  it('T11-01 PER_SQFT 1150.000 x 320 = 368,000 and the flat has its area kept exact', () => {
    const r = rateOf(version({ id: 1, rateType: 'PER_SQFT', ratePerSqftPaise: 320 }), {
      unit: unit(),
      months: 1,
    });
    expect(r.kind === 'amount' && roundHalfUp(r.num / r.den, 1)).toBe(368_000);
    const odd = rateOf(version({ id: 1, rateType: 'PER_SQFT', ratePerSqftPaise: 355 }), {
      unit: unit({ areaSqft: '1150.501' }),
      months: 1,
    });
    // 1150501 x 355 = 408,427,855 / 1000 = 408,427.855 -> 408,428
    expect(odd.kind === 'amount' && roundHalfUp(odd.num, odd.den)).toBe(408_428);
  });

  it('PER_SQFT without area is MISSING_AREA; PER_UNIT_TYPE uses bhk before unit type; a missing class is an exception', () => {
    const sq = version({ id: 1, rateType: 'PER_SQFT', ratePerSqftPaise: 320 });
    expect(rateOf(sq, { unit: unit({ areaSqft: null }), months: 1 })).toMatchObject({
      kind: 'exception',
      code: 'MISSING_AREA',
    });
    expect(rateOf(sq, { unit: unit({ areaSqft: '0.000' }), months: 1 })).toMatchObject({
      kind: 'exception',
      code: 'MISSING_AREA',
    });
    const t = version({
      id: 2,
      rateType: 'PER_UNIT_TYPE',
      unitTypeRates: { '2BHK': 250_000, SHOP: 400_000 },
    });
    const two = rateOf(t, { unit: unit({ bhk: '2BHK' }), months: 3 });
    expect(two.kind === 'amount' && roundHalfUp(two.num, two.den)).toBe(750_000);
    const shop = rateOf(t, { unit: unit({ bhk: null, unitType: 'SHOP' }), months: 1 });
    expect(shop.kind === 'amount' && roundHalfUp(shop.num, shop.den)).toBe(400_000);
    expect(rateOf(t, { unit: unit({ bhk: '3BHK' }), months: 1 })).toMatchObject({
      kind: 'exception',
      code: 'MISSING_UNIT_TYPE_RATE',
    });
  });

  it('a period of m months multiplies the monthly rate (BR-11-16)', () => {
    const f = rateOf(version({ id: 1, rateType: 'FLAT_PER_UNIT', amountPaise: 60_000 }), {
      unit: unit(),
      months: 6,
    });
    expect(f.kind === 'amount' && Number(f.num / f.den)).toBe(360_000);
  });

  it('T11-10 / example F: metered 18,400 litres over two slabs = 41,900; minimum charge; missing reading policies', () => {
    const v = version({
      id: 3,
      rateType: 'METERED',
      meterType: 'WATER',
      slabs: [
        { uptoMilli: 15_000, ratePaise: 2000 },
        { uptoMilli: null, ratePaise: 3500 },
      ],
      minimumChargePaise: 5000,
      missingReadingPolicy: 'EXCEPTION',
    });
    const r = rateOf(v, {
      unit: unit(),
      months: 1,
      meter: { quantityMilli: 18_400n, readingIds: [5, 6], isEstimated: false },
    });
    expect(r.kind === 'amount' && roundHalfUp(r.num, r.den)).toBe(41_900);
    expect(r.kind === 'amount' && r.computation.readingIds).toEqual([5, 6]);
    const low = rateOf(v, {
      unit: unit(),
      months: 1,
      meter: { quantityMilli: 1000n, readingIds: [7], isEstimated: true },
    });
    expect(low.kind === 'amount' && roundHalfUp(low.num, low.den)).toBe(5000);
    expect(low.kind === 'amount' && low.warnings).toEqual(['ESTIMATED_READING', 'MINIMUM_CHARGE_APPLIED']);
    expect(rateOf(v, { unit: unit(), months: 1 })).toMatchObject({
      kind: 'exception',
      code: 'MISSING_READING',
    });
    const fallback = rateOf({ ...v, missingReadingPolicy: 'MINIMUM_CHARGE' }, { unit: unit(), months: 1 });
    expect(fallback.kind === 'amount' && roundHalfUp(fallback.num, fallback.den)).toBe(5000);
  });
});

describe('rule specificity (T11-13, BR-11-14)', () => {
  const u = { id: 7, buildingId: 3, unitType: 'FLAT', bhk: '2BHK' };
  const v = (id: number, amount: number) => version({ id, rateType: 'FLAT_PER_UNIT', amountPaise: amount });
  const mk = (
    ruleId: number,
    scopeType: RuleCandidate['scopeType'],
    values: (number | string)[] | null,
    amount: number,
  ): RuleCandidate => ({
    ruleId,
    chargeHeadId: 1,
    scopeType,
    scopeValues: values,
    version: v(ruleId, amount),
  });

  it('UNITS > UNIT_TYPES > BUILDINGS > ALL_UNITS; unit type matches unitType or bhk', () => {
    const all = mk(1, 'ALL_UNITS', null, 100);
    const bld = mk(2, 'BUILDINGS', [3], 200);
    const typ = mk(3, 'UNIT_TYPES', ['2bhk'], 300);
    const one = mk(4, 'UNITS', [7], 0);
    expect(winningRule([all], u)?.ruleId).toBe(1);
    expect(winningRule([all, bld], u)?.ruleId).toBe(2);
    expect(winningRule([all, bld, typ], u)?.ruleId).toBe(3);
    expect(winningRule([all, bld, typ, one], u)?.ruleId).toBe(4);
    expect(winningRule([all, mk(5, 'BUILDINGS', [9], 1)], u)?.ruleId).toBe(1);
    expect(scopeMatches('UNIT_TYPES', ['FLAT'], u)).toBe(true);
    expect(scopeMatches('UNIT_TYPES', ['SHOP'], u)).toBe(false);
  });

  it('a zero-rate UNITS rule exempts the flat (no line) and a NONE version stops the head', () => {
    const rules = [
      cand(H.maint, version({ id: 11, rateType: 'PER_SQFT', ratePerSqftPaise: 320 })),
      cand(H.maint, version({ id: 21, rateType: 'FLAT_PER_UNIT', amountPaise: 0 }), 'UNITS', [1203]),
    ];
    const r = ok(calc({ candidates: rules, heads: [H.maint] }));
    expect(r.items).toEqual([]);
    const stopped = ok(
      calc({ candidates: [cand(H.maint, version({ id: 22, rateType: 'NONE' }))], heads: [H.maint] }),
    );
    expect(stopped.items).toEqual([]);
  });
});

describe('worked examples of spec 6.7', () => {
  it('A: owner-occupied flat, no GST: 538,000, no round-off', () => {
    const r = ok(calc());
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(amountOf(it, 'MAINTENANCE')).toBe(368_000);
    expect(amountOf(it, 'SINKING_FUND')).toBe(60_000);
    expect(amountOf(it, 'REPAIR_FUND')).toBe(25_000);
    expect(amountOf(it, 'PARKING')).toBe(50_000);
    expect(amountOf(it, 'WATER')).toBe(35_000);
    expect([it.subtotalPaise, it.taxPaise, it.roundOffPaise, it.totalPaise]).toEqual([
      538_000, 0, 0, 538_000,
    ]);
    expect(r.thresholdBasePaise).toBe(503_000);
    expect(r.gstApplied).toBe(false);
    expect(it.lines.every(l => l.lineKind === 'CHARGE')).toBe(true);
    expect(it.lines[0]!.computation).toMatchObject({
      method: 'PER_SQFT',
      areaBasis: 'CARPET',
      ruleVersionNo: 1,
    });
    expect(it.lines[0]!.description).toBe('Maintenance: 1150 sq ft × ₹3.20 per sq ft (Nov 2026)');
  });

  it('B / T11-02: GST on the whole 823,000: CGST 74,070, SGST 74,070, round-off -40, total 1,006,100', () => {
    const r = ok(
      calc({
        unit: unit({ id: 801, label: 'C-0801', areaSqft: '2150.000' }),
        settings: settings({ applyGst: true }),
      }),
    );
    const it = r.items[0]!;
    expect(amountOf(it, 'MAINTENANCE')).toBe(688_000);
    expect(r.thresholdBasePaise).toBe(823_000);
    expect(r.gstApplied).toBe(true);
    expect(it.taxableValuePaise).toBe(823_000);
    expect([it.cgstPaise, it.sgstPaise]).toEqual([74_070, 74_070]);
    expect(it.subtotalPaise + it.taxPaise).toBe(1_006_140);
    expect(it.roundOffPaise).toBe(-40);
    expect(it.totalPaise).toBe(1_006_100);
    expect(it.lines.map(l => l.lineKind)).toEqual([
      'CHARGE',
      'CHARGE',
      'CHARGE',
      'CHARGE',
      'CHARGE',
      'CGST',
      'SGST',
      'ROUND_OFF',
    ]);
    expect(it.lines.find(l => l.headKey === 'WATER')!.isTaxable).toBe(false);
    expect(it.lines.find(l => l.headKey === 'MAINTENANCE')!.isTaxable).toBe(true);
  });

  it('T11-03 B exactly 750,000: no GST; one paisa above: GST on the whole', () => {
    const rules = [cand(H.maint, version({ id: 1, rateType: 'FLAT_PER_UNIT', amountPaise: 750_000 }))];
    const exact = ok(calc({ candidates: rules, heads: [H.maint], settings: settings({ applyGst: true }) }));
    expect(exact.gstApplied).toBe(false);
    expect(exact.items[0]!.taxPaise).toBe(0);
    const above = ok(
      calc({
        candidates: [cand(H.maint, version({ id: 1, rateType: 'FLAT_PER_UNIT', amountPaise: 750_001 }))],
        heads: [H.maint],
        settings: settings({ applyGst: true }),
      }),
    );
    expect(above.gstApplied).toBe(true);
    expect(above.items[0]!.taxableValuePaise).toBe(750_001);
  });

  it('T11-04 applyGst false: no GST at any amount', () => {
    const rules = [cand(H.maint, version({ id: 1, rateType: 'FLAT_PER_UNIT', amountPaise: 900_000 }))];
    const r = ok(calc({ candidates: rules, heads: [H.maint], settings: settings({ applyGst: false }) }));
    expect(r.gstApplied).toBe(false);
    expect(r.items[0]!.taxPaise).toBe(0);
  });

  it('T11-05 quarterly: B 2,100,000 is under the limit of 2,250,000; above it GST applies', () => {
    const q = settings({
      cycle: 'QUARTERLY',
      months: 3,
      periodStart: '2026-10-01',
      periodEnd: '2026-12-31',
      periodDays: 92,
      applyGst: true,
    });
    const low = ok(
      calc({
        settings: q,
        candidates: [cand(H.maint, version({ id: 1, rateType: 'FLAT_PER_UNIT', amountPaise: 700_000 }))],
        heads: [H.maint],
        segments: [seg({ from: '2026-10-01', to: '2026-12-31', days: 92 })],
      }),
    );
    expect(low.thresholdBasePaise).toBe(2_100_000);
    expect(low.gstApplied).toBe(false);
    const high = ok(
      calc({
        settings: q,
        candidates: [cand(H.maint, version({ id: 1, rateType: 'FLAT_PER_UNIT', amountPaise: 760_000 }))],
        heads: [H.maint],
        segments: [seg({ from: '2026-10-01', to: '2026-12-31', days: 92 })],
      }),
    );
    expect(high.gstApplied).toBe(true);
    expect(gstApplies(true, 2_250_000, 750_000, 3)).toBe(false);
    expect(gstApplies(true, 2_250_001, 750_000, 3)).toBe(true);
  });

  it('ALWAYS heads are taxed when applyGst is on even if the 7,500 test fails; NONE heads never', () => {
    const club = head({ id: 9, key: 'CLUBHOUSE', gstTreatment: 'ALWAYS' });
    const r = ok(
      calc({
        heads: [H.maint, club],
        candidates: [
          cand(H.maint, version({ id: 1, rateType: 'FLAT_PER_UNIT', amountPaise: 100_000 })),
          cand(club, version({ id: 2, rateType: 'FLAT_PER_UNIT', amountPaise: 10_000 })),
        ],
        settings: settings({ applyGst: true }),
      }),
    );
    expect(r.gstApplied).toBe(false);
    expect(r.items[0]!.taxableValuePaise).toBe(10_000);
    expect(r.items[0]!.cgstPaise).toBe(900);
  });

  it('C / T11-24: let-out flat, tenant pays: tenant 453,000, owner 121,800, flat total 574,800; NOC is 10% exactly', () => {
    const noc = cand(
      H.noc,
      version({ id: 16, rateType: 'PERCENT_OF_HEADS', percent: '10.0000', baseChargeHeadIds: [1] }),
    );
    const r = ok(
      calc({
        unit: unit({ id: 504, label: 'B-0504' }),
        candidates: [...standardRules(), noc],
        segments: [seg({ tenancyActive: true, billTo: tenant })],
      }),
    );
    expect(r.items).toHaveLength(2);
    const t = r.items.find(i => i.party.residentId === 2)!;
    const o = r.items.find(i => i.party.residentId === 1)!;
    expect(t.lines.map(l => [l.headKey, l.amountPaise])).toEqual([
      ['MAINTENANCE', 368_000],
      ['PARKING', 50_000],
      ['WATER', 35_000],
    ]);
    expect(t.totalPaise).toBe(453_000);
    expect(o.lines.map(l => [l.headKey, l.amountPaise])).toEqual([
      ['SINKING_FUND', 60_000],
      ['REPAIR_FUND', 25_000],
      ['NOC', 36_800],
    ]);
    expect(o.totalPaise).toBe(121_800);
    expect(t.totalPaise + o.totalPaise).toBe(574_800);
    expect(r.thresholdBasePaise).toBe(539_800);
    expect(r.gstApplied).toBe(false);
  });

  it('T11-07 NOC only applies on tenancy days and is billed to the owner; with no tenancy it is not charged', () => {
    const noc = cand(
      H.noc,
      version({ id: 16, rateType: 'PERCENT_OF_HEADS', percent: '10.0000', baseChargeHeadIds: [1] }),
    );
    const vacant = ok(calc({ candidates: [...standardRules(), noc] }));
    expect(vacant.items[0]!.lines.some(l => l.headKey === 'NOC')).toBe(false);
    // tenancy covers 16 to 30 Nov (15 days): roundHalfUp(368000 x 100000 x 15, 1,000,000 x 30) = 18,400
    const half = ok(
      calc({
        candidates: [...standardRules(), noc],
        segments: [
          seg({ to: '2026-11-15', days: 15 }),
          seg({ from: '2026-11-16', days: 15, tenancyActive: true, billTo: tenant }),
        ],
      }),
    );
    const o = half.items.find(i => i.party.residentId === 1)!;
    expect(amountOf(o, 'NOC')).toBe(18_400);
    expect(o.lines.find(l => l.headKey === 'NOC')!).toMatchObject({ prorationDays: 15, periodDays: 30 });
  });

  it('D / T11-06: proration at possession: 19 of 30 days', () => {
    const r = ok(
      calc({ unit: unit({ id: 102, label: 'D-0102' }), segments: [seg({ from: '2026-11-12', days: 19 })] }),
    );
    const it = r.items[0]!;
    expect(amountOf(it, 'MAINTENANCE')).toBe(233_067);
    expect(amountOf(it, 'SINKING_FUND')).toBe(38_000);
    expect(it.lines[0]).toMatchObject({
      prorationDays: 19,
      periodDays: 30,
      periodFrom: '2026-11-12',
      periodTo: '2026-11-30',
    });
    expect(it.lines[0]!.description).toContain('19 of 30 days');
    expect(it.warnings).toContain('PRORATED');
    // B for GST uses the unprorated amounts
    expect(r.thresholdBasePaise).toBe(368_000 + 60_000 + 25_000 + 50_000);
    expect(roundHalfUp(368_000 * 19, 30)).toBe(233_067);
  });

  it('a head with prorate false is billed in full to the party liable on the first day; feature off bills in full', () => {
    const noProrate = { ...H.maint, prorate: false };
    const seg19 = [seg({ from: '2026-11-12', days: 19 })];
    const r = ok(calc({ heads: [noProrate], candidates: standardRules(), segments: seg19 }));
    expect(r.items[0]!.lines[0]!.amountPaise).toBe(368_000);
    expect(r.items[0]!.warnings).not.toContain('PRORATED');
    const off = ok(
      calc({
        heads: [H.maint],
        candidates: standardRules(),
        segments: seg19,
        settings: settings({ prorated: false }),
      }),
    );
    expect(off.items[0]!.lines[0]!.amountPaise).toBe(368_000);
  });

  it('ownership change mid-period: two owners, each billed for their own days, rounded once per head', () => {
    const o2: Party = { residentId: 9, relation: 'OWNER', name: 'New owner' };
    const r = ok(
      calc({
        heads: [H.maint, H.sinking],
        segments: [
          seg({ to: '2026-11-11', days: 11 }),
          seg({ from: '2026-11-12', days: 19, owner: o2, billTo: o2 }),
        ],
      }),
    );
    const old = r.items.find(i => i.party.residentId === 1)!;
    const next = r.items.find(i => i.party.residentId === 9)!;
    expect(amountOf(old, 'MAINTENANCE')).toBe(roundHalfUp(368_000 * 11, 30));
    expect(amountOf(next, 'MAINTENANCE')).toBe(233_067);
    expect(amountOf(next, 'SINKING_FUND')).toBe(38_000);
    // GST test is per flat across both parties
    expect(r.thresholdBasePaise).toBe(428_000);
  });

  it('tenant moves in on 16 Nov, tenant pays: BILL_TO heads split by days, OWNER heads stay with the owner for the whole month', () => {
    const r = ok(
      calc({
        heads: [H.maint, H.sinking],
        segments: [
          seg({ to: '2026-11-15', days: 15 }),
          seg({ from: '2026-11-16', days: 15, tenancyActive: true, billTo: tenant }),
        ],
      }),
    );
    const o = r.items.find(i => i.party.residentId === 1)!;
    const t = r.items.find(i => i.party.residentId === 2)!;
    expect(amountOf(o, 'MAINTENANCE')).toBe(184_000);
    expect(amountOf(t, 'MAINTENANCE')).toBe(184_000);
    expect(amountOf(o, 'SINKING_FUND')).toBe(60_000);
    expect(o.lines.find(l => l.headKey === 'SINKING_FUND')!.prorationDays).toBeNull();
    expect(t.lines.some(l => l.headKey === 'SINKING_FUND')).toBe(false);
  });

  it('owner and tenant split feature off: every BILL_TO head goes to the owner', () => {
    const r = ok(
      calc({
        heads: [H.maint],
        settings: settings({ ownerTenantSplit: false }),
        segments: [seg({ tenancyActive: true, billTo: tenant })],
      }),
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.party.residentId).toBe(1);
  });

  it('no liable segment is skipped; a missing area is an exception', () => {
    expect(calc({ segments: [] })).toEqual({ status: 'SKIPPED' });
    expect(calc({ unit: unit({ areaSqft: null }) })).toMatchObject({
      status: 'EXCEPTION',
      code: 'MISSING_AREA',
    });
  });
});

describe('split of a total bill (T11-08, T11-09, example E, BR-11-22)', () => {
  it('T11-08 / E: 1,000,000 by area 1,150 / 1,150 / 700 = 383,334 / 383,333 / 233,333', () => {
    const w = [
      { unitId: 501, weight: 1_150_000n },
      { unitId: 502, weight: 1_150_000n },
      { unitId: 503, weight: 700_000n },
    ];
    const s = splitPaise(1_000_000, w);
    expect([s.get(501), s.get(502), s.get(503)]).toEqual([383_334, 383_333, 233_333]);
  });

  it('T11-09 property: shares sum to T and each is within one paisa of the exact share', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const n = 1 + rnd(40);
      const weights = Array.from({ length: n }, (_, i) => ({
        unitId: i + 1,
        weight: BigInt(rnd(5) === 0 ? 0 : 1 + rnd(2_000_000)),
      }));
      if (weights.every(x => x.weight === 0n)) weights[0]!.weight = 1n;
      const total = 1 + rnd(1_000_000_000);
      const shares = splitPaise(total, weights);
      const sum = [...shares.values()].reduce((a, b) => a + b, 0);
      expect(sum).toBe(total);
      const W = weights.reduce((a, x) => a + x.weight, 0n);
      for (const x of weights) {
        const exact = (BigInt(total) * x.weight) / W;
        const share = BigInt(shares.get(x.unitId) ?? 0);
        expect(share === exact || share === exact + 1n).toBe(true);
        if (x.weight === 0n) expect(shares.has(x.unitId)).toBe(false);
      }
    }
  });

  it('weights per basis; zero total weight throws', () => {
    const u = { id: 5, unitType: 'FLAT', bhk: '2BHK', areaSqft: '700.000' };
    expect(splitWeightOf({ basis: 'EQUAL', weights: null }, u)).toEqual({ weight: 1n });
    expect(splitWeightOf({ basis: 'AREA', weights: null }, u)).toEqual({ weight: 700_000n });
    expect(splitWeightOf({ basis: 'AREA', weights: null }, { ...u, areaSqft: null })).toEqual({
      exception: 'MISSING_AREA',
    });
    expect(splitWeightOf({ basis: 'UNIT_TYPE_WEIGHT', weights: { '2BHK': 2 } }, u)).toEqual({ weight: 2n });
    expect(splitWeightOf({ basis: 'UNIT_TYPE_WEIGHT', weights: { '3BHK': 2 } }, u)).toEqual({
      exception: 'MISSING_UNIT_TYPE_RATE',
    });
    expect(splitWeightOf({ basis: 'CUSTOM_WEIGHT', weights: { '5': 3 } }, u)).toEqual({ weight: 3n });
    expect(splitWeightOf({ basis: 'CUSTOM_WEIGHT', weights: {} }, u)).toEqual({ weight: 0n });
    expect(() => splitPaise(100, [{ unitId: 1, weight: 0n }])).toThrow();
  });

  it('a SPLIT_TOTAL line is the flat share and is not prorated', () => {
    const lift = head({ id: 7, key: 'LIFT_AMC', name: 'Lift AMC', gstTreatment: 'NONE', sacCode: null });
    const v = version({ id: 30, rateType: 'SPLIT_TOTAL', billSplitRuleId: 4 });
    const r = ok(
      calc({
        heads: [lift],
        candidates: [cand(lift, v)],
        segments: [seg({ from: '2026-11-12', days: 19 })],
        splitFor: () => ({ share: 383_334 }),
      }),
    );
    expect(r.items[0]!.lines[0]).toMatchObject({ amountPaise: 383_334, prorationDays: null });
    const missing = calc({
      heads: [lift],
      candidates: [cand(lift, v)],
      splitFor: () => ({ exception: 'MISSING_AREA' }),
    });
    expect(missing).toMatchObject({ status: 'EXCEPTION', code: 'MISSING_AREA' });
  });
});

describe('round-off and GST rounding (T11-12, BR-11-4)', () => {
  it('T11-12 totals ending 49, 50, 99 paise round to -49, +50, +1; always between -49 and 50', () => {
    expect(roundOffOf(100_049, true)).toBe(-49);
    expect(roundOffOf(100_050, true)).toBe(50);
    expect(roundOffOf(100_099, true)).toBe(1);
    expect(roundOffOf(100_000, true)).toBe(0);
    expect(roundOffOf(100_049, false)).toBe(0);
    for (let t = 1; t < 3000; t++) {
      const r = roundOffOf(t, true);
      expect(r).toBeGreaterThanOrEqual(-49);
      expect(r).toBeLessThanOrEqual(50);
      expect((t + r) % 100).toBe(0);
    }
  });

  it('GST is computed once per document on the total taxable value', () => {
    expect(gstOf(823_000)).toEqual({ cgstPaise: 74_070, sgstPaise: 74_070 });
    expect(gstOf(0)).toEqual({ cgstPaise: 0, sgstPaise: 0 });
    expect(gstOf(1050)).toEqual({ cgstPaise: 95, sgstPaise: 95 }); // 94.5 rounds half up
  });

  it('with roundToRupee off no round-off line exists and totals are exact paise', () => {
    const rules = [cand(H.maint, version({ id: 1, rateType: 'PER_SQFT', ratePerSqftPaise: 355 }))];
    const r = ok(
      calc({
        candidates: rules,
        heads: [H.maint],
        unit: unit({ areaSqft: '1150.501' }),
        settings: settings({ roundToRupee: false }),
      }),
    );
    expect(r.items[0]!.roundOffPaise).toBe(0);
    expect(r.items[0]!.totalPaise).toBe(408_428);
    expect(r.items[0]!.lines.some(l => l.lineKind === 'ROUND_OFF')).toBe(false);
    const rounded = ok(calc({ candidates: rules, heads: [H.maint], unit: unit({ areaSqft: '1150.501' }) }));
    expect(rounded.items[0]!.roundOffPaise).toBe(-28);
    expect(rounded.items[0]!.totalPaise).toBe(408_400);
    expect(rounded.items[0]!.lines.at(-1)).toMatchObject({
      lineKind: 'ROUND_OFF',
      amountPaise: -28,
      ledgerAccountCode: '4990',
    });
  });
});

describe('liable segments (BR-11-26, BR-11-27)', () => {
  const link = (o: Partial<LinkRow> & { linkId: number; residentId: number }): LinkRow => ({
    name: `R${o.residentId}`,
    relation: 'OWNER',
    isPrimary: true,
    fromDate: '2019-04-01',
    toDate: null,
    ...o,
  });

  it('one owner all period is one segment of 30 days', () => {
    const s = liableSegments([link({ linkId: 1, residentId: 1 })], '2026-11-01', '2026-11-30', null);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ from: '2026-11-01', to: '2026-11-30', days: 30, tenancyActive: false });
  });

  it('possession on 12 Nov gives 19 liable days; possession after the period gives none', () => {
    const l = [link({ linkId: 1, residentId: 1 })];
    expect(liableSegments(l, '2026-11-01', '2026-11-30', '2026-11-12')[0]).toMatchObject({
      from: '2026-11-12',
      days: 19,
    });
    expect(liableSegments(l, '2026-11-01', '2026-11-30', '2026-12-01')).toEqual([]);
  });

  it('an owner link that starts mid-period is liable only from its first day; no owner is no segment', () => {
    const s = liableSegments(
      [link({ linkId: 1, residentId: 1, fromDate: '2026-11-12' })],
      '2026-11-01',
      '2026-11-30',
      null,
    );
    expect(s.map(x => [x.from, x.days])).toEqual([['2026-11-12', 19]]);
    expect(
      liableSegments(
        [link({ linkId: 2, residentId: 5, relation: 'TENANT' })],
        '2026-11-01',
        '2026-11-30',
        null,
      ),
    ).toEqual([]);
  });

  it('ownership change cuts the period at the new link; the primary owner wins over a co-owner', () => {
    const s = liableSegments(
      [
        link({ linkId: 1, residentId: 1, toDate: '2026-11-11' }),
        link({ linkId: 2, residentId: 9, fromDate: '2026-11-12' }),
        link({ linkId: 3, residentId: 4, relation: 'CO_OWNER', isPrimary: false, fromDate: '2019-04-01' }),
      ],
      '2026-11-01',
      '2026-11-30',
      null,
    );
    expect(s.map(x => [x.owner.residentId, x.from, x.to, x.days])).toEqual([
      [1, '2026-11-01', '2026-11-11', 11],
      [9, '2026-11-12', '2026-11-30', 19],
    ]);
  });

  it('a tenant link marks the segment as let out and cuts at move-in and move-out', () => {
    const s = liableSegments(
      [
        link({ linkId: 1, residentId: 1 }),
        link({
          linkId: 2,
          residentId: 2,
          relation: 'TENANT',
          isPrimary: false,
          fromDate: '2026-11-10',
          toDate: '2026-11-19',
        }),
      ],
      '2026-11-01',
      '2026-11-30',
      null,
    );
    expect(s.map(x => [x.from, x.to, x.days, x.tenancyActive])).toEqual([
      ['2026-11-01', '2026-11-09', 9, false],
      ['2026-11-10', '2026-11-19', 10, true],
      ['2026-11-20', '2026-11-30', 11, false],
    ]);
  });

  it('a new tenant on the day the old one leaves is a separate segment', () => {
    const s = liableSegments(
      [
        link({ linkId: 1, residentId: 1 }),
        link({ linkId: 2, residentId: 2, relation: 'TENANT', isPrimary: false, toDate: '2026-11-14' }),
        link({ linkId: 3, residentId: 3, relation: 'TENANT', isPrimary: false, fromDate: '2026-11-15' }),
      ],
      '2026-11-01',
      '2026-11-30',
      null,
    );
    expect(s.map(x => [x.from, x.days])).toEqual([
      ['2026-11-01', 14],
      ['2026-11-15', 16],
    ]);
  });
});
