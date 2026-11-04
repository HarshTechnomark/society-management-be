import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, BillingRuleVersion, closeDb } from '../../../src/models';
import {
  billingPortCalls,
  setBillingPorts,
  placeholderApprovalTypes,
} from '../../../src/modules/billing/billing.ports';
import { approve, reject } from '../../../src/modules/billing/billing.rules.approvals-hook';
import { meterSources } from '../../../src/modules/billing/billing.public';
import { systemCtx } from '../../../src/types/context';
import { adminOf } from '../../helpers/residents';
import { featureOff, makeUnit } from '../../helpers/society-setup';
import {
  billingWorld,
  headId,
  idem,
  issuedRun,
  perSqft,
  postRule,
  postVersion,
  resetBillingSetup,
  ruleBody,
  setSetting,
} from '../../helpers/billing-setup';

afterAll(closeDb);
beforeEach(resetBillingSetup);

const flat = (amountPaise: number, over: Record<string, unknown> = {}) => ({
  rateType: 'FLAT_PER_UNIT',
  amountPaise,
  effectiveFrom: '2026-04-01',
  reason: 'AGM resolution',
  ...over,
});

/** A world with one maintenance rule (setup mode) and the setup mode ended by an issued October run. */
async function liveWorld() {
  const w = await billingWorld();
  const head = await headId(w.c, 'MAINTENANCE');
  const rule = await postRule(w.c, ruleBody(head));
  await issuedRun(w.society.id!);
  return { w, head, rule };
}

describe('billing rules: create and setup mode (BR-11-21, US-11-01)', () => {
  it('creates a rule with version 1; in setup mode the version is approved at once (audit reason SETUP_MODE)', async () => {
    const w = await billingWorld();
    const head = await headId(w.c, 'MAINTENANCE');
    const r = await w.c('post', '/billing/rules', ruleBody(head), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.message).toBe('Billing rule created');
    const rule = r.body.data;
    expect(rule).toMatchObject({
      chargeHeadId: head,
      chargeHead: { key: 'MAINTENANCE' },
      name: 'Maintenance – all flats',
      scopeType: 'ALL_UNITS',
      scopeValues: null,
      status: 'ACTIVE',
      version: 1,
      nextVersion: null,
      pendingVersion: null,
    });
    expect(rule.currentVersion).toMatchObject({
      versionNo: 1,
      rateType: 'PER_SQFT',
      ratePerSqftPaise: 320,
      amountPaise: null,
      effectiveFrom: '2026-04-01',
      effectiveTo: null,
      status: 'APPROVED',
      approvalRequestId: null,
      reason: 'AGM resolution 4 of 2026',
    });
    expect(rule.currentVersion.approvedBy).toBe(w.user.id);
    expect(rule.versions).toHaveLength(1);
    expect(billingPortCalls.filter(c => c.fn === 'approvals.request')).toHaveLength(0);
    const a = await AuditLog.findAll({
      where: { societyId: w.society.id!, action: 'billing.rule_version.approved' },
    });
    expect(a).toHaveLength(1);
    expect(a[0]!.reason).toBe('SETUP_MODE');
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'billing.rule.created' } }),
    ).toBe(1);
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'billing.rule_version.created' } }),
    ).toBe(1);
  });

  it('BR-11-51: the first approved rule of setup mode creates the first late fee policy from the module 08 defaults', async () => {
    const w = await billingWorld();
    await setSetting(w.society.id!, 'billing.lateFeeDefaultRatePct', '12.5000');
    await setSetting(w.society.id!, 'billing.lateFeeGraceDays', 7);
    await postRule(w.c, ruleBody(await headId(w.c, 'MAINTENANCE')));
    await postRule(w.c, ruleBody(await headId(w.c, 'WATER'), { name: 'Water', firstVersion: flat(35_000) }));
    const p = await w.c('get', '/billing/late-fee-policies');
    expect(p.body.data).toHaveLength(1);
    expect(p.body.data[0]).toMatchObject({
      policyType: 'SIMPLE_INTEREST',
      interestRatePct: '12.5000',
      interestFrom: 'DUE_DATE',
      graceDays: 7,
      effectiveFrom: '2026-04-01',
      status: 'ACTIVE',
    });
  });

  it('the rule needs a head of the society (404), a usable head (archived 422, system 422) and a unique name (409)', async () => {
    const w = await billingWorld();
    const head = await headId(w.c, 'MAINTENANCE');
    expect((await postRule(w.c, ruleBody(999_999), null)).body.code).toBe('CHARGE_HEAD_NOT_FOUND');
    const sys = await postRule(w.c, ruleBody(await headId(w.c, 'INTEREST')), null);
    expect(sys.status).toBe(422);
    expect(sys.body.code).toBe('RATE_TYPE_NOT_ALLOWED');
    await postRule(w.c, ruleBody(head));
    const dup = await postRule(
      w.c,
      ruleBody(head, { scopeType: 'BUILDINGS', scopeValues: [w.buildingId] }),
      null,
    );
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('RULE_NAME_TAKEN');
  });

  it('strict validation: unknown fields, fields of another rate type, ranges and scope shapes are 400', async () => {
    const w = await billingWorld();
    const head = await headId(w.c, 'MAINTENANCE');
    const bad = async (over: Record<string, unknown>, ver: Record<string, unknown> = {}) => {
      const r = await postRule(w.c, ruleBody(head, { ...over, firstVersion: perSqft(ver) }), null);
      return [r.status, r.body.code];
    };
    expect(await bad({ extra: 1 })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({}, { amountPaise: 100 })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({}, { ratePerSqftPaise: 0 })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({}, { ratePerSqftPaise: 100_001 })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({}, { reason: 'abc' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({}, { effectiveFrom: '2026-13-01' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({ scopeValues: [1] })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({ scopeType: 'BUILDINGS' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({ scopeType: 'UNIT_TYPES', scopeValues: ['CASTLE'] })).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(await bad({ scopeType: 'BUILDINGS', scopeValues: [w.buildingId, w.buildingId] })).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(await bad({ scopeType: 'BUILDINGS', scopeValues: [999_999] })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await bad({ scopeType: 'UNITS', scopeValues: [999_999] })).toEqual([400, 'VALIDATION_FAILED']);
    const noType = await postRule(
      w.c,
      ruleBody(head, { firstVersion: { effectiveFrom: '2026-04-01', reason: 'No type here' } }),
      null,
    );
    expect(noType.status).toBe(400);
  });
});

describe('billing rules: rate payloads (F03, BR-11-17 to BR-11-19)', () => {
  it('accepts every rate type with its own fields and stores the other rate columns as NULL', async () => {
    const w = await billingWorld();
    const split = (
      await w.c(
        'post',
        '/billing/split-rules',
        { name: 'Lift AMC', basis: 'EQUAL', amountSource: 'FIXED', fixedAmountPaise: 1_000_000 },
        { headers: idem() },
      )
    ).body.data;
    const maint = await headId(w.c, 'MAINTENANCE');
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['FLAT_PER_UNIT', flat(0), { amountPaise: 0 }],
      [
        'PER_UNIT_TYPE',
        {
          rateType: 'PER_UNIT_TYPE',
          unitTypeRates: { '2BHK': 250_000, SHOP: 0 },
          effectiveFrom: '2026-04-01',
          reason: 'By type',
        },
        { unitTypeRates: { '2BHK': 250_000, SHOP: 0 } },
      ],
      [
        'SPLIT_TOTAL',
        { rateType: 'SPLIT_TOTAL', billSplitRuleId: split.id, effectiveFrom: '2026-04-01', reason: 'Split' },
        { billSplitRuleId: split.id },
      ],
      [
        'PERCENT_OF_HEADS',
        {
          rateType: 'PERCENT_OF_HEADS',
          percent: '7.5',
          baseChargeHeadIds: [maint],
          effectiveFrom: '2026-04-01',
          reason: 'Percent',
        },
        { percent: '7.5000', baseChargeHeadIds: [maint] },
      ],
      ['NONE', { rateType: 'NONE', effectiveFrom: '2026-04-01', reason: 'Stopped' }, {}],
    ];
    const heads = ['FESTIVAL', 'FINE', 'AMENITY_BOOKING', 'CHARGEABLE_WORK', 'ACCESS_CARD_FEE'];
    for (const [i, [type, version, expected]] of cases.entries()) {
      const rule = await postRule(
        w.c,
        ruleBody(await headId(w.c, heads[i]!), { name: `Rule ${type}`, firstVersion: version }),
      );
      expect(rule.currentVersion.rateType).toBe(type);
      expect(rule.currentVersion).toMatchObject(expected);
    }
    const row = await BillingRuleVersion.findOne({ where: { rateType: 'FLAT_PER_UNIT' } });
    expect(row!.ratePerSqftPaise).toBeNull();
    expect(row!.unitTypeRates).toBeNull();
  });

  it('PER_UNIT_TYPE keys must be unit types or BHK values', async () => {
    const w = await billingWorld();
    const r = await postRule(
      w.c,
      ruleBody(await headId(w.c, 'MAINTENANCE'), {
        firstVersion: {
          rateType: 'PER_UNIT_TYPE',
          unitTypeRates: { PALACE: 1 },
          effectiveFrom: '2026-04-01',
          reason: 'Bad key',
        },
      }),
      null,
    );
    expect(r.status).toBe(400);
  });

  it('T11-44: a Starter society cannot create a METERED version; a registered meter source is needed otherwise', async () => {
    const slabs = [
      { uptoMilli: 15_000, ratePaise: 2000 },
      { uptoMilli: null, ratePaise: 3500 },
    ];
    const version = {
      rateType: 'METERED',
      meterType: 'WATER',
      slabs,
      minimumChargePaise: 10_000,
      missingReadingPolicy: 'EXCEPTION',
      effectiveFrom: '2026-04-01',
      reason: 'Metered water',
    };
    const starter = await billingWorld({ plan: 'STARTER' });
    const s = await postRule(
      starter.c,
      ruleBody(await headId(starter.c, 'WATER'), { name: 'Water', firstVersion: version }),
      null,
    );
    expect(s.status).toBe(402);
    expect(s.body.code).toBe('FEATURE_NOT_IN_PLAN');
    const w = await billingWorld({ name: 'Green Park CHS' });
    const head = await headId(w.c, 'WATER');
    const none = await postRule(w.c, ruleBody(head, { name: 'Water', firstVersion: version }), null);
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('METER_SOURCE_NOT_AVAILABLE');
    meterSources.register('WATER', { consumptionForPeriod: async () => new Map() });
    const ok = await postRule(w.c, ruleBody(head, { name: 'Water', firstVersion: version }), null);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.currentVersion.slabs).toEqual(slabs);
  });

  it('METERED slabs: ascending limits, only the last open, between 1 and 10', async () => {
    const w = await billingWorld();
    meterSources.register('WATER', { consumptionForPeriod: async () => new Map() });
    const head = await headId(w.c, 'WATER');
    const slabsOf = (slabs: unknown) =>
      ruleBody(head, {
        name: `W${Math.random()}`,
        firstVersion: {
          rateType: 'METERED',
          meterType: 'WATER',
          slabs,
          minimumChargePaise: 0,
          missingReadingPolicy: 'MINIMUM_CHARGE',
          effectiveFrom: '2026-04-01',
          reason: 'Metered',
        },
      });
    for (const slabs of [
      [],
      [{ uptoMilli: 5000, ratePaise: 1 }],
      [
        { uptoMilli: null, ratePaise: 1 },
        { uptoMilli: null, ratePaise: 2 },
      ],
      [
        { uptoMilli: 9000, ratePaise: 1 },
        { uptoMilli: 9000, ratePaise: 2 },
        { uptoMilli: null, ratePaise: 3 },
      ],
      [
        { uptoMilli: 9000, ratePaise: 1 },
        { uptoMilli: 5000, ratePaise: 2 },
        { uptoMilli: null, ratePaise: 3 },
      ],
      [
        { uptoMilli: 0, ratePaise: 1 },
        { uptoMilli: null, ratePaise: 3 },
      ],
      Array.from({ length: 11 }, (_, i) => ({ uptoMilli: i < 10 ? (i + 1) * 1000 : null, ratePaise: 1 })),
    ])
      expect((await postRule(w.c, slabsOf(slabs), null)).status, JSON.stringify(slabs)).toBe(400);
    expect((await postRule(w.c, slabsOf([{ uptoMilli: null, ratePaise: 1 }]), null)).status).toBe(201);
  });

  it('BR-11-18: non-occupancy charges are PERCENT_OF_HEADS or NONE, at most 10 percent, on maintenance heads only', async () => {
    const w = await billingWorld();
    const noc = await headId(w.c, 'NON_OCCUPANCY');
    const maint = await headId(w.c, 'MAINTENANCE');
    const pct = (percent: string, base: number[]) => ({
      rateType: 'PERCENT_OF_HEADS',
      percent,
      baseChargeHeadIds: base,
      effectiveFrom: '2026-04-01',
      reason: 'Non-occupancy',
    });
    const flatNoc = await postRule(w.c, ruleBody(noc, { name: 'NOC', firstVersion: flat(5000) }), null);
    expect(flatNoc.status).toBe(422);
    expect(flatNoc.body.code).toBe('RATE_TYPE_NOT_ALLOWED');
    const cap = await postRule(
      w.c,
      ruleBody(noc, { name: 'NOC', firstVersion: pct('10.0001', [maint]) }),
      null,
    );
    expect(cap.status).toBe(422);
    expect(cap.body.code).toBe('NOC_CAP_EXCEEDED');
    const sinking = await headId(w.c, 'SINKING_FUND');
    const base = await postRule(
      w.c,
      ruleBody(noc, { name: 'NOC', firstVersion: pct('10', [sinking]) }),
      null,
    );
    expect(base.status).toBe(422);
    expect(base.body.code).toBe('RATE_TYPE_NOT_ALLOWED');
    const ok = await postRule(
      w.c,
      ruleBody(noc, { name: 'NOC', firstVersion: pct('10.0000', [maint]) }),
      null,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.currentVersion.percent).toBe('10.0000');
    const stop = await postVersion(
      w.c,
      ok.body.data.id,
      { rateType: 'NONE', effectiveFrom: '2026-12-01', reason: 'Stop the charge' },
      null,
    );
    expect(stop.status).toBe(201);
  });

  it('BR-11-19: no chains: a head cannot be its own base nor use a percent or split-total head as base', async () => {
    const w = await billingWorld();
    const pct = (base: number[]) => ({
      rateType: 'PERCENT_OF_HEADS',
      percent: '5.0000',
      baseChargeHeadIds: base,
      effectiveFrom: '2026-04-01',
      reason: 'Percent rule',
    });
    const parking = await headId(w.c, 'PARKING');
    const maint = await headId(w.c, 'MAINTENANCE');
    const water = await headId(w.c, 'WATER');
    const self = await postRule(
      w.c,
      ruleBody(parking, { name: 'Parking %', firstVersion: pct([parking]) }),
      null,
    );
    expect(self.body.code).toBe('RATE_TYPE_NOT_ALLOWED');
    await postRule(w.c, ruleBody(parking, { name: 'Parking %', firstVersion: pct([maint]) }));
    const chain = await postRule(
      w.c,
      ruleBody(water, { name: 'Water %', firstVersion: pct([parking]) }),
      null,
    );
    expect(chain.status).toBe(422);
    expect(chain.body.code).toBe('RATE_TYPE_NOT_ALLOWED');
    const split = (
      await w.c(
        'post',
        '/billing/split-rules',
        { name: 'Lift AMC', basis: 'EQUAL', amountSource: 'FIXED', fixedAmountPaise: 100_000 },
        { headers: idem() },
      )
    ).body.data;
    const fine = await headId(w.c, 'FINE');
    await postRule(
      w.c,
      ruleBody(fine, {
        name: 'Fine split',
        firstVersion: {
          rateType: 'SPLIT_TOTAL',
          billSplitRuleId: split.id,
          effectiveFrom: '2026-04-01',
          reason: 'Split',
        },
      }),
    );
    const chain2 = await postRule(
      w.c,
      ruleBody(water, { name: 'Water % 2', firstVersion: pct([fine]) }),
      null,
    );
    expect(chain2.body.code).toBe('RATE_TYPE_NOT_ALLOWED');
    const unknown = await postRule(
      w.c,
      ruleBody(water, { name: 'Water % 3', firstVersion: pct([999_999]) }),
      null,
    );
    expect(unknown.body.code).toBe('CHARGE_HEAD_NOT_FOUND');
    const dup = await postRule(
      w.c,
      ruleBody(water, { name: 'Water % 4', firstVersion: pct([maint, maint]) }),
      null,
    );
    expect(dup.status).toBe(400);
  });

  it('SPLIT_TOTAL needs an active split rule of the society (404 SPLIT_RULE_NOT_FOUND)', async () => {
    const w = await billingWorld();
    const r = await postRule(
      w.c,
      ruleBody(await headId(w.c, 'FINE'), {
        name: 'Fine split',
        firstVersion: {
          rateType: 'SPLIT_TOTAL',
          billSplitRuleId: 4242,
          effectiveFrom: '2026-04-01',
          reason: 'Split',
        },
      }),
      null,
    );
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('SPLIT_RULE_NOT_FOUND');
  });
});

describe('billing rules: scope (BR-11-14, BR-11-15)', () => {
  it('two active rules of one head and one scope type may not share a value (RULE_SCOPE_OVERLAP); other scope types may', async () => {
    const w = await billingWorld();
    const head = await headId(w.c, 'MAINTENANCE');
    await postRule(w.c, ruleBody(head));
    const all = await postRule(w.c, ruleBody(head, { name: 'Second all' }), null);
    expect(all.status).toBe(409);
    expect(all.body.code).toBe('RULE_SCOPE_OVERLAP');
    const b1 = await postRule(
      w.c,
      ruleBody(head, { name: 'Tower A', scopeType: 'BUILDINGS', scopeValues: [w.buildingId] }),
    );
    const b2 = await postRule(
      w.c,
      ruleBody(head, { name: 'Tower A again', scopeType: 'BUILDINGS', scopeValues: [w.buildingId] }),
      null,
    );
    expect(b2.body.code).toBe('RULE_SCOPE_OVERLAP');
    await postRule(
      w.c,
      ruleBody(head, { name: 'Shops', scopeType: 'UNIT_TYPES', scopeValues: ['SHOP', '2BHK'] }),
    );
    const t2 = await postRule(
      w.c,
      ruleBody(head, { name: 'Shops 2', scopeType: 'UNIT_TYPES', scopeValues: ['2BHK'] }),
      null,
    );
    expect(t2.body.code).toBe('RULE_SCOPE_OVERLAP');
    const u1 = await postRule(
      w.c,
      ruleBody(head, {
        name: 'Exempt A-101',
        scopeType: 'UNITS',
        scopeValues: [w.unit(1).id],
        firstVersion: flat(0),
      }),
    );
    expect(u1.currentVersion.amountPaise).toBe(0);
    const u2 = await postRule(
      w.c,
      ruleBody(head, { name: 'Override', scopeType: 'UNITS', scopeValues: [w.unit(2).id, w.unit(1).id] }),
      null,
    );
    expect(u2.body.code).toBe('RULE_SCOPE_OVERLAP');
    // an archived rule no longer blocks (never approved: post-setup rules only), so archive through a pending one is tested below
    void b1;
  });

  it('UNITS scope needs billing.unit_overrides_and_exemptions; units must be active units of the society', async () => {
    const w = await billingWorld();
    const head = await headId(w.c, 'PARKING');
    const other = await billingWorld({ name: 'Green Park CHS' });
    const foreign = await postRule(
      w.c,
      ruleBody(head, { name: 'Foreign', scopeType: 'UNITS', scopeValues: [other.unit(1).id] }),
      null,
    );
    expect(foreign.status).toBe(400);
    await featureOff(w.society.id!, 'billing.unit_overrides_and_exemptions');
    const r = await postRule(
      w.c,
      ruleBody(head, { name: 'Exempt', scopeType: 'UNITS', scopeValues: [w.unit(1).id] }),
      null,
    );
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('FEATURE_NOT_IN_PLAN');
  });

  it('PATCH: rename and reorder; scope changes only while no version is approved (BR-11-15, RULE_IN_USE)', async () => {
    const { w, rule } = await liveWorld();
    const u = `/billing/rules/${rule.id}`;
    const ok = await w.c('patch', u, { name: 'Maintenance (all)', sortOrder: 3, version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Maintenance (all)', sortOrder: 3, version: 2 });
    const stale = await w.c('patch', u, { name: 'Again', version: 1 });
    expect(stale.body.code).toBe('STALE_VERSION');
    const scope = await w.c('patch', u, { scopeType: 'BUILDINGS', scopeValues: [w.buildingId], version: 2 });
    expect(scope.status).toBe(409);
    expect(scope.body.code).toBe('RULE_IN_USE');
    expect((await w.c('patch', u, { version: 2 })).status).toBe(400);
    expect((await w.c('patch', u, { scopeValues: [1], version: 2 })).status).toBe(400);
    expect((await w.c('patch', '/billing/rules/999999', { name: 'No', version: 1 })).body.code).toBe(
      'RULE_NOT_FOUND',
    );
  });

  it('a rule whose version waits for approval can still change scope and be archived (cancelling the approval)', async () => {
    const w = await billingWorld();
    await issuedRun(w.society.id!);
    const head = await headId(w.c, 'PARKING');
    const rule = await postRule(
      w.c,
      ruleBody(head, { name: 'Parking', firstVersion: flat(50_000, { effectiveFrom: '2026-12-01' }) }),
    );
    expect(rule.currentVersion).toBeNull();
    expect(rule.pendingVersion).toMatchObject({ status: 'PENDING_APPROVAL', versionNo: 1 });
    const u = `/billing/rules/${rule.id}`;
    const scope = await w.c('patch', u, { scopeType: 'BUILDINGS', scopeValues: [w.buildingId], version: 1 });
    expect(scope.status, JSON.stringify(scope.body)).toBe(200);
    expect(scope.body.data).toMatchObject({ scopeType: 'BUILDINGS', scopeValues: [w.buildingId] });
    const del = await w.c('delete', u, { reason: 'Created by mistake', version: 2 });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.data.status).toBe('ARCHIVED');
    expect(del.body.data.versions[0]).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'The rule was archived',
    });
    expect(billingPortCalls.some(c => c.fn === 'approvals.cancel')).toBe(true);
    expect((await w.c('delete', u, { reason: 'Created by mistake', version: 3 })).body.code).toBe(
      'INVALID_STATE',
    );
    // its scope is free again
    expect(
      (
        await postRule(
          w.c,
          ruleBody(head, {
            name: 'Parking 2',
            scopeType: 'BUILDINGS',
            scopeValues: [w.buildingId],
            firstVersion: flat(50_000, { effectiveFrom: '2026-12-01' }),
          }),
          null,
        )
      ).status,
    ).toBe(201);
  });

  it('DELETE of a rule with an approved version is 409 RULE_IN_USE', async () => {
    const { w, rule } = await liveWorld();
    const r = await w.c('delete', `/billing/rules/${rule.id}`, { reason: 'Wrong rule', version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RULE_IN_USE');
  });
});

describe('billing rules: versions and effective dates (BR-11-20, BR-11-21, US-11-02)', () => {
  it('T11-15: after setup mode a new version is PENDING_APPROVAL with a BILLING_RULE_CHANGE request; approval closes the previous version', async () => {
    const { w, rule } = await liveWorld();
    const v = await w.c(
      'post',
      `/billing/rules/${rule.id}/versions`,
      perSqft({ ratePerSqftPaise: 350, effectiveFrom: '2027-04-01', reason: 'AGM resolution 4 of 2026' }),
      { headers: idem() },
    );
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.message).toBe('Rule change sent for approval');
    expect(v.body.data).toMatchObject({
      billingRuleId: rule.id,
      versionNo: 2,
      rateType: 'PER_SQFT',
      ratePerSqftPaise: 350,
      effectiveFrom: '2027-04-01',
      effectiveTo: null,
      status: 'PENDING_APPROVAL',
      reason: 'AGM resolution 4 of 2026',
    });
    expect(typeof v.body.data.approvalRequestId).toBe('number');
    const call = billingPortCalls.find(c => c.fn === 'approvals.request')!;
    expect(call.input).toMatchObject({
      type: 'BILLING_RULE_CHANGE',
      entityType: 'billing_rule_version',
      entityId: v.body.data.id,
      title: 'Maintenance (service charges): ₹3.20 per sq ft → ₹3.50 per sq ft from 2027-04-01',
      payload: { ruleId: rule.id, rateType: 'PER_SQFT', effectiveFrom: '2027-04-01' },
    });
    expect(placeholderApprovalTypes.has('BILLING_RULE_CHANGE')).toBe(true);
    const mid = await w.c('get', `/billing/rules/${rule.id}`);
    expect(mid.body.data.currentVersion.versionNo).toBe(1);
    expect(mid.body.data.pendingVersion.versionNo).toBe(2);
    expect(mid.body.data.nextVersion).toBeNull();

    const done = await approve(v.body.data.approvalRequestId, systemCtx('approver'));
    expect(done).toMatchObject({ type: 'BILLING_RULE_CHANGE', entityId: v.body.data.id, status: 'APPROVED' });
    const after = (await w.c('get', `/billing/rules/${rule.id}`)).body.data;
    expect(after.pendingVersion).toBeNull();
    expect(after.nextVersion).toMatchObject({ versionNo: 2, status: 'APPROVED', effectiveTo: null });
    expect(after.currentVersion).toMatchObject({ versionNo: 1, effectiveTo: '2027-03-31' });
    expect(after.versions.map((x: any) => x.versionNo)).toEqual([2, 1]);
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'billing.rule_version.approved' } }),
    ).toBe(2);
    expect(await approve(v.body.data.approvalRequestId, systemCtx('approver'))).toMatchObject({
      status: 'APPROVED',
    }); // repeat is a no-op
  });

  it('rejection marks the version REJECTED with the reason and frees the rule for a new version', async () => {
    const { w, rule } = await liveWorld();
    const v = await postVersion(
      w.c,
      rule.id,
      perSqft({ ratePerSqftPaise: 400, effectiveFrom: '2027-04-01' }),
    );
    const again = await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2027-07-01' }), null);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('RULE_VERSION_PENDING');
    expect(await reject(v.approvalRequestId, 'Not approved at the AGM', systemCtx('approver'))).toMatchObject(
      { status: 'REJECTED' },
    );
    const row = await BillingRuleVersion.findByPk(v.id);
    expect(row).toMatchObject({ status: 'REJECTED', rejectedReason: 'Not approved at the AGM' });
    expect((await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2027-07-01' }), null)).status).toBe(
      201,
    );
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'billing.rule_version.rejected' } }),
    ).toBe(1);
  });

  it('BR-11-21: an approved version in between closes the previous one and is closed by the next', async () => {
    const w = await billingWorld();
    const head = await headId(w.c, 'MAINTENANCE');
    const rule = await postRule(w.c, ruleBody(head));
    await postVersion(w.c, rule.id, perSqft({ ratePerSqftPaise: 380, effectiveFrom: '2027-04-01' }));
    await postVersion(w.c, rule.id, perSqft({ ratePerSqftPaise: 350, effectiveFrom: '2026-12-01' }));
    const r = (await w.c('get', `/billing/rules/${rule.id}`)).body.data;
    const by = Object.fromEntries(r.versions.map((v: any) => [v.versionNo, v]));
    expect(by[1]).toMatchObject({ effectiveFrom: '2026-04-01', effectiveTo: '2026-11-30' });
    expect(by[3]).toMatchObject({ effectiveFrom: '2026-12-01', effectiveTo: '2027-03-31' });
    expect(by[2]).toMatchObject({ effectiveFrom: '2027-04-01', effectiveTo: null });
    expect(r.currentVersion.versionNo).toBe(1);
    expect(r.nextVersion.versionNo).toBe(3);
  });

  it('BR-11-20: RULE_VERSION_DATE_TAKEN for a second approved version on the same date', async () => {
    const w = await billingWorld();
    const rule = await postRule(w.c, ruleBody(await headId(w.c, 'MAINTENANCE')));
    const r = await postVersion(w.c, rule.id, perSqft({ ratePerSqftPaise: 330 }), null);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RULE_VERSION_DATE_TAKEN');
  });

  it('US-11-02 / T11-16: effective inside a billed period is 422 RULE_EFFECTIVE_IN_BILLED_PERIOD', async () => {
    const { w, rule } = await liveWorld();
    for (const effectiveFrom of ['2026-10-01', '2026-04-01']) {
      const r = await postVersion(w.c, rule.id, perSqft({ effectiveFrom }), null);
      expect(r.status, effectiveFrom).toBe(422);
      expect(r.body.code).toBe('RULE_EFFECTIVE_IN_BILLED_PERIOD');
    }
    expect((await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2026-11-01' }), null)).status).toBe(
      201,
    );
  });

  it('BR-11-20: the date must be a period start of the society cycle (RULE_EFFECTIVE_DATE_INVALID)', async () => {
    const w = await billingWorld();
    const rule = await postRule(w.c, ruleBody(await headId(w.c, 'MAINTENANCE')));
    const mid = await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2027-04-15' }), null);
    expect(mid.status).toBe(422);
    expect(mid.body.code).toBe('RULE_EFFECTIVE_DATE_INVALID');
    await setSetting(w.society.id!, 'billing.cycle', 'QUARTERLY');
    const month = await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2027-05-01' }), null);
    expect(month.body.code).toBe('RULE_EFFECTIVE_DATE_INVALID');
    const nov = await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2026-11-01' }), null);
    expect(nov.body.code).toBe('RULE_EFFECTIVE_DATE_INVALID');
    const ok = await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2027-01-01' }), null);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await setSetting(w.society.id!, 'billing.cycle', 'ANNUAL');
    expect((await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2027-07-01' }), null)).body.code).toBe(
      'RULE_EFFECTIVE_DATE_INVALID',
    );
    expect((await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2028-04-01' }), null)).status).toBe(
      201,
    );
  });

  it('a non-monthly cycle needs billing.billing_cycles', async () => {
    const w = await billingWorld();
    const rule = await postRule(w.c, ruleBody(await headId(w.c, 'MAINTENANCE')));
    await setSetting(w.society.id!, 'billing.cycle', 'QUARTERLY');
    await featureOff(w.society.id!, 'billing.billing_cycles');
    const r = await postVersion(w.c, rule.id, perSqft({ effectiveFrom: '2027-01-01' }), null);
    expect(r.status).toBe(402);
  });

  it('approval re-checks BR-11-20: a version whose period was billed meanwhile fails with 422 and stays pending', async () => {
    const { w, rule } = await liveWorld();
    const v = await postVersion(
      w.c,
      rule.id,
      perSqft({ ratePerSqftPaise: 340, effectiveFrom: '2026-11-01' }),
    );
    await issuedRun(w.society.id!, '2026-11-01', '2026-11-30');
    await expect(approve(v.approvalRequestId, systemCtx('approver'))).rejects.toMatchObject({
      code: 'RULE_EFFECTIVE_IN_BILLED_PERIOD',
    });
    expect((await BillingRuleVersion.findByPk(v.id))!.status).toBe('PENDING_APPROVAL');
  });

  it('a module 14 that approves inside the request transaction activates the version at once', async () => {
    const { w, rule } = await liveWorld();
    setBillingPorts({ approvals: { request: async () => ({ id: 77, status: 'APPROVED' }) } });
    const v = await postVersion(
      w.c,
      rule.id,
      perSqft({ ratePerSqftPaise: 345, effectiveFrom: '2026-12-01' }),
    );
    expect(v).toMatchObject({ status: 'APPROVED', approvalRequestId: 77 });
    expect((await w.c('get', `/billing/rules/${rule.id}`)).body.data.nextVersion.versionNo).toBe(2);
  });

  it('versions are immutable: the model refuses to change a rate, and there is no route that does', async () => {
    const { rule } = await liveWorld();
    const v = (await BillingRuleVersion.findOne({ where: { billingRuleId: rule.id } }))!;
    v.ratePerSqftPaise = 999;
    await expect(v.save()).rejects.toThrow(/immutable/);
    await expect(v.destroy()).rejects.toThrow(/never deleted/);
  });

  it('an archived rule gets no new version; unknown rule is 404', async () => {
    const w = await billingWorld();
    await issuedRun(w.society.id!);
    const rule = await postRule(
      w.c,
      ruleBody(await headId(w.c, 'PARKING'), {
        name: 'Parking',
        firstVersion: flat(50_000, { effectiveFrom: '2026-12-01' }),
      }),
    );
    await w.c('delete', `/billing/rules/${rule.id}`, { reason: 'Mistake made', version: 1 });
    expect((await postVersion(w.c, rule.id, flat(1, { effectiveFrom: '2027-01-01' }), null)).body.code).toBe(
      'INVALID_STATE',
    );
    expect((await postVersion(w.c, 999_999, flat(1), null)).body.code).toBe('RULE_NOT_FOUND');
  });
});

describe('billing rules: reads, access and approval hook', () => {
  it('GET list shows current, next and pending versions; filters work; GET one returns the history', async () => {
    const { w, head, rule } = await liveWorld();
    await postVersion(w.c, rule.id, perSqft({ ratePerSqftPaise: 350, effectiveFrom: '2027-04-01' }));
    const list = await w.c('get', '/billing/rules');
    expect(list.status).toBe(200);
    expect(list.body.pagination.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ id: rule.id, chargeHead: { key: 'MAINTENANCE' } });
    expect(list.body.data[0].currentVersion.versionNo).toBe(1);
    expect(list.body.data[0].pendingVersion.versionNo).toBe(2);
    expect(list.body.data[0].versions).toBeUndefined();
    const f = await w.c('get', '/billing/rules', undefined, { query: { chargeHeadId: String(head + 1) } });
    expect(f.body.data).toEqual([]);
    const s = await w.c('get', '/billing/rules', undefined, { query: { scopeType: 'BUILDINGS' } });
    expect(s.body.data).toEqual([]);
    const arch = await w.c('get', '/billing/rules', undefined, { query: { status: 'ARCHIVED' } });
    expect(arch.body.data).toEqual([]);
    expect((await w.c('get', '/billing/rules', undefined, { query: { status: 'DELETED' } })).status).toBe(
      400,
    );
  });

  it('view-only roles read but cannot write; plan features gate the routes', async () => {
    const { w, rule } = await liveWorld();
    const sec = await adminOf(w.society, 'secretary');
    expect((await sec.c('get', '/billing/rules')).status).toBe(200);
    expect((await sec.c('get', `/billing/rules/${rule.id}`)).status).toBe(200);
    expect(
      (
        await sec.c('post', `/billing/rules/${rule.id}/versions`, perSqft({ effectiveFrom: '2027-04-01' }), {
          headers: idem(),
        })
      ).status,
    ).toBe(403);
    await featureOff(w.society.id!, 'billing.versioned_billing_rules');
    expect((await w.c('post', '/billing/rules', ruleBody(1), { headers: idem() })).body.code).toBe(
      'FEATURE_NOT_IN_PLAN',
    );
  });

  it('another society sees 404 RULE_NOT_FOUND for every rule route', async () => {
    const { rule } = await liveWorld();
    const b = await billingWorld({ name: 'Green Park CHS' });
    for (const r of [
      await b.c('get', `/billing/rules/${rule.id}`),
      await b.c('patch', `/billing/rules/${rule.id}`, { name: 'Hack', version: 1 }),
      await b.c('delete', `/billing/rules/${rule.id}`, { reason: 'Hacking', version: 1 }),
      await b.c('post', `/billing/rules/${rule.id}/versions`, perSqft({ effectiveFrom: '2027-04-01' }), {
        headers: idem(),
      }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('RULE_NOT_FOUND');
    }
  });

  it('the approval hook knows only requests of billing; an unknown id is 404', async () => {
    await expect(approve(987_654, systemCtx('x'))).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
    await expect(reject(987_654, 'no', systemCtx('x'))).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
  });

  it('flats of the world are real units (sanity for the scope tests)', async () => {
    const w = await billingWorld();
    expect(w.units).toHaveLength(4);
    expect((await makeUnit(w.c, w.buildingId, '201', 2)).id).toBeGreaterThan(0);
  });
});
