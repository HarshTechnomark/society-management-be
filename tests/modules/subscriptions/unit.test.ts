import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../../helpers/auth';
import { closeDb } from '../../../src/models';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import {
  addMonthsAnchored,
  chargedFlats,
  freeMonthsFor,
  monthsOf,
  periodFrom,
  periodValue,
  planLimitValue,
  proration,
  usageMonth,
  zonedDayStart,
} from '../../../src/modules/subscriptions/pricing';
import { bucketOf, evaluate } from '../../../src/modules/subscriptions/flags.service';
import {
  FEATURES,
  LIMITS,
  assertCatalogue,
  defaultEnabled,
  plansWithFeature,
} from '../../../src/modules/subscriptions/subscriptions.catalogue';

afterAll(closeDb);

describe('pricing (BR-04-5 to BR-04-7)', () => {
  it('T04-01 annual period value of 240 flats on Standard is 10 months', () => {
    expect(periodValue(240, 1500, monthsOf('ANNUAL'), freeMonthsFor('ANNUAL', 2))).toBe(3_600_000);
    expect(periodValue(240, 1500, 1, freeMonthsFor('MONTHLY', 2))).toBe(360_000);
  });

  it('T04-02 40 flats on Standard (minimum 50) monthly bills 50 flats', () => {
    expect(chargedFlats(40, 50)).toBe(50);
    expect(periodValue(chargedFlats(40, 50), 1500, 1, 0)).toBe(75_000);
    expect(chargedFlats(40, 500, 20)).toBe(40); // Enterprise custom minimum replaces the version minimum
  });

  it('T04-03 proration 96 flats Starter to Standard on 17 November', () => {
    const p = proration('2026-11-17', '2026-11-01', '2026-11-30', 96 * 900, 96 * 1500);
    expect(p).toMatchObject({
      daysRemaining: 14,
      periodDays: 30,
      creditPaise: 40_320,
      chargePaise: 67_200,
      netPaise: 26_880,
    });
  });

  it('upgrade on the last day of the period prorates one day', () => {
    const p = proration('2026-11-30', '2026-11-01', '2026-11-30', 30_000, 60_000);
    expect(p).toMatchObject({ daysRemaining: 1, creditPaise: 1_000, chargePaise: 2_000, netPaise: 1_000 });
  });

  it('T04-04 anniversary periods from 31 January 2027', () => {
    const a = periodFrom('2027-01-31', 31, 1);
    expect(a).toMatchObject({ periodStart: '2027-01-31', periodEnd: '2027-02-27', periodDays: 28 });
    const b = periodFrom(addMonthsAnchored('2027-01-31', 31, 1), 31, 1);
    expect(b).toMatchObject({ periodStart: '2027-02-28', periodEnd: '2027-03-30' });
    const c = periodFrom(addMonthsAnchored(b.periodStart, 31, 1), 31, 1);
    // BR-04-6 rule: the next start is min(31, 30) = 30 April, so this period ends 29 April. The spec example prints
    // "31 Mar–30 Apr", which no single rule can produce together with "31 Jan–27 Feb" (noted in the module README).
    expect(c).toMatchObject({ periodStart: '2027-03-31', periodEnd: '2027-04-29' });
    expect(periodFrom('2026-12-01', 1, 12)).toMatchObject({ periodEnd: '2027-11-30', periodDays: 365 });
  });

  it('usage months follow the billing anchor (BR-04-20)', () => {
    expect(usageMonth('2026-11-17', 1).periodStart).toBe('2026-11-01');
    expect(usageMonth('2026-11-09', 10)).toMatchObject({
      periodStart: '2026-10-10',
      periodEnd: '2026-11-09',
    });
    expect(usageMonth('2027-02-10', 31)).toMatchObject({
      periodStart: '2027-01-31',
      periodEnd: '2027-02-27',
    });
  });

  it('a society-local day starts at 18:30 UTC the day before in India', () => {
    expect(zonedDayStart('2026-12-01').toISOString()).toBe('2026-11-30T18:30:00.000Z');
  });

  it('T04-07 admin seat formula on Starter with 240 flats', () => {
    expect(planLimitValue(2, 50, 240)).toBe(5);
    expect(planLimitValue(2, 50, 30)).toBe(2);
    expect(planLimitValue(null, 50, 240)).toBeNull();
  });
});

describe('catalogue (section 2)', () => {
  it('has 561 features and 12 limits with the spec counts', () => {
    expect(() => assertCatalogue()).not.toThrow();
    expect(FEATURES).toHaveLength(561);
    expect(LIMITS).toHaveLength(12);
    expect(FEATURES.filter(f => f.isAlwaysOn)).toHaveLength(14);
    expect(
      FEATURES.filter(f => f.catalogueStatus === 'PLANNED')
        .map(f => f.key)
        .sort(),
    ).toEqual([
      'communication.auto_translation',
      'communication.chat_groups',
      'communication.lobby_tv_display_mode',
      'communication.recurring_notices',
      'communication.smart_send_time_and_digest',
      'communication.whatsapp_broadcast_lists',
    ]);
  });

  it('applies the minimum-plan rule and never enables PLANNED keys', () => {
    const amen = FEATURES.find(f => f.key === 'amenities.amenity_catalogue')!;
    expect(plansWithFeature(amen)).toEqual(['STANDARD', 'PREMIUM', 'ENTERPRISE']);
    expect(defaultEnabled(amen, 'STARTER')).toBe(false);
    const planned = FEATURES.find(f => f.key === 'communication.chat_groups')!;
    expect(plansWithFeature(planned)).toEqual([]);
    expect(defaultEnabled(planned, 'ENTERPRISE')).toBe(false);
  });
});

describe('feature flags (BR-04-27)', () => {
  const flag = (o: Partial<Parameters<typeof evaluate>[0]> = {}) => ({
    flagKey: 'billing.new_run_wizard',
    type: 'PERCENTAGE' as const,
    isEnabled: true,
    minPlanCode: null,
    rolloutPercent: 30,
    overrides: {},
    ...o,
  });

  it('T04-08 buckets are stable and spread evenly; raising the rollout keeps existing societies', () => {
    expect(bucketOf('billing.new_run_wizard', 42)).toBe(bucketOf('billing.new_run_wizard', 42));
    let on30 = 0;
    let kept = true;
    for (let id = 1; id <= 10_000; id++) {
      const a = evaluate(flag(), { societyId: id, planCode: 'STARTER' }).on;
      const b = evaluate(flag({ rolloutPercent: 60 }), { societyId: id, planCode: 'STARTER' }).on;
      if (a) on30 += 1;
      if (a && !b) kept = false;
    }
    expect(on30).toBeGreaterThanOrEqual(2800);
    expect(on30).toBeLessThanOrEqual(3200);
    expect(kept).toBe(true);
  });

  it('T04-09 a society override off beats an engaged kill switch', () => {
    const k = flag({ type: 'KILL_SWITCH', overrides: { '7': { value: false, expiresAt: null } } });
    expect(evaluate(k, { societyId: 7, planCode: 'STANDARD' })).toMatchObject({
      on: false,
      step: 'OVERRIDE',
    });
    expect(evaluate(k, { societyId: 8, planCode: 'STANDARD' })).toMatchObject({
      on: true,
      step: 'KILL_SWITCH',
    });
  });

  it('evaluates in order: override, disabled, kill switch, plan, percentage, tenant, global', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const expired = flag({
      overrides: { '1': { value: true, expiresAt: '2026-10-01T00:00:00Z' } },
      rolloutPercent: 0,
    });
    expect(evaluate(expired, { societyId: 1, planCode: 'STARTER' }, at).step).toBe('PERCENTAGE');
    expect(evaluate(flag({ isEnabled: false }), { societyId: 1, planCode: 'STARTER' }).step).toBe('DISABLED');
    const plan = flag({ type: 'PLAN', minPlanCode: 'STANDARD' });
    expect(evaluate(plan, { societyId: 1, planCode: 'STARTER' }).on).toBe(false);
    expect(evaluate(plan, { societyId: 1, planCode: 'PREMIUM' }).on).toBe(true);
    expect(evaluate(flag({ type: 'TENANT' }), { societyId: 1, planCode: 'PREMIUM' }).on).toBe(false);
    expect(evaluate(flag({ type: 'GLOBAL' }), { societyId: 1, planCode: 'PREMIUM' }).on).toBe(true);
    // platform jobs: no society, PLAN and PERCENTAGE are off
    expect(evaluate(plan).on).toBe(false);
    expect(evaluate(flag()).on).toBe(false);
    expect(evaluate(flag({ type: 'GLOBAL' })).on).toBe(true);
  });
});

describe('route contract (definition of done)', () => {
  it('every requireFeature key on a route exists in the catalogue', () => {
    const keys = listRoutes(app).flatMap(r => r.features);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    expect(keys.filter(k => !FEATURES.some(f => f.key === k))).toEqual([]);
  });
});
