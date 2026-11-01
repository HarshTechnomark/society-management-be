import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  EntitlementOverride,
  Plan,
  PlanEntitlement,
  PlanVersion,
  Subscription,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { kv } from '../../../src/lib/kv';
import { setAbsoluteUsage } from '../../../src/modules/subscriptions/entitlements.service';
import { as, idem, platformLogin, platformUser, resetLogins } from '../../helpers/access';
import { resetSubs, subSociety } from '../../helpers/subscriptions';

afterAll(closeDb);
beforeEach(async () => {
  await resetSubs({ catalogue: true });
  resetLogins();
  setNow('2026-11-10T06:30:00Z');
});

async function admin() {
  const u = await platformUser('super_admin');
  return as(await platformLogin(u), 'PLATFORM');
}
const planId = async (code: string) => (await Plan.findOne({ where: { code } }))!.id!;

describe('plans and versions (8.2)', () => {
  it('lists the four plans with current version, counts and MRR', async () => {
    const p = await admin();
    await subSociety({ plan: 'STANDARD', flats: 240 });
    const r = await p('get', '/platform/plans');
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: { code: string }) => x.code)).toEqual([
      'STARTER',
      'STANDARD',
      'PREMIUM',
      'ENTERPRISE',
    ]);
    expect(r.body.data[1]).toMatchObject({
      currentVersion: { versionNo: 1, pricePerFlatPaise: 1500, minBillableFlats: 50, annualFreeMonths: 2 },
      draftVersionId: null,
      activeSubscriptions: 1,
      onOlderVersions: 0,
      mrrPaise: 360000,
    });
    const cat = await p('get', '/platform/entitlement-catalogue', undefined, {
      query: { status: 'PLANNED' },
    });
    expect(cat.body.data).toHaveLength(6);
    expect(cat.body.data[0]).toMatchObject({ catalogueStatus: 'PLANNED', minPlan: 'PREMIUM' });
    const all = await p('get', '/platform/entitlement-catalogue');
    expect(all.body.data).toHaveLength(573);
  });

  it('T04-19 / T04-20 / T04-22 draft, edit, publish rules', async () => {
    const p = await admin();
    const { sub } = await subSociety({ plan: 'STANDARD' });
    const std = await planId('STANDARD');
    const d = await p(
      'post',
      `/platform/plans/${std}/versions`,
      { reason: 'Price rise to 17' },
      { headers: idem() },
    );
    expect(d.status).toBe(201);
    expect(d.body.data).toMatchObject({ versionNo: 2, status: 'DRAFT', pricePerFlatPaise: 1500 });
    expect(d.body.data.entitlements).toHaveLength(573);
    const dup = await p(
      'post',
      `/platform/plans/${std}/versions`,
      { reason: 'Second draft' },
      { headers: idem() },
    );
    expect([dup.status, dup.body.code]).toEqual([409, 'DRAFT_ALREADY_EXISTS']);
    const vid = d.body.data.id;
    const e = await p('patch', `/platform/plan-versions/${vid}`, { pricePerFlatPaise: 1700, version: 1 });
    expect(e.body.data.pricePerFlatPaise).toBe(1700);
    // T04-52 a PLANNED key cannot be enabled in a draft
    const pl = await p('put', `/platform/plan-versions/${vid}/entitlements`, {
      items: [{ entitlementKey: 'communication.chat_groups', isEnabled: true }],
      version: 2,
    });
    expect([pl.status, pl.body.code]).toEqual([422, 'PLANNED_FEATURE']);
    const ao = await p('put', `/platform/plan-versions/${vid}/entitlements`, {
      items: [{ entitlementKey: 'communication.emergency_broadcast', isEnabled: false }],
      version: 2,
    });
    expect(ao.body.code).toBe('ALWAYS_ON_FEATURE');
    const km = await p('put', `/platform/plan-versions/${vid}/entitlements`, {
      items: [{ entitlementKey: 'limit.sms_per_month', isEnabled: true }],
      version: 2,
    });
    expect(km.body.code).toBe('ENTITLEMENT_KIND_MISMATCH');
    const uk = await p('put', `/platform/plan-versions/${vid}/entitlements`, {
      items: [{ entitlementKey: 'nope.key', isEnabled: true }],
      version: 2,
    });
    expect(uk.body.code).toBe('UNKNOWN_ENTITLEMENT_KEY');
    const ok = await p('put', `/platform/plan-versions/${vid}/entitlements`, {
      items: [
        { entitlementKey: 'governance.polls_engine', isEnabled: true },
        { entitlementKey: 'limit.sms_per_month', limitValue: 2500 },
      ],
      version: 2,
    });
    expect(ok.body.data).toEqual({ updated: 2, version: 3 });
    // T04-19 missing key
    await PlanEntitlement.destroy({ where: { planVersionId: vid, entitlementKey: 'parking.ev_charging' } });
    const miss = await p('post', `/platform/plan-versions/${vid}/publish`, {
      reason: 'Publish v2',
      version: 3,
    });
    expect([miss.status, miss.body.code]).toEqual([422, 'CATALOGUE_INCOMPLETE']);
    expect(miss.body.errors).toEqual([{ field: 'entitlementKey', message: 'parking.ev_charging' }]);
    await PlanEntitlement.create({
      planVersionId: vid,
      entitlementKey: 'parking.ev_charging',
      kind: 'FEATURE',
      isEnabled: false,
      limitValue: null,
      limitPerFlats: null,
      overageUnitSize: null,
      overagePricePaise: null,
    });
    const pub = await p('post', `/platform/plan-versions/${vid}/publish`, {
      reason: 'Publish v2',
      version: 3,
    });
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ status: 'PUBLISHED', subscriptionsOnOlderVersions: 1 });
    const v1 = await PlanVersion.findOne({ where: { planId: std, versionNo: 1 } });
    expect(v1!.status).toBe('RETIRED');
    expect((await Subscription.findByPk(sub.id!))!.planVersionId).toBe(v1!.id); // existing stay on v1
    // T04-22 a published version is immutable (API and model hook)
    const ed = await p('patch', `/platform/plan-versions/${vid}`, { pricePerFlatPaise: 1800, version: 4 });
    expect([ed.status, ed.body.code]).toEqual([409, 'PLAN_VERSION_NOT_DRAFT']);
    const row = (await PlanVersion.findByPk(vid))!;
    row.pricePerFlatPaise = 1900;
    await expect(row.save()).rejects.toMatchObject({ code: 'PLAN_VERSION_NOT_DRAFT' });
    expect(await AuditLog.count({ where: { action: 'subscriptions.plan_version.published' } })).toBe(1);
  });

  it('T04-21 migration with 30 days notice on 10 Nov 2026 (dry run, then scheduled)', async () => {
    const p = await admin();
    const m = await subSociety({ plan: 'STANDARD', flats: 100, name: 'Monthly CHS' });
    const a = await subSociety({
      plan: 'STANDARD',
      flats: 100,
      cycle: 'ANNUAL',
      periodStart: '2026-03-15',
      anchor: 15,
      name: 'Annual CHS',
    });
    const t = await subSociety({ plan: 'STANDARD', status: 'TRIALING', name: 'Trial CHS' });
    const std = await planId('STANDARD');
    const d = await p(
      'post',
      `/platform/plans/${std}/versions`,
      { reason: 'Price rise to 17' },
      { headers: idem() },
    );
    await p('patch', `/platform/plan-versions/${d.body.data.id}`, { pricePerFlatPaise: 1700, version: 1 });
    await p('post', `/platform/plan-versions/${d.body.data.id}/publish`, {
      reason: 'Publish v2',
      version: 2,
    });
    const none = await p('post', `/platform/plans/${await planId('PREMIUM')}/migrations`, {
      reason: 'Nothing here',
      dryRun: true,
    });
    expect(none.body.code).toBe('MIGRATION_NOTHING_TO_DO');
    const dry = await p('post', `/platform/plans/${std}/migrations`, {
      reason: 'Move to v2 price',
      dryRun: true,
    });
    expect(dry.body.data).toMatchObject({
      status: 'DONE',
      matched: 3,
      scheduled: 2,
      trialsSwitched: 1,
      mrrBeforePaise: 150000 + 125000,
      mrrAfterPaise: 170000 + 141667,
      earliestChangeAt: '2027-01-01',
    });
    expect((await Subscription.findByPk(m.sub.id!))!.pendingPlanVersionId).toBeNull();
    const run = await p(
      'post',
      `/platform/plans/${std}/migrations`,
      { reason: 'Move to v2 price' },
      { headers: idem() },
    );
    expect(run.status).toBe(200);
    const ms = (await Subscription.findByPk(m.sub.id!))!;
    expect([ms.pendingChangeType, ms.pendingChangeAt]).toEqual(['VERSION_MIGRATION', '2027-01-01']);
    expect((await Subscription.findByPk(a.sub.id!))!.pendingChangeAt).toBe('2027-03-15');
    expect((await Subscription.findByPk(t.sub.id!))!.planVersionId).toBe(d.body.data.id);
    const bad = await p('post', `/platform/plans/${std}/migrations`, {
      reason: 'Bad',
      noticeDays: 29,
      dryRun: true,
    });
    expect(bad.status).toBe(400);
  });

  it('T04-35 validation lists each field; T04-33 platform support cannot publish', async () => {
    const p = await admin();
    const std = await planId('STANDARD');
    const d = await p(
      'post',
      `/platform/plans/${std}/versions`,
      { reason: 'Validation test' },
      { headers: idem() },
    );
    const r = await p('patch', `/platform/plan-versions/${d.body.data.id}`, {
      pricePerFlatPaise: 50001,
      annualFreeMonths: 7,
      version: 1,
    });
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'annualFreeMonths',
      'pricePerFlatPaise',
    ]);
    const sup = await platformUser('platform_support');
    const s = as(await platformLogin(sup), 'PLATFORM');
    const pub = await s('post', `/platform/plan-versions/${d.body.data.id}/publish`, {
      reason: 'Try it',
      version: 1,
    });
    expect([pub.status, pub.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await s('get', '/platform/plans')).status).toBe(200);
  });
});

describe('subscriptions and overrides (8.4)', () => {
  it('lists, shows detail, and changes a plan to Enterprise with a custom price', async () => {
    const p = await admin();
    const { sub } = await subSociety({ plan: 'PREMIUM', flats: 600 });
    const l = await p('get', '/platform/subscriptions', undefined, { query: { planCode: 'PREMIUM' } });
    expect(l.body.data[0]).toMatchObject({
      id: sub.id,
      planCode: 'PREMIUM',
      status: 'ACTIVE',
      chargedFlats: 600,
      monthlyEquivalentPaise: 1500000,
    });
    expect(l.body.pagination).toMatchObject({ total: 1 });
    const d = await p('get', `/platform/subscriptions/${sub.id}`);
    expect(d.body.data.entitlements.features).toHaveLength(561);
    expect(d.body.data.usage.items).toHaveLength(12);
    const noPrice = await p(
      'post',
      `/platform/subscriptions/${sub.id}/change-plan`,
      { planCode: 'ENTERPRISE', reason: 'Contract signed', version: sub.version },
      { headers: idem() },
    );
    expect(noPrice.body.code).toBe('CUSTOM_PRICE_REQUIRED');
    const ch = await p(
      'post',
      `/platform/subscriptions/${sub.id}/change-plan`,
      {
        planCode: 'ENTERPRISE',
        customPricePerFlatPaise: 2000,
        reason: 'Contract signed',
        version: sub.version,
      },
      { headers: idem() },
    );
    expect(ch.body.data).toMatchObject({ effect: 'IMMEDIATE', planCode: 'ENTERPRISE' });
    const pc = await p('patch', `/platform/subscriptions/${sub.id}`, {
      customPricePerFlatPaise: 1900,
      reason: 'Renegotiated',
      version: ch.body.data.version,
    });
    expect(pc.body.data).toMatchObject({
      customPricePerFlatPaise: 1900,
      plan: { code: 'ENTERPRISE', pricePerFlatPaise: 1900 },
    });
  });

  it('T04-26 / T04-51 overrides: always-on and PLANNED refused; a limit override warns below usage; revoke', async () => {
    const p = await admin();
    const { sub, society } = await subSociety({ plan: 'STANDARD' });
    const post = (b: Record<string, unknown>) =>
      p('post', `/platform/subscriptions/${sub.id}/overrides`, b, { headers: idem() });
    const ao = await post({
      targetType: 'KEY',
      entitlementKey: 'communication.emergency_broadcast',
      isEnabled: false,
      source: 'CONTRACT',
      reason: 'Try to disable',
    });
    expect([ao.status, ao.body.code]).toEqual([422, 'ALWAYS_ON_FEATURE']);
    const pl = await post({
      targetType: 'KEY',
      entitlementKey: 'communication.lobby_tv_display_mode',
      isEnabled: true,
      source: 'CONTRACT',
      reason: 'Enable lobby TV',
    });
    expect([pl.status, pl.body.code]).toEqual([422, 'PLANNED_FEATURE']);
    expect(await EntitlementOverride.count()).toBe(0);
    const noExp = await post({
      targetType: 'KEY',
      entitlementKey: 'governance.polls_engine',
      isEnabled: true,
      source: 'SUPPORT',
      reason: 'Support case',
    });
    expect(noExp.status).toBe(400);
    await setAbsoluteUsage(society.id!, 'limit.guard_devices', 3);
    const genBefore = await kv().counterGet(`ent:gen:${society.id}`);
    const lim = await post({
      targetType: 'KEY',
      entitlementKey: 'limit.guard_devices',
      limitValue: 1,
      source: 'CONTRACT',
      reason: 'Contract limit',
    });
    expect(lim.status).toBe(201);
    expect(lim.body.data.warnings).toEqual([{ limitKey: 'limit.guard_devices', used: 3, newLimit: 1 }]);
    expect(await kv().counterGet(`ent:gen:${society.id}`)).toBe(genBefore + 1);
    const dup = await post({
      targetType: 'KEY',
      entitlementKey: 'limit.guard_devices',
      limitValue: 2,
      source: 'CONTRACT',
      reason: 'Contract limit',
    });
    expect(dup.body.code).toBe('OVERRIDE_EXISTS');
    const mod = await post({
      targetType: 'MODULE',
      moduleNo: 22,
      isEnabled: true,
      source: 'PROMOTION',
      expiresAt: '2026-12-10T00:00:00.000Z',
      reason: 'Governance promo',
    });
    expect(mod.status).toBe(201);
    const list = await p('get', `/platform/subscriptions/${sub.id}/overrides`);
    expect(list.body.data).toHaveLength(2);
    const rv = await p('post', `/platform/subscriptions/${sub.id}/overrides/${lim.body.data.id}/revoke`, {
      reason: 'Ended contract',
      version: 1,
    });
    expect(rv.body.data.revokedAt).not.toBeNull();
    const rv2 = await p('post', `/platform/subscriptions/${sub.id}/overrides/${lim.body.data.id}/revoke`, {
      reason: 'Ended contract',
      version: 2,
    });
    expect(rv2.body.code).toBe('INVALID_STATE');
    const other = await subSociety({ plan: 'STANDARD', name: 'Other CHS' });
    const x = await p(
      'post',
      `/platform/subscriptions/${other.sub.id}/overrides/${mod.body.data.id}/revoke`,
      { reason: 'Wrong society', version: 1 },
    );
    expect(x.body.code).toBe('OVERRIDE_NOT_FOUND');
  });

  it('add-ons: list, create with grant rules, edit', async () => {
    const p = await admin();
    const l = await p('get', '/platform/addons');
    expect(l.body.data).toHaveLength(8);
    expect(l.body.data.find((a: { code: string }) => a.code === 'API_ACCESS').availableToPlans).toEqual([
      'PREMIUM',
    ]);
    const planned = await p(
      'post',
      '/platform/addons',
      {
        code: 'CHAT_PACK',
        name: 'Chat',
        billingType: 'RECURRING',
        grants: [{ type: 'FEATURE', key: 'communication.chat_groups' }],
        pricePaise: 1000,
        minTierRank: 1,
        maxTierRank: 3,
        maxQuantity: 1,
        reason: 'Chat add-on',
      },
      { headers: idem() },
    );
    expect(planned.body.code).toBe('PLANNED_FEATURE');
    const dup = await p(
      'post',
      '/platform/addons',
      {
        code: 'SMS_PACK_2000',
        name: 'Dup',
        billingType: 'ONE_TIME',
        grants: [{ type: 'LIMIT_INCREMENT', key: 'limit.sms_per_month', amount: 10 }],
        pricePaise: 1000,
        minTierRank: 1,
        maxTierRank: 4,
        maxQuantity: 5,
        reason: 'Duplicate code',
      },
      { headers: idem() },
    );
    expect(dup.body.code).toBe('ADDON_CODE_TAKEN');
    const ok = await p(
      'post',
      '/platform/addons',
      {
        code: 'SMS_PACK_500',
        name: '500 SMS',
        billingType: 'ONE_TIME',
        grants: [{ type: 'LIMIT_INCREMENT', key: 'limit.sms_per_month', amount: 500 }],
        pricePaise: 25000,
        minTierRank: 1,
        maxTierRank: 4,
        maxQuantity: 5,
        reason: 'Small pack',
      },
      { headers: idem() },
    );
    expect(ok.status).toBe(201);
    const ed = await p('patch', `/platform/addons/${ok.body.data.id}`, {
      pricePaise: 24000,
      isOnSale: false,
      reason: 'Price cut',
      version: 1,
    });
    expect(ed.body.data).toMatchObject({ pricePaise: 24000, isOnSale: false, version: 2 });
  });
});

describe('feature flags (8.7)', () => {
  it('T04-36 key format; create, toggle, override, evaluate, archive', async () => {
    const p = await admin();
    const bad = await p(
      'post',
      '/platform/feature-flags',
      { flagKey: 'Billing.New', description: 'Bad key', type: 'GLOBAL', reason: 'Testing keys' },
      { headers: idem() },
    );
    expect([bad.status, bad.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const c = await p(
      'post',
      '/platform/feature-flags',
      {
        flagKey: 'billing.dues_widget',
        description: 'Dues widget',
        type: 'PERCENTAGE',
        rolloutPercent: 0,
        reason: 'New widget',
      },
      { headers: idem() },
    );
    expect(c.status).toBe(201);
    const taken = await p(
      'post',
      '/platform/feature-flags',
      { flagKey: 'billing.dues_widget', description: 'Again', type: 'GLOBAL', reason: 'Duplicate' },
      { headers: idem() },
    );
    expect(taken.body.code).toBe('FLAG_KEY_TAKEN');
    const id = c.body.data.id;
    const t = await p('post', `/platform/feature-flags/${id}/toggle`, {
      isEnabled: true,
      reason: 'Start rollout',
      version: 1,
    });
    expect(t.body.data).toMatchObject({ isEnabled: true, rolloutPercent: 10 });
    const same = await p('post', `/platform/feature-flags/${id}/toggle`, {
      isEnabled: true,
      reason: 'Again',
      version: 2,
    });
    expect(same.body.code).toBe('FLAG_ALREADY_IN_STATE');
    const { society } = await subSociety({ plan: 'STARTER' });
    const ev = await p('get', `/platform/feature-flags/${id}/evaluate`, undefined, {
      query: { societyId: String(society.id) },
    });
    expect(ev.body.data).toMatchObject({ step: 'PERCENTAGE', bucket: expect.any(Number) });
    const o = await p('post', `/platform/feature-flags/${id}/overrides`, {
      societyId: society.id,
      value: true,
      reason: 'Pilot society',
    });
    expect(o.status).toBe(201);
    const o2 = await p('post', `/platform/feature-flags/${id}/overrides`, {
      societyId: society.id,
      value: false,
      reason: 'Pilot paused',
    });
    expect(o2.status).toBe(200);
    const ev2 = await p('get', `/platform/feature-flags/${id}/evaluate`, undefined, {
      query: { societyId: String(society.id) },
    });
    expect(ev2.body.data).toMatchObject({ on: false, step: 'OVERRIDE' });
    const nf = await p('get', `/platform/feature-flags/${id}/evaluate`, undefined, {
      query: { societyId: '999999' },
    });
    expect(nf.body.code).toBe('SOCIETY_NOT_FOUND');
    const list = await p('get', '/platform/feature-flags', undefined, { query: { q: 'dues' } });
    expect(list.body.data[0]).toMatchObject({ flagKey: 'billing.dues_widget', overrideCount: 1 });
    const del = await p('delete', `/platform/feature-flags/${id}/overrides/${o.body.data.id}`, {
      reason: 'Pilot over',
    });
    expect(del.status).toBe(204);
    const arch = await p(
      'delete',
      `/platform/feature-flags/${id}`,
      { reason: 'Rolled out' },
      { query: { version: '2' } },
    );
    expect(arch.status).toBe(204);
    expect((await p('get', `/platform/feature-flags/${id}`)).body.code).toBe('FLAG_NOT_FOUND');
  });

  it('a kill switch toggle needs step-up', async () => {
    const p = await admin();
    const k = await p('get', '/platform/feature-flags', undefined, { query: { type: 'KILL_SWITCH' } });
    const flag = k.body.data[0];
    setNow('2026-11-10T06:36:00Z');
    const r = await p('post', `/platform/feature-flags/${flag.id}/toggle`, {
      isEnabled: true,
      reason: 'Incident',
      version: flag.version,
    });
    expect(r.body.code).toBe('REAUTH_REQUIRED');
  });
});
