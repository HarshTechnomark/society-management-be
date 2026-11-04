import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BillingRule, ChargeHead, LateFeePolicy, Society, closeDb } from '../../../src/models';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { seedBillingSetup } from '../../../seeders/billing-setup';
import { app } from '../../helpers/auth';
import { billingWorld, resetBillingSetup } from '../../helpers/billing-setup';

afterAll(closeDb);
beforeEach(resetBillingSetup);

describe('route registry of 11.1 (section 2, 8)', () => {
  it('every route has a society marker, the permission, the entitlements and the idempotency marker of the spec', () => {
    const routes = listRoutes(app).filter(
      r =>
        r.path.startsWith('/billing/charge-heads') ||
        r.path.startsWith('/billing/rules') ||
        r.path.startsWith('/billing/split-rules') ||
        r.path.startsWith('/billing/late-fee-policies'),
    );
    const found = Object.fromEntries(routes.map(r => [`${r.method} ${r.path}`, r]));
    const V = 'settings.billing_rules.view';
    const E = 'settings.billing_rules.edit';
    const ch = 'billing.charge_head_master';
    const vr = 'billing.versioned_billing_rules';
    const cm = 'billing.calculation_methods';
    const lf = 'billing.late_fee_and_interest';
    const expected: Record<string, [string, string[], boolean]> = {
      'GET /billing/charge-heads': [V, [ch], false],
      'POST /billing/charge-heads': [E, [ch], true],
      'PATCH /billing/charge-heads/:id': [E, [ch], false],
      'DELETE /billing/charge-heads/:id': [E, [ch], false],
      'GET /billing/rules': [V, [vr], false],
      'GET /billing/rules/:id': [V, [vr], false],
      'POST /billing/rules': [E, [vr, cm], true],
      'PATCH /billing/rules/:id': [E, [vr, cm], false],
      'DELETE /billing/rules/:id': [E, [vr, cm], false],
      'POST /billing/rules/:id/versions': [E, [vr, cm], true],
      'GET /billing/split-rules': [V, [cm], false],
      'POST /billing/split-rules': [E, [cm], true],
      'PATCH /billing/split-rules/:id': [E, [cm], false],
      'DELETE /billing/split-rules/:id': [E, [cm], false],
      'GET /billing/late-fee-policies': [V, [lf], false],
      'POST /billing/late-fee-policies': [E, [lf], true],
    };
    expect(Object.keys(found).sort()).toEqual(Object.keys(expected).sort());
    for (const [k, [perm, features, idempotent]] of Object.entries(expected))
      expect(found[k], k).toMatchObject({
        kind: 'society',
        permissions: [perm],
        features,
        idempotent,
        stepUp: false,
      });
  });
});

describe('every id route answers 404 with the module code for another society (T11-40, section 13)', () => {
  it('heads, rules, split rules and their sub-routes', async () => {
    const a = await billingWorld();
    const b = await billingWorld({ name: 'Green Park CHS' });
    const head = (await a.c('get', '/billing/charge-heads', undefined, { query: { q: 'WATER' } })).body
      .data[0];
    const rule = (
      await a.c(
        'post',
        '/billing/rules',
        {
          chargeHeadId: head.id,
          name: 'Water',
          scopeType: 'ALL_UNITS',
          firstVersion: {
            rateType: 'FLAT_PER_UNIT',
            amountPaise: 35_000,
            effectiveFrom: '2026-04-01',
            reason: 'AGM rate',
          },
        },
        { headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' } },
      )
    ).body.data;
    const split = (
      await a.c(
        'post',
        '/billing/split-rules',
        { name: 'Lift', basis: 'EQUAL', amountSource: 'RUN_INPUT' },
        { headers: { 'Idempotency-Key': '22222222-2222-4222-8222-222222222222' } },
      )
    ).body.data;
    const idem = { headers: { 'Idempotency-Key': '33333333-3333-4333-8333-333333333333' } };
    const checks: [any, string][] = [
      [
        await b.c('patch', `/billing/charge-heads/${head.id}`, { name: 'Hack', version: 1 }),
        'CHARGE_HEAD_NOT_FOUND',
      ],
      [
        await b.c('delete', `/billing/charge-heads/${head.id}`, { reason: 'Hacking', version: 1 }),
        'CHARGE_HEAD_NOT_FOUND',
      ],
      [await b.c('get', `/billing/rules/${rule.id}`), 'RULE_NOT_FOUND'],
      [await b.c('patch', `/billing/rules/${rule.id}`, { name: 'Hack', version: 1 }), 'RULE_NOT_FOUND'],
      [await b.c('delete', `/billing/rules/${rule.id}`, { reason: 'Hacking', version: 1 }), 'RULE_NOT_FOUND'],
      [
        await b.c(
          'post',
          `/billing/rules/${rule.id}/versions`,
          { rateType: 'NONE', effectiveFrom: '2027-04-01', reason: 'Hacking' },
          idem,
        ),
        'RULE_NOT_FOUND',
      ],
      [
        await b.c('patch', `/billing/split-rules/${split.id}`, { name: 'Hack', version: 1 }),
        'SPLIT_RULE_NOT_FOUND',
      ],
      [
        await b.c('delete', `/billing/split-rules/${split.id}`, { reason: 'Hacking', version: 1 }),
        'SPLIT_RULE_NOT_FOUND',
      ],
    ];
    for (const [r, code] of checks) {
      expect(r.status, code).toBe(404);
      expect(r.body.code).toBe(code);
    }
    // another society's head cannot be named in a rule, nor a split rule in a version
    const foreignHead = await b.c(
      'post',
      '/billing/rules',
      {
        chargeHeadId: head.id,
        name: 'Water',
        scopeType: 'ALL_UNITS',
        firstVersion: { rateType: 'NONE', effectiveFrom: '2026-04-01', reason: 'Foreign head' },
      },
      { headers: { 'Idempotency-Key': '44444444-4444-4444-8444-444444444444' } },
    );
    expect(foreignHead.body.code).toBe('CHARGE_HEAD_NOT_FOUND');
    const bHead = (await b.c('get', '/billing/charge-heads', undefined, { query: { q: 'FINE' } })).body
      .data[0];
    const foreignSplit = await b.c(
      'post',
      '/billing/rules',
      {
        chargeHeadId: bHead.id,
        name: 'Fine',
        scopeType: 'ALL_UNITS',
        firstVersion: {
          rateType: 'SPLIT_TOTAL',
          billSplitRuleId: split.id,
          effectiveFrom: '2026-04-01',
          reason: 'Foreign split',
        },
      },
      { headers: { 'Idempotency-Key': '55555555-5555-4555-8555-555555555555' } },
    );
    expect(foreignSplit.body.code).toBe('SPLIT_RULE_NOT_FOUND');
  });
});

describe('demo seed of 11.1 (7.13)', () => {
  it('seeds the heads for the demo societies and the rules for Sky Heights and Green Park; running it again changes nothing', async () => {
    const mk = async (slug: string, name: string) => {
      const w = await billingWorld({ name });
      await Society.update({ slug }, { where: { id: w.society.id! } });
      return w.society.id!;
    };
    const [sky, green, tulip] = [
      await mk('sky-heights', 'Sky Heights CHS'),
      await mk('green-park', 'Green Park CHS'),
      await mk('tulip-gardens', 'Tulip Gardens CHS'),
    ];
    const first = await seedBillingSetup();
    expect(first.rules).toHaveLength(6);
    for (const id of [sky, green, tulip])
      expect(await ChargeHead.count({ where: { societyId: id } })).toBe(30);
    expect(await BillingRule.count({ where: { societyId: sky } })).toBe(3);
    expect(await BillingRule.count({ where: { societyId: green } })).toBe(3);
    expect(await BillingRule.count({ where: { societyId: tulip } })).toBe(0);
    // setup mode: the rules are approved and the first policy comes from the module 08 defaults (18 per cent, 5 grace days)
    const policy = await LateFeePolicy.findOne({ where: { societyId: sky } });
    expect(policy).toMatchObject({
      policyType: 'SIMPLE_INTEREST',
      interestRatePct: '18.0000',
      graceDays: 5,
      status: 'ACTIVE',
    });
    expect(await LateFeePolicy.count({ where: { societyId: tulip } })).toBe(0);
    const second = await seedBillingSetup();
    expect(second.rules).toEqual([]);
    expect(second.heads).toEqual([]);
    expect(second.skipped).toHaveLength(6);
    expect(await BillingRule.count({ where: { societyId: sky } })).toBe(3);
    expect(await ChargeHead.count({ where: { societyId: sky } })).toBe(30);
  });
});
