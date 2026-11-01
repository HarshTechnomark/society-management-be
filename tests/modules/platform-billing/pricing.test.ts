import { afterEach, describe, expect, it } from 'vitest';
import { formatRupees, percentOf, rateUnits, roundHalfUp } from '../../../src/lib/money';
import {
  amountDueOf,
  buildOneTimeLine,
  buildPeriodLines,
  buildProrationLines,
  computeTax,
  creditNoteAmounts,
  creditNoteDeadline,
  deriveInvoiceStatus,
  flatTrueUp,
  manualLineAmount,
  orderLines,
  periodValue,
  placeOfSupply,
  subtotalOf,
  type BillingSnapshot,
  type SettlementFields,
} from '../../../src/modules/platform-billing/pricing';
import {
  BILLING_SETTING_DEFAULTS,
  billingSettings,
  setBillingSettingsSource,
} from '../../../src/modules/platform-billing/platform-billing.settings';

/** Section 15 unit cases T06-01 to T06-07 and the calculator rules of 5.1 and 5.2. */

const sky: BillingSnapshot = {
  societyId: 1,
  planKey: 'PREMIUM',
  planName: 'Premium',
  planVersionId: 3,
  billingCycle: 'MONTHLY',
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  pricePerFlatPerMonthPaise: 2500,
  annualFreeMonths: 0,
  billableFlats: 420,
  addons: [
    { addonKey: 'EXTRA_GUARD_DEVICE', name: 'Extra guard device', quantity: 2, monthlyPricePaise: 29900 },
  ],
  previousPeriod: {
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    months: 1,
    freeMonths: 0,
    pricePerFlatPerMonthPaise: 2500,
    flatSegments: [
      { fromDate: '2026-10-01', toDate: '2026-10-21', billableFlats: 412 },
      { fromDate: '2026-10-22', toDate: '2026-10-31', billableFlats: 420 },
    ],
    overages: [],
  },
};

const annual = (o: Partial<BillingSnapshot>): BillingSnapshot => ({
  ...sky,
  billingCycle: 'ANNUAL',
  periodStart: '2026-11-01',
  periodEnd: '2027-10-31',
  annualFreeMonths: 2,
  addons: [],
  previousPeriod: null,
  ...o,
});

describe('lib/money', () => {
  it('T06-01 roundHalfUp rounds half away from zero', () => {
    expect(roundHalfUp(645160, 100)).toBe(6452);
    expect(roundHalfUp(-645150, 100)).toBe(-6452);
    expect(roundHalfUp(645149, 100)).toBe(6451);
    expect(roundHalfUp(0, 7)).toBe(0);
    expect(roundHalfUp(5n, 2n)).toBe(3);
    expect(() => roundHalfUp(1, 0)).toThrow();
  });

  it('percentOf works on decimal strings without floating point', () => {
    expect(percentOf(1116252, '18.0000', 2)).toBe(100463); // 100,462.68
    expect(percentOf(1116252, '9')).toBe(100463);
    expect(percentOf(13400000, '18.0000')).toBe(2412000);
    expect(percentOf(50, '9.0000')).toBe(5); // 4.5 → 5
    expect(percentOf(1340000, '10.0000')).toBe(134000);
    expect(percentOf(100, '0.0001')).toBe(0);
    expect(rateUnits('18.5')).toBe(185000n);
    expect(() => rateUnits('18.00001')).toThrow();
    expect(() => rateUnits('abc')).toThrow();
  });

  it('formats rupees with Indian grouping', () => {
    expect(formatRupees(2500)).toBe('₹25');
    expect(formatRupees(1267178)).toBe('₹12,671.78');
    expect(formatRupees(15812000)).toBe('₹1,58,120');
  });
});

describe('place of supply and GST (BR-06-14, BR-06-15)', () => {
  it('Maharashtra address without GSTIN is intra-state', () => {
    expect(placeOfSupply({ gstin: null, state: 'Maharashtra' }, '27')).toEqual({
      stateCode: '27',
      taxType: 'INTRA_STATE',
    });
  });

  it('Karnataka address is inter-state', () => {
    expect(placeOfSupply({ state: 'Karnataka' }, '27')).toEqual({ stateCode: '29', taxType: 'INTER_STATE' });
  });

  it('T06-05 a GSTIN starting 29 wins over a Maharashtra address', () => {
    expect(placeOfSupply({ gstin: '29ABCDE1234F1Z5', state: 'Maharashtra' }, '27')).toEqual({
      stateCode: '29',
      taxType: 'INTER_STATE',
    });
    // and a GSTIN starting 27 keeps a society whose address moved to Gujarat intra-state (section 14)
    expect(placeOfSupply({ gstin: '27ABCDE1234F1Z5', state: 'Gujarat' }, '27').taxType).toBe('INTRA_STATE');
  });

  it('computes tax once on the subtotal: CGST = SGST intra-state, IGST inter-state', () => {
    expect(computeTax(1116252, 'INTRA_STATE', '18.0000')).toEqual({
      subtotalPaise: 1116252,
      cgstPaise: 100463,
      sgstPaise: 100463,
      igstPaise: 0,
      taxPaise: 200926,
      totalPaise: 1317178,
    });
    expect(computeTax(13400000, 'INTER_STATE', '18.0000')).toMatchObject({
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 2412000,
      totalPaise: 15812000,
    });
  });
});

describe('invoice lines (BR-06-3 to BR-06-9)', () => {
  it('T06-02 Sky Heights period invoice: 420 flats, add-ons, 80 flat-days of 31', () => {
    const lines = buildPeriodLines(sky, 412);
    expect(lines.map(l => [l.lineType, l.quantity, l.unitPricePaise, l.amountPaise])).toEqual([
      ['PLAN', 420, 2500, 1050000],
      ['ADDON', 2, 29900, 59800],
      ['FLAT_TRUE_UP', 80, 2500, 6452],
    ]);
    expect(lines[0]!.description).toBe('Premium plan, 420 flats × ₹25 × 1 month (1–30 Nov 2026)');
    expect(lines[2]).toMatchObject({ prorationDays: 10, periodDays: 31, servicePeriodStart: '2026-10-01' });
    const subtotal = subtotalOf(lines);
    expect(subtotal).toBe(1116252);
    expect(computeTax(subtotal, 'INTRA_STATE', '18.0000')).toMatchObject({
      cgstPaise: 100463,
      sgstPaise: 100463,
      totalPaise: 1317178,
    });
  });

  it('no true-up without a previous invoice, or when flats did not grow; decreases are never refunded', () => {
    expect(buildPeriodLines(sky, null).map(l => l.lineType)).toEqual(['PLAN', 'ADDON']);
    expect(buildPeriodLines(sky, 420).map(l => l.lineType)).toEqual(['PLAN', 'ADDON']);
    expect(flatTrueUp(sky.previousPeriod!, 500)).toMatchObject({ flatDays: 0, amountPaise: 0 });
  });

  it('true-up of an annual previous period uses the value net of free months', () => {
    const prev = {
      periodStart: '2025-11-01',
      periodEnd: '2026-10-31',
      months: 12,
      freeMonths: 2,
      pricePerFlatPerMonthPaise: 1500,
      flatSegments: [{ fromDate: '2026-10-01', toDate: '2026-10-31', billableFlats: 250 }],
      overages: [],
    };
    // 10 flats × 31 days × (1500 × 10) ÷ 365 = 12,739.73 → 12,740
    expect(flatTrueUp(prev, 240)).toMatchObject({ flatDays: 310, prevPeriodDays: 365, amountPaise: 12740 });
  });

  it('T06-03 annual Orchid, Karnataka, 536 flats ₹25, 2 free months', () => {
    const lines = buildPeriodLines(annual({ billableFlats: 536 }), null);
    expect(lines.map(l => [l.lineType, l.amountPaise])).toEqual([
      ['PLAN', 16080000],
      ['DISCOUNT', -2680000],
    ]);
    expect(lines[1]!.description).toBe('Annual billing: 2 months free');
    const pos = placeOfSupply({ state: 'Karnataka' }, '27');
    expect(computeTax(subtotalOf(lines), pos.taxType, '18.0000')).toMatchObject({
      igstPaise: 2412000,
      totalPaise: 15812000,
    });
  });

  it('T06-03a annual Standard ₹15, 240 flats, Maharashtra', () => {
    const lines = buildPeriodLines(annual({ billableFlats: 240, pricePerFlatPerMonthPaise: 1500 }), null);
    expect(lines.map(l => l.amountPaise)).toEqual([4320000, -720000]);
    expect(computeTax(subtotalOf(lines), 'INTRA_STATE', '18.0000')).toEqual({
      subtotalPaise: 3600000,
      cgstPaise: 324000,
      sgstPaise: 324000,
      igstPaise: 0,
      taxPaise: 648000,
      totalPaise: 4248000,
    });
    expect(subtotalOf(lines)).toBe(periodValue(240, 1500, 12, 2));
  });

  it('BR-06-7 overage lines only on monthly period invoices', () => {
    const overages = [{ limitKey: 'limit.sms_per_month', label: 'SMS', quantity: 3, unitPricePaise: 5000 }];
    const monthly = buildPeriodLines({ ...sky, previousPeriod: { ...sky.previousPeriod!, overages } }, 420);
    expect(monthly.map(l => [l.lineType, l.amountPaise, l.limitKey ?? null])).toEqual([
      ['PLAN', 1050000, null],
      ['ADDON', 59800, null],
      ['OVERAGE', 15000, 'limit.sms_per_month'],
    ]);
    const yearly = buildPeriodLines(
      annual({
        previousPeriod: {
          ...sky.previousPeriod!,
          periodStart: '2025-11-01',
          months: 12,
          freeMonths: 2,
          overages,
        },
      }),
      420,
    );
    expect(yearly.some(l => l.lineType === 'OVERAGE')).toBe(false);
  });

  it('T06-04 proration Green Park Starter → Standard, 96 flats, 20 of 30 days', () => {
    const lines = buildProrationLines({
      items: [
        {
          label: 'Starter to Standard',
          planVersionId: 2,
          fromPeriodValuePaise: periodValue(96, 900, 1, 0),
          toPeriodValuePaise: periodValue(96, 1500, 1, 0),
        },
      ],
      effectiveDate: '2026-11-11',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
    });
    expect(lines.map(l => [l.lineType, l.amountPaise, l.prorationDays, l.periodDays])).toEqual([
      ['PRORATION', -57600, 20, 30],
      ['PRORATION', 96000, 20, 30],
    ]);
    expect(computeTax(subtotalOf(lines), 'INTRA_STATE', '18.0000')).toMatchObject({
      cgstPaise: 3456,
      sgstPaise: 3456,
      totalPaise: 45312,
    });
  });

  it('upgrade on the last day of the period still prorates one day', () => {
    const lines = buildProrationLines({
      items: [{ fromPeriodValuePaise: 86400, toPeriodValuePaise: 144000 }],
      effectiveDate: '2026-11-30',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
    });
    expect(subtotalOf(lines)).toBe(4800 - 2880);
  });

  it('one-time and overage lines; manual line amounts round half up', () => {
    expect(
      buildOneTimeLine({
        lineType: 'ONE_TIME',
        label: 'WhatsApp pack 5,000',
        quantity: 2,
        unitPricePaise: 49900,
        addonKey: 'WHATSAPP_PACK_5000',
        limitKey: 'x',
      }),
    ).toEqual([
      expect.objectContaining({ amountPaise: 99800, addonKey: 'WHATSAPP_PACK_5000', limitKey: null }),
    ]);
    expect(
      buildOneTimeLine({ lineType: 'OVERAGE', label: 'SMS', quantity: 3, unitPricePaise: 0, limitKey: 'l' }),
    ).toEqual([]);
    expect(manualLineAmount('1.5', 333)).toBe(500); // 499.5 → 500
    expect(manualLineAmount('2', 100000)).toBe(200000);
    expect(() => manualLineAmount('1.23456', 1)).toThrow();
  });

  it('BR-06-11 orders lines by type and drops zero lines', () => {
    const l = (lineType: 'PLAN' | 'ADDON' | 'DISCOUNT', amountPaise: number) => ({
      lineType,
      description: lineType,
      quantity: 1,
      unitPricePaise: 0,
      amountPaise,
    });
    expect(
      orderLines([l('ADDON', 1), l('PLAN', 2), l('DISCOUNT', 0), l('ADDON', 3)]).map(x => x.amountPaise),
    ).toEqual([2, 1, 3]);
  });
});

describe('deriveInvoiceStatus (T06-06, BR-06-22)', () => {
  const base: SettlementFields & { dueDate: string } = {
    totalPaise: 10000,
    creditAppliedPaise: 0,
    paidPaise: 0,
    tdsPaise: 0,
    creditNotedPaise: 0,
    writtenOffPaise: 0,
    excessToCreditPaise: 0,
    dueDate: '2026-11-16',
  };
  const cases: [string, Partial<typeof base>, string, string][] = [
    ['untouched before due', {}, '2026-11-10', 'ISSUED'],
    ['untouched on the due date', {}, '2026-11-16', 'ISSUED'],
    ['untouched after due', {}, '2026-11-17', 'OVERDUE'],
    ['part paid before due', { paidPaise: 4000 }, '2026-11-10', 'PARTIALLY_PAID'],
    ['part credit before due', { creditAppliedPaise: 1 }, '2026-11-10', 'PARTIALLY_PAID'],
    ['part TDS before due', { tdsPaise: 1000 }, '2026-11-10', 'PARTIALLY_PAID'],
    ['part paid after due', { paidPaise: 4000 }, '2026-12-01', 'OVERDUE'],
    ['paid in full', { paidPaise: 10000 }, '2026-12-01', 'PAID'],
    [
      'paid by credit, TDS and money',
      { creditAppliedPaise: 3000, tdsPaise: 1000, paidPaise: 6000 },
      '2026-11-10',
      'PAID',
    ],
    ['partial credit note before due', { creditNotedPaise: 4000 }, '2026-11-10', 'ISSUED'],
    ['credit note settles the rest', { creditNotedPaise: 4000, paidPaise: 6000 }, '2026-12-01', 'PAID'],
    ['full credit note', { creditNotedPaise: 10000 }, '2026-11-10', 'VOID'],
    [
      'full credit note after payment',
      { creditNotedPaise: 10000, paidPaise: 10000, excessToCreditPaise: 10000 },
      '2026-12-01',
      'VOID',
    ],
    ['written off', { paidPaise: 2000, writtenOffPaise: 8000 }, '2026-12-01', 'WRITTEN_OFF'],
    [
      'paid then excess moved to credit by a partial credit note',
      { paidPaise: 10000, creditNotedPaise: 3000, excessToCreditPaise: 3000 },
      '2026-12-01',
      'PAID',
    ],
    [
      'payment fully moved back to credit',
      { paidPaise: 4000, excessToCreditPaise: 4000, creditNotedPaise: 4000 },
      '2026-11-10',
      'ISSUED',
    ],
  ];
  it.each(cases)('%s', (_name, o, today, expected) => {
    expect(deriveInvoiceStatus({ ...base, ...o }, today)).toBe(expected);
  });

  it('amountDue follows BR-06-21', () => {
    expect(
      amountDueOf({ ...base, creditNotedPaise: 3000, paidPaise: 10000, excessToCreditPaise: 3000 }),
    ).toBe(0);
    expect(amountDueOf({ ...base, tdsPaise: 1000, creditAppliedPaise: 500 })).toBe(8500);
  });
});

describe('credit notes (T06-07, BR-06-20)', () => {
  const invoice = {
    ...computeTax(100, 'INTRA_STATE', '18.0000'),
    taxType: 'INTRA_STATE' as const,
    gstRatePct: '18.0000',
  };

  it('a partial credit note is taxed on its own subtotal', () => {
    expect(invoice).toMatchObject({ cgstPaise: 9, sgstPaise: 9, totalPaise: 118 });
    const first = creditNoteAmounts({
      invoice,
      creditedSubtotalPaise: 0,
      creditedTax: { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
      subtotalPaise: 50,
    });
    expect(first).toMatchObject({ cgstPaise: 5, sgstPaise: 5, totalPaise: 60 }); // 4.5 → 5
  });

  it('the credit note completing the subtotal takes the exact remaining tax', () => {
    const last = creditNoteAmounts({
      invoice,
      creditedSubtotalPaise: 50,
      creditedTax: { cgstPaise: 5, sgstPaise: 5, igstPaise: 0 },
      subtotalPaise: 50,
    });
    expect(last).toEqual({
      subtotalPaise: 50,
      cgstPaise: 4,
      sgstPaise: 4,
      igstPaise: 0,
      taxPaise: 8,
      totalPaise: 58,
    });
    expect(60 + last.totalPaise).toBe(invoice.totalPaise);
  });

  it('deadline is 30 November after the end of the financial year', () => {
    expect(creditNoteDeadline('2026-27')).toBe('2027-11-30');
  });
});

describe('settings reader (5.3)', () => {
  afterEach(() => setBillingSettingsSource());

  it('uses the code defaults until module 07 provides values', async () => {
    expect(await billingSettings()).toEqual(BILLING_SETTING_DEFAULTS);
  });

  it('takes valid stored values and ignores invalid ones', async () => {
    const stored: Record<string, unknown> = {
      'billing.netTermsDays': 30,
      'billing.gstRatePct': 18.5, // a float is refused: decimals are strings
      'billing.reminderOffsetsDays': [3, -7],
      'billing.sacCode': '998315',
    };
    setBillingSettingsSource(async k => stored[k]);
    const s = await billingSettings();
    expect(s['billing.netTermsDays']).toBe(30);
    expect(s['billing.sacCode']).toBe('998315');
    expect(s['billing.gstRatePct']).toBe('18.0000');
    expect(s['billing.reminderOffsetsDays']).toEqual([-7, 0, 3, 7]);
  });

  it('suspendAfterDays must exceed pastDueAfterDays', async () => {
    setBillingSettingsSource(async k =>
      k === 'billing.pastDueAfterDays' ? 10 : k === 'billing.suspendAfterDays' ? 5 : undefined,
    );
    const s = await billingSettings();
    expect([s['billing.pastDueAfterDays'], s['billing.suspendAfterDays']]).toEqual([1, 15]);
  });
});
