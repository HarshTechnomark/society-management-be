import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../../src/models';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { app } from '../../helpers/auth';
import { drainQueues } from '../../../src/lib/queue';
import { setBillingPorts } from '../../../src/modules/billing/billing.ports';
import { memberOf } from '../../helpers/society-setup';
import { addOwner, makeRule, makeSplitRule, resetRuns, runSociety } from '../../helpers/billing-runs';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetRuns);

const PS = '2026-11-01';

describe('POST /billing/rules/simulate (8.2)', () => {
  it('computes a draft version for the flats without storing anything', async () => {
    const w = await runSociety({ flats: 2 });
    const ids = w.units.map(u => u.id);
    const r = await w.c('post', '/billing/rules/simulate', {
      chargeHeadId: w.heads.MAINTENANCE!.id,
      version: { rateType: 'PER_SQFT', ratePerSqftPaise: 350 },
      unitIds: ids,
      periodStart: PS,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.items).toEqual([
      {
        unitId: ids[0],
        unitLabel: 'A-101',
        amountPaise: 402_500,
        computation: expect.objectContaining({ method: 'PER_SQFT' }),
        exceptionCode: null,
      },
      {
        unitId: ids[1],
        unitLabel: 'A-102',
        amountPaise: 402_500,
        computation: expect.objectContaining({ method: 'PER_SQFT' }),
        exceptionCode: null,
      },
    ]);
    const rules = await w.c('get', '/billing/rules');
    expect(rules.body.data).toEqual([]);
  });

  it('reports exceptions per flat, flat and unit-type rates, and a percent of other heads', async () => {
    const w = await runSociety({ flats: 2 });
    await makeRule(w.society.id!, w.heads.MAINTENANCE!, { rateType: 'PER_SQFT', ratePerSqftPaise: 320 });
    const [a, b] = w.units.map(u => u.id);
    const sim = (version: Record<string, unknown>, head = w.heads.WATER!.id) =>
      w.c('post', '/billing/rules/simulate', {
        chargeHeadId: head,
        version,
        unitIds: [a, b],
        periodStart: PS,
      });
    const flat = await sim({ rateType: 'FLAT_PER_UNIT', amountPaise: 35_000 });
    expect(flat.body.data.items.map((i: any) => i.amountPaise)).toEqual([35_000, 35_000]);
    const typ = await sim({ rateType: 'PER_UNIT_TYPE', unitTypeRates: { '2BHK': 5000 } });
    expect(typ.body.data.items.map((i: any) => [i.amountPaise, i.exceptionCode])).toEqual([
      [0, 'MISSING_UNIT_TYPE_RATE'],
      [0, 'MISSING_UNIT_TYPE_RATE'],
    ]);
    const noc = await sim(
      { rateType: 'PERCENT_OF_HEADS', percent: '10.0000', baseChargeHeadIds: [w.heads.MAINTENANCE!.id] },
      w.heads.NOC!.id,
    );
    expect(noc.body.data.items.map((i: any) => i.amountPaise)).toEqual([36_800, 36_800]);
    const none = await sim({ rateType: 'NONE' });
    expect(none.body.data.items.map((i: any) => i.amountPaise)).toEqual([0, 0]);
  });

  it('a fixed split rule gives exact shares; a run-input one cannot be simulated', async () => {
    const w = await runSociety({ flats: 3 });
    for (const u of w.units) await addOwner(w.society.id!, u.id);
    const fixed = await makeSplitRule(w.society.id!, {
      basis: 'EQUAL',
      amountSource: 'FIXED',
      fixedAmountPaise: 100,
    });
    const run = await makeSplitRule(w.society.id!, { basis: 'EQUAL', amountSource: 'RUN_INPUT' });
    const sim = (id: number) =>
      w.c('post', '/billing/rules/simulate', {
        chargeHeadId: w.heads.WATER!.id,
        version: { rateType: 'SPLIT_TOTAL', billSplitRuleId: id },
        unitIds: w.units.map(u => u.id),
        periodStart: PS,
      });
    expect((await sim(fixed.id!)).body.data.items.map((i: any) => i.amountPaise)).toEqual([34, 33, 33]);
    expect((await sim(run.id!)).body.data.items[0]).toMatchObject({
      amountPaise: 0,
      exceptionCode: 'RUN_SPLIT_INPUT_MISSING',
    });
    expect((await sim(99999)).body.code).toBe('SPLIT_RULE_NOT_FOUND');
  });

  it('metered needs a registered meter source and returns the slab amount', async () => {
    const w = await runSociety({ flats: 1 });
    const body = {
      chargeHeadId: w.heads.WATER!.id,
      version: {
        rateType: 'METERED',
        meterType: 'WATER',
        slabs: [
          { uptoMilli: 15_000, ratePaise: 2000 },
          { uptoMilli: null, ratePaise: 3500 },
        ],
        minimumChargePaise: 0,
        missingReadingPolicy: 'EXCEPTION',
      },
      unitIds: [w.units[0]!.id],
      periodStart: PS,
    };
    expect((await w.c('post', '/billing/rules/simulate', body)).body.code).toBe('METER_SOURCE_NOT_AVAILABLE');
    setBillingPorts({
      meters: {
        getSource: () => ({
          consumptionForPeriod: async () =>
            new Map([[w.units[0]!.id, { quantityMilli: 18_400n, readingIds: [1], isEstimated: false }]]),
        }),
      },
    });
    const r = await w.c('post', '/billing/rules/simulate', body);
    expect(r.body.data.items[0].amountPaise).toBe(41_900);
  });

  it('validates the body, checks the head, the flats and the period, and needs the view permission', async () => {
    const w = await runSociety({ flats: 1 });
    const ok = {
      chargeHeadId: w.heads.WATER!.id,
      version: { rateType: 'FLAT_PER_UNIT', amountPaise: 1 },
      unitIds: [w.units[0]!.id],
      periodStart: PS,
    };
    const sim = (b: Record<string, unknown>) => w.c('post', '/billing/rules/simulate', { ...ok, ...b });
    expect((await sim({ version: { rateType: 'FLAT_PER_UNIT' } })).status).toBe(400);
    expect((await sim({ unitIds: [] })).status).toBe(400);
    expect((await sim({ unitIds: Array.from({ length: 21 }, (_, i) => i + 1) })).status).toBe(400);
    expect((await sim({ extra: 1 })).status).toBe(400);
    expect((await sim({ chargeHeadId: 999999 })).body.code).toBe('CHARGE_HEAD_NOT_FOUND');
    expect((await sim({ unitIds: [999999] })).status).toBe(400);
    expect((await sim({ periodStart: '2026-11-02' })).body.code).toBe('RUN_PERIOD_INVALID');
    const nobody = await memberOf(w.society, 'guard').catch(() => null);
    if (nobody) expect((await nobody.c('post', '/billing/rules/simulate', ok)).status).toBe(403);
  });

  it('the route is marked: society, view permission, calculation methods, no idempotency', () => {
    const r = listRoutes(app).find(x => x.path === '/billing/rules/simulate')!;
    expect(r).toMatchObject({
      method: 'POST',
      kind: 'society',
      permissions: ['settings.billing_rules.view'],
      features: ['billing.calculation_methods'],
      idempotent: false,
    });
  });
});
