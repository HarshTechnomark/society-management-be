import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Addon,
  EntitlementOverride,
  Subscription,
  SubscriptionAddon,
  closeDb,
  sequelize,
} from '../../../src/models';
import { systemCtx } from '../../../src/types/context';
import { applyCancellation } from '../../../src/modules/subscriptions/subscriptions.service';
import { setNow } from '../../../src/lib/clock';
import { invalidate, setAbsoluteUsage } from '../../../src/modules/subscriptions/entitlements.service';
import { as, idem, login, memberUser, resetLogins } from '../../helpers/access';
import { callsOf, resetSubs, subSociety } from '../../helpers/subscriptions';

afterAll(closeDb);
beforeEach(async () => {
  await resetSubs();
  resetLogins();
  setNow('2026-11-17T06:30:00Z');
});

async function setup(o: Parameters<typeof subSociety>[0] = {}) {
  const { society, sub } = await subSociety({ flats: 96, ...o });
  const chair = await memberUser(society, 'chairman');
  return { society, sub, chair, c: as(await login(chair)) };
}

describe('GET /subscription and reads (8.5)', () => {
  it('returns the summary of 8.5.1', async () => {
    const { c, sub } = await setup({ plan: 'STANDARD', flats: 240 });
    const r = await c('get', '/subscription');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      id: sub.id,
      status: 'ACTIVE',
      societyStatus: 'ACTIVE',
      plan: {
        code: 'STANDARD',
        versionNo: 1,
        pricePerFlatPaise: 1500,
        minBillableFlats: 50,
        annualFreeMonths: 2,
      },
      billingCycle: 'MONTHLY',
      currentPeriodStart: '2026-11-01',
      currentPeriodEnd: '2026-11-30',
      billableFlats: 240,
      chargedFlats: 240,
      periodValuePaise: 360000,
      pendingChange: null,
      cancelAtPeriodEnd: false,
      readOnlyFeatures: [],
      activeAddons: [],
      activeFeatureTrial: null,
    });
    expect(r.body.data.autopay).toBeUndefined(); // flag platform.autopay off
  });

  it('US-04-01 compares plans priced for the society (240 flats Standard ₹3,600 / ₹36,000)', async () => {
    const { c } = await setup({ plan: 'STARTER', flats: 240 });
    const m = await c('get', '/subscription/plans');
    const std = m.body.data.items.find((p: { code: string }) => p.code === 'STANDARD');
    expect(std).toMatchObject({
      periodPricePaise: 360000,
      isCurrent: false,
      isSelfServe: true,
      chargedFlats: 240,
    });
    const a = await c('get', '/subscription/plans', undefined, { query: { billingCycle: 'ANNUAL' } });
    expect(a.body.data.items.find((p: { code: string }) => p.code === 'STANDARD').periodPricePaise).toBe(
      3600000,
    );
    const ent = a.body.data.items.find((p: { code: string }) => p.code === 'ENTERPRISE');
    expect(ent).toMatchObject({ isSelfServe: false, pricePerFlatPaise: null, periodPricePaise: null });
    expect(a.body.data.recommendation).toMatchObject({
      reasonCodes: expect.arrayContaining(['ANNUAL_SAVES']),
    });
  });

  it('T04-53 no PLANNED key is listed or counted on Premium', async () => {
    const { c } = await setup({ plan: 'PREMIUM' });
    const p = await c('get', '/subscription/plans');
    expect(
      p.body.data.items.find((x: { code: string }) => x.code === 'PREMIUM').highlights.featureCount,
    ).toBe(542);
    const e = await c('get', '/subscription/entitlements');
    expect(e.body.data.features).not.toContain('communication.chat_groups');
    expect(e.body.data.features).toHaveLength(542);
  });

  it('quote of 8.5.5: annual Standard with storage add-on, tax null until module 06', async () => {
    const { c } = await setup({ plan: 'STARTER', flats: 240 });
    const r = await c('get', '/subscription/quote', undefined, {
      query: { planCode: 'STANDARD', billingCycle: 'ANNUAL', addons: 'EXTRA_STORAGE_50GB:1' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.lines.map((l: { amountPaise: number }) => l.amountPaise)).toEqual([
      4320000, -720000, 600000,
    ]);
    expect(r.body.data).toMatchObject({
      subtotalPaise: 4200000,
      tax: null,
      totalPaise: 4200000,
      periodStart: '2026-12-01',
      periodEnd: '2027-11-30',
    });
    expect(r.body.data.proration).toMatchObject({ daysRemaining: 14, netPaise: (240 * 600 * 14) / 30 });
    const ent = await c('get', '/subscription/quote', undefined, { query: { planCode: 'ENTERPRISE' } });
    expect(ent.body.code).toBe('PLAN_NOT_SELF_SERVE');
    const same = await c('get', '/subscription/quote', undefined, { query: { planCode: 'STARTER' } });
    expect(same.body.code).toBe('SAME_PLAN');
  });

  it('T04-34 a resident gets features but no limits; T04-31 usage shows only the caller society', async () => {
    const { society, c } = await setup({ plan: 'STANDARD' });
    const other = await subSociety({ plan: 'STANDARD', name: 'Green Park CHS' });
    await setAbsoluteUsage(other.society.id!, 'limit.guard_devices', 3);
    await setAbsoluteUsage(society.id!, 'limit.guard_devices', 1);
    const owner = await memberUser(society, 'owner', { mfa: false });
    const r = await as(await login(owner, { app: 'RESIDENT' }), 'RESIDENT')(
      'get',
      '/subscription/entitlements',
    );
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=60');
    expect(r.body.data.features).toContain('amenities.amenity_catalogue');
    expect(r.body.data.limits).toBeUndefined();
    expect(r.body.data.flags).toBeTypeOf('object');
    const v = await c('get', '/subscription/entitlements');
    expect(v.body.data.limits['limit.admin_seats']).toEqual({ limit: 4, used: 0, period: 'ALL' });
    const u = await c('get', '/subscription/usage');
    const gd = u.body.data.items.find((i: { limitKey: string }) => i.limitKey === 'limit.guard_devices');
    expect(gd).toMatchObject({ used: 1, limit: 3, percent: 33, enforcement: 'HARD', period: 'ABSOLUTE' });
    expect(u.body.data.items).toHaveLength(12);
    const storage = u.body.data.items.find((i: { limitKey: string }) => i.limitKey === 'limit.storage_gb');
    expect(storage.limitBytes).toBe(25 * 1073741824);
  });

  it('T04-32 an accountant cannot change the plan', async () => {
    const { society } = await setup({ plan: 'STARTER' });
    const acc = await memberUser(society, 'accountant');
    const r = await as(await login(acc))(
      'post',
      '/subscription/change-plan',
      { planCode: 'STANDARD', version: 1 },
      { headers: idem() },
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('change plan (8.6.2)', () => {
  it('US-04-02 / T04-18 upgrade now with proration; a replay makes one change and one invoice', async () => {
    const { c, sub, society } = await setup({ plan: 'STARTER', flats: 96 });
    const key = idem();
    const r = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'STANDARD', version: sub.version },
      { headers: key },
    );
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Plan upgraded');
    expect(r.body.data).toMatchObject({
      effect: 'IMMEDIATE',
      planCode: 'STANDARD',
      effectiveDate: '2026-11-17',
      proration: {
        daysRemaining: 14,
        periodDays: 30,
        creditPaise: 40320,
        chargePaise: 67200,
        netPaise: 26880,
      },
    });
    expect(r.body.data.invoiceId).toBeTypeOf('number');
    const again = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'STANDARD', version: sub.version },
      { headers: key },
    );
    expect(again.headers['idempotent-replay']).toBe('true');
    const calls = callsOf('issueProrationInvoice');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      changeRef: `UPGRADE:${sub.id}:${sub.version + 1}`,
      items: [{ fromPeriodValuePaise: 86400, toPeriodValuePaise: 144000 }],
    });
    // gate features work on the next request
    const e = await c('get', '/subscription/entitlements');
    expect(e.body.data.planCode).toBe('STANDARD');
    expect(e.body.data.features).toContain('visitor.walk_in_with_resident_approval');
    expect(await Subscription.count({ where: { societyId: society.id! } })).toBe(1);
  });

  it('T04-37 stale version gives 409; SAME_PLAN and PLAN_NOT_SELF_SERVE', async () => {
    const { c, sub } = await setup({ plan: 'STARTER' });
    const stale = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'STANDARD', version: sub.version - 1 },
      { headers: idem() },
    );
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const same = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'STARTER', version: sub.version },
      { headers: idem() },
    );
    expect(same.body.code).toBe('SAME_PLAN');
    const ent = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'ENTERPRISE', version: sub.version },
      { headers: idem() },
    );
    expect([ent.status, ent.body.code]).toEqual([422, 'PLAN_NOT_SELF_SERVE']);
  });

  it('T04-38 a change after the step-up window needs re-authentication', async () => {
    const { c, sub } = await setup({ plan: 'STARTER' });
    setNow('2026-11-17T06:40:00Z');
    const r = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'STANDARD', version: sub.version },
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
  });

  it('T04-16 downgrade Premium to Standard with 12 automation rules is refused; without conflicts it is scheduled and cancellable', async () => {
    const { c, sub, society } = await setup({ plan: 'PREMIUM' });
    await setAbsoluteUsage(society.id!, 'limit.automation_rules', 12);
    const r = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'STANDARD', version: sub.version },
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([409, 'DOWNGRADE_LIMIT_CONFLICT']);
    expect(r.body.errors).toEqual([
      {
        field: 'limit.automation_rules',
        message: 'limit.automation_rules: 12 in use, Standard allows 0',
        used: 12,
        targetLimit: 0,
      },
    ]);
    const p = await c('get', '/subscription/downgrade-preview', undefined, {
      query: { planCode: 'STANDARD' },
    });
    expect(p.body.data).toMatchObject({
      targetPlan: 'STANDARD',
      effectiveDate: '2026-12-01',
      readOnlyUntil: '2027-03-01',
      canSchedule: false,
    });
    expect(p.body.data.featuresLost.some((f: { key: string }) => f.key === 'governance.polls_engine')).toBe(
      true,
    );
    expect(
      p.body.data.featuresLost.some((f: { key: string }) => f.key.startsWith('communication.chat')),
    ).toBe(false);
    await setAbsoluteUsage(society.id!, 'limit.automation_rules', 0);
    const ok = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'STANDARD', version: sub.version },
      { headers: idem() },
    );
    expect(ok.body.data).toMatchObject({ effect: 'SCHEDULED', effectiveDate: '2026-12-01', invoiceId: null });
    const s = await c('get', '/subscription');
    expect(s.body.data.pendingChange).toEqual({ type: 'DOWNGRADE', planCode: 'STANDARD', at: '2026-12-01' });
    const del = await c('delete', '/subscription/pending-change', undefined, {
      query: { type: 'PLAN', version: String(s.body.data.version) },
    });
    expect(del.status).toBe(204);
    const none = await c('delete', '/subscription/pending-change', undefined, {
      query: { type: 'PLAN', version: String(s.body.data.version + 1) },
    });
    expect(none.body.code).toBe('NO_PENDING_CHANGE');
    const np = await c('get', '/subscription/downgrade-preview', undefined, {
      query: { planCode: 'ENTERPRISE' },
    });
    expect(np.body.code).toBe('NOT_A_DOWNGRADE');
  });

  it('billing cycle change is scheduled for the next period; refused in a trial', async () => {
    const { c, sub } = await setup({ plan: 'STANDARD' });
    const r = await c('post', '/subscription/billing-cycle', {
      billingCycle: 'ANNUAL',
      version: sub.version,
    });
    expect(r.body.data).toEqual({
      pendingBillingCycle: 'ANNUAL',
      effectiveDate: '2026-12-01',
      version: sub.version + 1,
    });
    const same = await c('post', '/subscription/billing-cycle', {
      billingCycle: 'ANNUAL',
      version: sub.version + 1,
    });
    expect(same.body.code).toBe('SAME_BILLING_CYCLE');
    const t = await setup({ plan: 'STANDARD', status: 'TRIALING', name: 'Tulip Gardens CHS' });
    const tr = await t.c('post', '/subscription/billing-cycle', {
      billingCycle: 'ANNUAL',
      version: t.sub.version,
    });
    expect(tr.body.code).toBe('INVALID_STATE');
  });

  it('activate from a trial issues the first invoice in the same transaction', async () => {
    const { c, sub } = await setup({ plan: 'STANDARD', status: 'TRIALING', flats: 40 });
    const r = await c(
      'post',
      '/subscription/activate',
      { planCode: 'STANDARD', billingCycle: 'MONTHLY', version: sub.version },
      { headers: idem() },
    );
    expect(r.status).toBe(200);
    expect(r.body.data.subscription).toMatchObject({
      status: 'ACTIVE',
      statusReason: 'PAID_START',
      currentPeriodStart: '2026-11-17',
      currentPeriodEnd: '2026-12-16',
      chargedFlats: 50,
      periodValuePaise: 75000,
    });
    expect(r.body.data.invoice).toMatchObject({ id: expect.any(Number) });
    expect(callsOf('issuePeriodInvoice')[0]!.input).toEqual({
      subscriptionId: sub.id,
      periodStart: '2026-11-17',
    });
    const again = await c(
      'post',
      '/subscription/activate',
      { planCode: 'STANDARD', billingCycle: 'MONTHLY', version: sub.version + 1 },
      { headers: idem() },
    );
    expect(again.body.code).toBe('INVALID_STATE');
  });
});

describe('add-ons and feature trials (8.6.5 to 8.6.8)', () => {
  it('T04-24 WhatsApp pack on Starter is not available; a storage add-on is bought, cancelled and resumed', async () => {
    const { c } = await setup({ plan: 'STARTER' });
    const w = await c(
      'post',
      '/subscription/addons',
      { addonCode: 'WHATSAPP_PACK_5000' },
      { headers: idem() },
    );
    expect([w.status, w.body.code]).toEqual([422, 'ADDON_NOT_AVAILABLE_FOR_PLAN']);
    const b = await c(
      'post',
      '/subscription/addons',
      { addonCode: 'EXTRA_STORAGE_50GB', quantity: 2 },
      { headers: idem() },
    );
    expect(b.status).toBe(201);
    expect(b.body.data.subscriptionAddon).toMatchObject({
      code: 'EXTRA_STORAGE_50GB',
      status: 'ACTIVE',
      quantity: 2,
    });
    expect(callsOf('issueProrationInvoice')[0]!.input).toMatchObject({
      items: [{ addonKey: 'EXTRA_STORAGE_50GB', fromPeriodValuePaise: 0, toPeriodValuePaise: 100000 }],
    });
    const usage = await c('get', '/subscription/usage');
    expect(
      usage.body.data.items.find((i: { limitKey: string }) => i.limitKey === 'limit.storage_gb'),
    ).toMatchObject({ limit: 105, addonIncrement: 100 });
    const id = b.body.data.subscriptionAddon.id;
    const del = await c('delete', `/subscription/addons/${id}`, undefined, { query: { version: '1' } });
    expect(del.body.data).toMatchObject({ status: 'CANCEL_SCHEDULED', endsAt: '2026-11-30T18:30:00.000Z' });
    const res = await c('post', `/subscription/addons/${id}/resume`, { version: 2 });
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', endsAt: null });
    const store = await c('get', '/subscription/addons');
    expect(
      store.body.data.store.find((a: { code: string }) => a.code === 'EXTRA_STORAGE_50GB').remainingQuantity,
    ).toBe(18);
    expect(store.body.data.owned).toHaveLength(1);
  });

  it('a one-time SMS pack waits for payment and cannot be cancelled; trials cannot buy', async () => {
    const { c } = await setup({ plan: 'STANDARD' });
    const b = await c('post', '/subscription/addons', { addonCode: 'SMS_PACK_2000' }, { headers: idem() });
    expect(b.body.data.subscriptionAddon.status).toBe('PENDING_PAYMENT');
    expect(callsOf('issueOneTimeInvoice')[0]!.input).toMatchObject({
      purchaseRef: `ADDON:${b.body.data.subscriptionAddon.id}`,
      quantity: 1,
      unitPricePaise: 90000,
    });
    const del = await c('delete', `/subscription/addons/${b.body.data.subscriptionAddon.id}`, undefined, {
      query: { version: '1' },
    });
    expect(del.body.code).toBe('ADDON_NOT_CANCELLABLE');
    const t = await setup({ plan: 'STANDARD', status: 'TRIALING', name: 'Tulip Gardens CHS' });
    const tr = await t.c('post', '/subscription/addons', { addonCode: 'SMS_PACK_2000' }, { headers: idem() });
    expect(tr.body.code).toBe('ADDON_NOT_ALLOWED_IN_TRIAL');
  });

  it('FEATURE_UNLOCK: planned, invalid and included keys are refused; a valid key turns on', async () => {
    const { c } = await setup({ plan: 'STANDARD' });
    const buy = (featureKey: string) =>
      c('post', '/subscription/addons', { addonCode: 'FEATURE_UNLOCK', featureKey }, { headers: idem() });
    expect((await buy('communication.recurring_notices')).body.code).toBe('PLANNED_FEATURE');
    expect((await buy('platform.multi_society_organizations')).body.code).toBe('FEATURE_UNLOCK_KEY_INVALID');
    expect((await buy('amenities.amenity_catalogue')).body.code).toBe('FEATURE_UNLOCK_KEY_INVALID');
    expect((await buy('governance.polls_engine')).status).toBe(201);
    const e = await c('get', '/subscription/entitlements');
    expect(e.body.data.features).toContain('governance.polls_engine');
  });

  it("T04-30 another society's add-on id is 404", async () => {
    const a = await setup({ plan: 'STANDARD' });
    const b = await subSociety({ plan: 'STANDARD', name: 'Green Park CHS' });
    const ad = (await Addon.findOne({ where: { code: 'EXTRA_STORAGE_50GB' } }))!;
    const row = await SubscriptionAddon.create({
      societyId: b.society.id!,
      subscriptionId: b.sub.id!,
      addonId: ad.id!,
      addonCode: 'EXTRA_STORAGE_50GB',
      billingType: 'RECURRING',
      grants: [],
      featureKey: null,
      quantity: 1,
      unitPricePaise: 50000,
      periodKey: null,
      status: 'ACTIVE',
      startsAt: new Date(),
      endsAt: null,
      invoiceId: null,
      endedReason: null,
      createdBy: null,
      updatedBy: null,
      version: 1,
    });
    const r = await a.c('delete', `/subscription/addons/${row.id}`, undefined, { query: { version: '1' } });
    expect([r.status, r.body.code]).toEqual([404, 'SUBSCRIPTION_ADDON_NOT_FOUND']);
    const rs = await a.c('post', `/subscription/addons/${row.id}/resume`, { version: 1 });
    expect([rs.status, rs.body.code]).toEqual([404, 'SUBSCRIPTION_ADDON_NOT_FOUND']);
  });

  it('T04-23 / T04-10 feature trial: 402 on Starter, once per key on Standard, one at a time', async () => {
    const s = await setup({ plan: 'STARTER' });
    const st = await s.c(
      'post',
      '/subscription/feature-trials',
      { featureKey: 'governance.polls_engine' },
      { headers: idem() },
    );
    expect(st.status).toBe(402);
    expect(st.body.errors[0]).toMatchObject({
      field: 'entitlementKey',
      message: 'platform.premium_feature_trial',
      currentPlan: 'STARTER',
      availableIn: ['STANDARD', 'PREMIUM', 'ENTERPRISE'],
    });
    const { c } = await setup({ plan: 'STANDARD', name: 'Green Park CHS' });
    const t1 = await c(
      'post',
      '/subscription/feature-trials',
      { featureKey: 'governance.polls_engine' },
      { headers: idem() },
    );
    expect(t1.status).toBe(201);
    expect(t1.body.data).toMatchObject({
      featureKey: 'governance.polls_engine',
      expiresAt: '2026-12-01T06:30:00.000Z',
    });
    const t2 = await c(
      'post',
      '/subscription/feature-trials',
      { featureKey: 'governance.polls_engine' },
      { headers: idem() },
    );
    expect([t2.status, t2.body.code]).toEqual([409, 'FEATURE_TRIAL_USED']);
    const t3 = await c(
      'post',
      '/subscription/feature-trials',
      { featureKey: 'governance.meeting_scheduler' },
      { headers: idem() },
    );
    expect(t3.body.code).toBe('FEATURE_TRIAL_ACTIVE');
    const t4 = await c(
      'post',
      '/subscription/feature-trials',
      { featureKey: 'communication.recurring_notices' },
      { headers: idem() },
    );
    expect(t4.body.code).toBe('PLANNED_FEATURE'); // T04-52
    const sum = await c('get', '/subscription');
    expect(sum.body.data.activeFeatureTrial).toMatchObject({ featureKey: 'governance.polls_engine' });
    expect(await EntitlementOverride.count({ where: { source: 'PREMIUM_TRIAL' } })).toBe(1);
  });

  it('T04-11 a Starter society passes the feature check after a KEY override (generation bumped)', async () => {
    const { c, society } = await setup({ plan: 'STARTER' });
    const before = await c('get', '/subscription/entitlements');
    await EntitlementOverride.create({
      societyId: society.id!,
      targetType: 'KEY',
      entitlementKey: 'platform.premium_feature_trial',
      moduleNo: null,
      isEnabled: true,
      limitValue: null,
      isUnlimited: false,
      source: 'SUPPORT',
      reason: 'test override',
      startsAt: new Date('2026-11-01T00:00:00Z'),
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      expiryProcessedAt: null,
      createdBy: null,
      updatedBy: null,
      version: 1,
    } as never);
    await invalidate(society.id!);
    const after = await c('get', '/subscription/entitlements');
    expect(after.body.data.generation).toBe(before.body.data.generation + 1);
    const t = await c(
      'post',
      '/subscription/feature-trials',
      { featureKey: 'governance.polls_engine' },
      { headers: idem() },
    );
    expect(t.status).toBe(201);
  });
});

describe('cancellation (8.6.9)', () => {
  it('cancel creates an approval request; applyCancellation schedules it; withdraw clears it', async () => {
    const { c, sub } = await setup({ plan: 'STANDARD' });
    const r = await c(
      'post',
      '/subscription/cancel',
      { reason: 'Moving to another app', version: sub.version },
      { headers: idem() },
    );
    expect(r.status).toBe(202);
    expect(r.body.data.approvalRequestId).toBeTypeOf('number');
    expect(callsOf('approvals.createRequest')[0]!.input).toMatchObject({
      type: 'SUBSCRIPTION_CANCEL',
      subscriptionId: sub.id,
    });
    await sequelize.transaction(t =>
      applyCancellation(
        systemCtx('t'),
        { subscriptionId: sub.id!, requestedBy: 1, reason: 'Moving to another app' },
        t,
      ),
    );
    const s = await c('get', '/subscription');
    expect(s.body.data.cancelAtPeriodEnd).toBe(true);
    const ch = await c(
      'post',
      '/subscription/change-plan',
      { planCode: 'PREMIUM', version: s.body.data.version },
      { headers: idem() },
    );
    expect(ch.body.code).toBe('INVALID_STATE');
    const w = await c('post', '/subscription/cancel/withdraw', { version: s.body.data.version });
    expect(w.status).toBe(200);
    const again = await c('post', '/subscription/cancel/withdraw', { version: w.body.data.version });
    expect(again.body.code).toBe('NO_PENDING_CHANGE');
  });
});
