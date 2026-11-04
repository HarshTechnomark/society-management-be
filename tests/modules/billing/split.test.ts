import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, BillSplitRule, closeDb } from '../../../src/models';
import { splitPaise, splitWeight } from '../../../src/modules/billing/billing.split';
import { adminOf } from '../../helpers/residents';
import { featureOff } from '../../helpers/society-setup';
import {
  billingWorld,
  headId,
  idem,
  postRule,
  resetBillingSetup,
  ruleBody,
} from '../../helpers/billing-setup';

afterAll(closeDb);
beforeEach(resetBillingSetup);

const units = (weights: number[]) => weights.map((w, i) => ({ unitId: i + 1, weight: BigInt(w) }));
const sum = (a: { sharePaise: number }[]) => a.reduce((s, x) => s + x.sharePaise, 0);

describe('splitPaise (BR-11-22; T11-08, T11-09)', () => {
  it('T11-08: 1,000,000 by area 1150 / 1150 / 700 gives 383,334 / 383,333 / 233,333', () => {
    const r = splitPaise(1_000_000, units([1_150_000, 1_150_000, 700_000]));
    expect(r.map(x => x.sharePaise)).toEqual([383_334, 383_333, 233_333]);
    expect(sum(r)).toBe(1_000_000);
  });

  it('the remainder goes to the largest fractional parts; ties by ascending unitId, whatever the input order', () => {
    // 10 / 3 flats: shares 3 3 3, remainder 1, all fractions equal: unit 1 gets it
    const equal = splitPaise(10, units([1, 1, 1]));
    expect(equal.map(x => x.sharePaise)).toEqual([4, 3, 3]);
    const shuffled = splitPaise(10, [
      { unitId: 9, weight: 1n },
      { unitId: 4, weight: 1n },
      { unitId: 7, weight: 1n },
    ]);
    expect(shuffled).toEqual([
      { unitId: 9, sharePaise: 3 },
      { unitId: 4, sharePaise: 4 },
      { unitId: 7, sharePaise: 3 },
    ]);
    // weights 1,2 on 100: 33.33 and 66.67: the larger fraction (66.67 has .67) gets the paisa
    expect(splitPaise(100, units([1, 2])).map(x => x.sharePaise)).toEqual([33, 67]);
  });

  it('a zero weight gets nothing; W = 0 and negative totals are refused', () => {
    expect(splitPaise(100, units([0, 1, 0])).map(x => x.sharePaise)).toEqual([0, 100, 0]);
    expect(splitPaise(0, units([1, 2])).map(x => x.sharePaise)).toEqual([0, 0]);
    expect(() => splitPaise(100, units([0, 0]))).toThrow(/weight/);
    expect(() => splitPaise(100, [])).toThrow(/weight/);
    expect(() => splitPaise(-1, units([1]))).toThrow(/negative/);
  });

  it('handles totals beyond 2^53 / weight without losing paise (bigint)', () => {
    const r = splitPaise(1_000_000_000_000n, units([1_500_000_000, 999_999_999, 1_234_567]));
    expect(r.reduce((s, x) => s + BigInt(x.sharePaise), 0n)).toBe(1_000_000_000_000n);
  });

  it('T11-09 property: shares always add up to T and each differs from the exact share by less than one paisa', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      const n = 1 + rnd(40);
      const weights = Array.from({ length: n }, () => (rnd(5) === 0 ? 0 : 1 + rnd(2_000_000)));
      if (!weights.some(w => w > 0)) weights[0] = 1;
      const total = rnd(2_000_000_000);
      const r = splitPaise(total, units(weights));
      expect(sum(r)).toBe(total);
      const W = weights.reduce((a, b) => a + b, 0);
      r.forEach((x, k) => {
        const exact = (total * weights[k]!) / W;
        expect(Math.abs(x.sharePaise - exact)).toBeLessThan(1);
        if (weights[k] === 0) expect(x.sharePaise).toBe(0);
      });
    }
  });
});

describe('splitWeight (BR-11-22)', () => {
  const u = (
    o: Partial<{ id: number; unitType: string; bhk: string | null; areaSqft: string | null }> = {},
  ) => ({
    id: 501,
    unitType: 'FLAT',
    bhk: '2BHK',
    areaSqft: '1150.500',
    ...o,
  });
  it('EQUAL is 1; AREA is the milli-sq-ft and a flat without area is MISSING_AREA', () => {
    expect(splitWeight('EQUAL', u(), null)).toEqual({ weight: 1n });
    expect(splitWeight('AREA', u(), null)).toEqual({ weight: 1_150_500n });
    expect(splitWeight('AREA', u({ areaSqft: null }), null)).toEqual({ exception: 'MISSING_AREA' });
    expect(splitWeight('AREA', u({ areaSqft: '0.000' }), null)).toEqual({ exception: 'MISSING_AREA' });
  });
  it('UNIT_TYPE_WEIGHT uses bhk before unitType; a missing type is MISSING_UNIT_TYPE_RATE', () => {
    expect(splitWeight('UNIT_TYPE_WEIGHT', u(), { '2BHK': 2, FLAT: 9 })).toEqual({ weight: 2n });
    expect(splitWeight('UNIT_TYPE_WEIGHT', u({ bhk: null }), { '2BHK': 2, FLAT: 9 })).toEqual({ weight: 9n });
    expect(splitWeight('UNIT_TYPE_WEIGHT', u(), { '3BHK': 3 })).toEqual({
      exception: 'MISSING_UNIT_TYPE_RATE',
    });
  });
  it('CUSTOM_WEIGHT uses the unit id; a missing flat has weight 0', () => {
    expect(splitWeight('CUSTOM_WEIGHT', u(), { '501': 3 })).toEqual({ weight: 3n });
    expect(splitWeight('CUSTOM_WEIGHT', u({ id: 7 }), { '501': 3 })).toEqual({ weight: 0n });
  });
});

describe('bill split rules (8.3)', () => {
  const fixed = (over: Record<string, unknown> = {}) => ({
    name: 'Lift AMC – Wing D',
    description: 'Lift contract',
    basis: 'EQUAL',
    amountSource: 'FIXED',
    fixedAmountPaise: 1_000_000,
    ...over,
  });

  it('creates, lists and shows the stored shape; the scope defaults to ALL_UNITS', async () => {
    const w = await billingWorld();
    const r = await w.c('post', '/billing/split-rules', fixed(), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      name: 'Lift AMC – Wing D',
      description: 'Lift contract',
      basis: 'EQUAL',
      amountSource: 'FIXED',
      fixedAmountPaise: 1_000_000,
      scopeType: 'ALL_UNITS',
      scopeValues: null,
      weights: null,
      status: 'ACTIVE',
      version: 1,
    });
    const list = await w.c('get', '/billing/split-rules');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.pagination.total).toBe(1);
    const a = await AuditLog.count({
      where: { societyId: w.society.id!, action: 'billing.split_rule.created' },
    });
    expect(a).toBe(1);
  });

  it('weights: UNIT_TYPE_WEIGHT keys are unit types, CUSTOM_WEIGHT keys are units of the society, values 0 to 1,000,000, one above 0', async () => {
    const w = await billingWorld();
    const other = await billingWorld({ name: 'Green Park CHS' });
    const post = (b: Record<string, unknown>) => w.c('post', '/billing/split-rules', b, { headers: idem() });
    const ok1 = await post(
      fixed({ name: 'By type', basis: 'UNIT_TYPE_WEIGHT', weights: { '2BHK': 2, SHOP: 3 } }),
    );
    expect(ok1.status, JSON.stringify(ok1.body)).toBe(201);
    const ok2 = await post(
      fixed({
        name: 'Custom',
        basis: 'CUSTOM_WEIGHT',
        weights: { [String(w.unit(1).id)]: 3, [String(w.unit(2).id)]: 0 },
      }),
    );
    expect(ok2.status, JSON.stringify(ok2.body)).toBe(201);
    const bad = async (b: Record<string, unknown>) => (await post(b)).status;
    expect(await bad(fixed({ name: 'a1', basis: 'UNIT_TYPE_WEIGHT' }))).toBe(400);
    expect(await bad(fixed({ name: 'a2', basis: 'UNIT_TYPE_WEIGHT', weights: { PALACE: 1 } }))).toBe(400);
    expect(await bad(fixed({ name: 'a3', basis: 'UNIT_TYPE_WEIGHT', weights: { '2BHK': 0 } }))).toBe(400);
    expect(await bad(fixed({ name: 'a4', basis: 'UNIT_TYPE_WEIGHT', weights: { '2BHK': 1_000_001 } }))).toBe(
      400,
    );
    expect(await bad(fixed({ name: 'a5', basis: 'UNIT_TYPE_WEIGHT', weights: { '2BHK': 1.5 } }))).toBe(400);
    expect(await bad(fixed({ name: 'a6', basis: 'CUSTOM_WEIGHT', weights: { abc: 1 } }))).toBe(400);
    expect(
      await bad(fixed({ name: 'a7', basis: 'CUSTOM_WEIGHT', weights: { [String(other.unit(1).id)]: 1 } })),
    ).toBe(400);
    expect(await bad(fixed({ name: 'a8', basis: 'EQUAL', weights: { '2BHK': 1 } }))).toBe(400);
    expect(await bad(fixed({ name: 'a9', basis: 'AREA', weights: { '2BHK': 1 } }))).toBe(400);
  });

  it('amount source: FIXED needs 1 to 1,000,000,000 paise; RUN_INPUT has none; scope shapes as in rules', async () => {
    const w = await billingWorld();
    const post = (b: Record<string, unknown>) => w.c('post', '/billing/split-rules', b, { headers: idem() });
    expect(
      (await post(fixed({ name: 'r1', amountSource: 'RUN_INPUT', fixedAmountPaise: undefined }))).status,
    ).toBe(201);
    expect((await post(fixed({ name: 'r2', amountSource: 'RUN_INPUT' }))).status).toBe(400);
    expect((await post(fixed({ name: 'r3', fixedAmountPaise: undefined }))).status).toBe(400);
    expect((await post(fixed({ name: 'r4', fixedAmountPaise: 0 }))).status).toBe(400);
    expect((await post(fixed({ name: 'r5', fixedAmountPaise: 1_000_000_001 }))).status).toBe(400);
    expect((await post(fixed({ name: 'r6', scopeType: 'BUILDINGS' }))).status).toBe(400);
    expect(
      (await post(fixed({ name: 'r7', scopeType: 'BUILDINGS', scopeValues: [w.buildingId] }))).status,
    ).toBe(201);
    expect((await post(fixed({ name: 'r8', scopeType: 'BUILDINGS', scopeValues: [999_999] }))).status).toBe(
      400,
    );
    expect((await post(fixed({ name: 'r9', scopeType: 'UNIT_TYPES', scopeValues: ['SHOP'] }))).status).toBe(
      201,
    );
    expect((await post(fixed({ name: 'r10', scopeType: 'ALL_UNITS', scopeValues: [1] }))).status).toBe(400);
    expect((await post(fixed({ name: 'r11', unknown: 1 }))).status).toBe(400);
    await featureOff(w.society.id!, 'billing.unit_overrides_and_exemptions');
    expect((await post(fixed({ name: 'r12', scopeType: 'UNITS', scopeValues: [w.unit(1).id] }))).status).toBe(
      402,
    );
  });

  it('SPLIT_RULE_NAME_TAKEN, STALE_VERSION, edits keep the merged shape valid, archived rules are read-only', async () => {
    const w = await billingWorld();
    const a = (await w.c('post', '/billing/split-rules', fixed(), { headers: idem() })).body.data;
    const dup = await w.c('post', '/billing/split-rules', fixed(), { headers: idem() });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SPLIT_RULE_NAME_TAKEN');
    const b = (await w.c('post', '/billing/split-rules', fixed({ name: 'Second' }), { headers: idem() })).body
      .data;
    const rename = await w.c('patch', `/billing/split-rules/${b.id}`, { name: a.name, version: 1 });
    expect(rename.body.code).toBe('SPLIT_RULE_NAME_TAKEN');
    const u = `/billing/split-rules/${a.id}`;
    const ok = await w.c('patch', u, { fixedAmountPaise: 2_000_000, description: null, version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ fixedAmountPaise: 2_000_000, description: null, version: 2 });
    expect((await w.c('patch', u, { name: 'x2', version: 1 })).body.code).toBe('STALE_VERSION');
    // switching to RUN_INPUT drops the fixed amount; switching to a weighted basis needs weights
    const run = await w.c('patch', u, { amountSource: 'RUN_INPUT', version: 2 });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.data.fixedAmountPaise).toBeNull();
    expect((await w.c('patch', u, { basis: 'UNIT_TYPE_WEIGHT', version: 3 })).status).toBe(400);
    const typed = await w.c('patch', u, { basis: 'UNIT_TYPE_WEIGHT', weights: { '2BHK': 2 }, version: 3 });
    expect(typed.status, JSON.stringify(typed.body)).toBe(200);
    const back = await w.c('patch', u, { basis: 'EQUAL', version: 4 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data.weights).toBeNull();
    expect((await w.c('patch', u, { version: 5 })).status).toBe(400);
    expect((await w.c('patch', '/billing/split-rules/999999', { name: 'No', version: 1 })).body.code).toBe(
      'SPLIT_RULE_NOT_FOUND',
    );
    await w.c('delete', u, { reason: 'Contract ended', version: 5 });
    expect((await w.c('patch', u, { name: 'After', version: 6 })).body.code).toBe('INVALID_STATE');
    const audit = await AuditLog.count({
      where: { societyId: w.society.id!, action: 'billing.split_rule.updated' },
    });
    expect(audit).toBe(4);
  });

  it('SPLIT_RULE_IN_USE while an approved version with no end or a future end references it; archived rules leave the default list', async () => {
    const w = await billingWorld();
    const s = (await w.c('post', '/billing/split-rules', fixed(), { headers: idem() })).body.data;
    const rule = await postRule(
      w.c,
      ruleBody(await headId(w.c, 'FINE'), {
        name: 'Lift split',
        firstVersion: {
          rateType: 'SPLIT_TOTAL',
          billSplitRuleId: s.id,
          effectiveFrom: '2026-04-01',
          reason: 'Lift AMC split',
        },
      }),
    );
    const busy = await w.c('delete', `/billing/split-rules/${s.id}`, {
      reason: 'Not needed now',
      version: 1,
    });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('SPLIT_RULE_IN_USE');
    const stop = await w.c(
      'post',
      `/billing/rules/${rule.id}/versions`,
      { rateType: 'NONE', effectiveFrom: '2026-11-01', reason: 'Stop the split' },
      { headers: idem() },
    );
    expect(stop.status).toBe(201);
    const ok = await w.c('delete', `/billing/split-rules/${s.id}`, { reason: 'Not needed now', version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('ARCHIVED');
    expect((await w.c('get', '/billing/split-rules')).body.data).toEqual([]);
    expect(
      (await w.c('get', '/billing/split-rules', undefined, { query: { status: 'ALL' } })).body.data,
    ).toHaveLength(1);
    expect(
      (await w.c('delete', `/billing/split-rules/${s.id}`, { reason: 'Not needed now', version: 2 })).body
        .code,
    ).toBe('INVALID_STATE');
    // an archived split rule cannot be used by a new version
    const again = await w.c(
      'post',
      `/billing/rules/${rule.id}/versions`,
      { rateType: 'SPLIT_TOTAL', billSplitRuleId: s.id, effectiveFrom: '2026-12-01', reason: 'Use it again' },
      { headers: idem() },
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE');
  });

  it('access: view-only reads, other societies get 404, the plan gates the routes', async () => {
    const w = await billingWorld();
    const s = (await w.c('post', '/billing/split-rules', fixed(), { headers: idem() })).body.data;
    const sec = await adminOf(w.society, 'secretary');
    expect((await sec.c('get', '/billing/split-rules')).status).toBe(200);
    expect(
      (await sec.c('post', '/billing/split-rules', fixed({ name: 'No' }), { headers: idem() })).status,
    ).toBe(403);
    const b = await billingWorld({ name: 'Green Park CHS' });
    for (const r of [
      await b.c('patch', `/billing/split-rules/${s.id}`, { name: 'Hack', version: 1 }),
      await b.c('delete', `/billing/split-rules/${s.id}`, { reason: 'Hacking', version: 1 }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('SPLIT_RULE_NOT_FOUND');
    }
    await featureOff(w.society.id!, 'billing.calculation_methods');
    expect(
      (await w.c('post', '/billing/split-rules', fixed({ name: 'Blocked' }), { headers: idem() })).body.code,
    ).toBe('FEATURE_NOT_IN_PLAN');
    expect(await BillSplitRule.count({ where: { societyId: w.society.id! } })).toBe(1);
  });
});
