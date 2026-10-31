import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import {
  AuditLog,
  EntitlementOverride,
  SubscriptionAddon,
  UsageCounter,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { MemoryKv, kv, setKv } from '../../../src/lib/kv';
import { drainQueues } from '../../../src/lib/queue';
import { systemCtx } from '../../../src/types/context';
import { requireFeature } from '../../../src/middlewares/entitlement.middleware';
import {
  consumeLimit,
  currentGeneration,
  getEntitlements,
  invalidate,
  isFeatureOn,
  registerUsageProvider,
  releaseLimit,
  resolveEntitlements,
  usageProviders,
} from '../../../src/modules/subscriptions/entitlements.service';
import { reconcileUsage } from '../../../src/modules/subscriptions/subscriptions.usage';
import { Addon } from '../../../src/models';
import { join, makeSociety, memberUser } from '../../helpers/access';
import { makeUser } from '../../helpers/auth';
import { resetSubs, subSociety } from '../../helpers/subscriptions';

afterAll(closeDb);
beforeEach(async () => {
  await resetSubs();
  setNow('2026-11-17T06:30:00Z');
});

const ctxFor = (societyId: number) => ({
  ...systemCtx('t'),
  society: { id: societyId, name: 'x', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});

async function override(societyId: number, o: Partial<EntitlementOverride['_creationAttributes']>) {
  await EntitlementOverride.create({
    societyId,
    targetType: 'KEY',
    entitlementKey: null,
    moduleNo: null,
    isEnabled: null,
    limitValue: null,
    isUnlimited: false,
    source: 'SUPPORT',
    reason: 'test override',
    startsAt: new Date('2026-11-01T00:00:00Z'),
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    expiryProcessedAt: null,
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...o,
  } as never);
  await invalidate(societyId);
}

describe('resolution (BR-04-16)', () => {
  it('T04-05 plan off, add-on on, KEY override off resolves off from OVERRIDE_KEY', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD' });
    const unlock = (await Addon.findOne({ where: { code: 'FEATURE_UNLOCK' } }))!;
    await SubscriptionAddon.create({
      societyId: society.id!,
      subscriptionId: sub.id!,
      addonId: unlock.id!,
      addonCode: 'FEATURE_UNLOCK',
      billingType: 'RECURRING',
      grants: [{ type: 'FEATURE_CHOICE' }],
      featureKey: 'governance.polls_engine',
      quantity: 1,
      unitPricePaise: 99900,
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
    await invalidate(society.id!);
    expect((await getEntitlements(society.id!)).features['governance.polls_engine']).toEqual({
      on: true,
      source: 'ADDON',
    });
    await override(society.id!, { entitlementKey: 'governance.polls_engine', isEnabled: false });
    expect((await getEntitlements(society.id!)).features['governance.polls_engine']).toEqual({
      on: false,
      source: 'OVERRIDE_KEY',
    });
  });

  it('T04-06 a MODULE override off for module 16 keeps always-on keys and leaves PLANNED keys off', async () => {
    const { society } = await subSociety({ plan: 'PREMIUM' });
    await override(society.id!, { targetType: 'MODULE', moduleNo: 16, isEnabled: true });
    let e = await resolveEntitlements(society.id!);
    expect(e.features['communication.chat_groups']!.on).toBe(false); // T04-52: PLANNED stays off
    await EntitlementOverride.update({ revokedAt: new Date() }, { where: { societyId: society.id! } });
    await override(society.id!, { targetType: 'MODULE', moduleNo: 16, isEnabled: false });
    e = await resolveEntitlements(society.id!);
    expect(e.features['communication.emergency_broadcast']).toEqual({ on: true, source: 'ALWAYS_ON' });
    expect(e.features['communication.notice_composer']).toEqual({ on: false, source: 'OVERRIDE_MODULE' });
  });

  it('T04-07 admin seats on Starter with 240 flats: limit 5, committee roles not counted', async () => {
    const { society } = await subSociety({ plan: 'STARTER', flats: 240 });
    for (const r of [
      'chairman',
      'secretary',
      'treasurer',
      'committee_member',
      'committee_member',
      'committee_member',
      'committee_member',
      'society_admin',
      'accountant',
    ])
      await memberUser(society, r);
    const e = await getEntitlements(society.id!);
    expect(e.limits['limit.admin_seats']!.limit).toBe(5);
    const c = await UsageCounter.findOne({
      where: { societyId: society.id!, limitKey: 'limit.admin_seats' },
    });
    expect(Number(c!.used)).toBe(2);
  });

  it('a cancelled society (no live subscription) gets always-on keys and zero limits', async () => {
    const s = await makeSociety('No Plan CHS');
    const e = await getEntitlements(s.id!);
    expect(Object.values(e.features).filter(f => f.on)).toHaveLength(14);
    expect(e.limits['limit.flats']!.limit).toBe(0);
  });

  it('T04-54 / T04-10 middleware: always-on passes on Starter; a Standard key gives the 402 body of 8.1', async () => {
    const { society } = await subSociety({ plan: 'STARTER' });
    const run = async (mw: ReturnType<typeof requireFeature>) => {
      let out: unknown = 'not called';
      await mw({ ctx: ctxFor(society.id!) } as unknown as Request, {} as never, (e?: unknown) => {
        out = e;
      });
      return out as { status: number; code: string; errors: Record<string, unknown>[] } | undefined;
    };
    expect(await run(requireFeature('communication.i_m_safe_check_in'))).toBeUndefined();
    const err = (await run(requireFeature('amenities.amenity_catalogue')))!;
    expect(err.status).toBe(402);
    expect(err.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(err.errors[0]).toEqual({
      field: 'entitlementKey',
      message: 'amenities.amenity_catalogue',
      currentPlan: 'STARTER',
      availableIn: ['STANDARD', 'PREMIUM', 'ENTERPRISE'],
      unlockAddon: 'FEATURE_UNLOCK',
    });
    const planned = (await run(requireFeature('communication.chat_groups')))!;
    expect(planned.errors[0]!.availableIn).toEqual([]);
    expect(() => requireFeature('nope.not_a_key' as never)).toThrow(/unknown entitlement key/);
  });

  it('T04-39 with the cache store down, requireFeature resolves from MySQL with the right answer', async () => {
    const { society } = await subSociety({ plan: 'STANDARD' });
    const broken = new Proxy(new MemoryKv(), {
      get: (target, prop) =>
        typeof (target as never)[prop] === 'function'
          ? () => Promise.reject(new Error('redis down'))
          : (target as never)[prop],
    });
    setKv(broken as never);
    expect(await isFeatureOn(society.id!, 'amenities.amenity_catalogue')).toBe(true);
    expect(await isFeatureOn(society.id!, 'accounting.journal_engine')).toBe(false);
  });

  it('cache: invalidate bumps the generation; a new override is seen on the next read', async () => {
    const { society } = await subSociety({ plan: 'STARTER' });
    const g0 = await currentGeneration(society.id!);
    expect(await isFeatureOn(society.id!, 'amenities.amenity_catalogue')).toBe(false);
    await sequelize.transaction(async t => {
      await EntitlementOverride.create(
        {
          societyId: society.id!,
          targetType: 'KEY',
          entitlementKey: 'amenities.amenity_catalogue',
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
        } as never,
        { transaction: t },
      );
      invalidate(society.id!, t);
      expect(await currentGeneration(society.id!)).toBe(g0); // only after commit
    });
    expect(await currentGeneration(society.id!)).toBe(g0 + 1);
    expect(await isFeatureOn(society.id!, 'amenities.amenity_catalogue')).toBe(true);
    expect(await kv().cacheGet(`ent:v1:${society.id}:${g0 + 1}`)).not.toBeNull();
  });
});

describe('usage counters (BR-04-19 to BR-04-21)', () => {
  it('T04-12 20 parallel consumes with 3 free: exactly 3 succeed', async () => {
    const { society } = await subSociety({ plan: 'STANDARD' });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        sequelize.transaction(t =>
          consumeLimit(ctxFor(society.id!), 'limit.guard_devices', 1, { transaction: t }),
        ),
      ),
    );
    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(17);
    expect(failed.every(f => f.reason.code === 'USAGE_LIMIT_EXCEEDED' && f.reason.status === 402)).toBe(true);
    expect(failed[0]!.reason.errors[0]).toMatchObject({
      field: 'limitKey',
      message: 'limit.guard_devices',
      limit: 3,
      requested: 1,
    });
  });

  it('T04-13 a rolled-back transaction leaves the counter unchanged', async () => {
    const { society } = await subSociety({ plan: 'STANDARD' });
    await expect(
      sequelize.transaction(async t => {
        await consumeLimit(ctxFor(society.id!), 'limit.guard_devices', 2, { transaction: t });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const c = await UsageCounter.findOne({
      where: { societyId: society.id!, limitKey: 'limit.guard_devices' },
    });
    expect(Number(c?.used ?? 0)).toBe(0);
  });

  it('T04-14 / T04-15 soft SMS limit: 2,001st allowed with overLimit, one 100 % warning, ceiling at 2 × limit', async () => {
    const { society } = await subSociety({ plan: 'STANDARD' });
    const ctx = ctxFor(society.id!);
    await sequelize.transaction(t => consumeLimit(ctx, 'limit.sms_per_month', 2000, { transaction: t }));
    const r = await sequelize.transaction(t =>
      consumeLimit(ctx, 'limit.sms_per_month', 1, { transaction: t }),
    );
    expect(r).toEqual({ used: 2001, limit: 2000, overLimit: true });
    await sequelize.transaction(t => consumeLimit(ctx, 'limit.sms_per_month', 1, { transaction: t }));
    const row = (await UsageCounter.findOne({
      where: { societyId: society.id!, limitKey: 'limit.sms_per_month' },
    }))!;
    expect(row.periodKey).toBe('2026-11-01');
    expect(row.lastWarnedPct).toBe(100);
    await drainQueues();
    await sequelize.transaction(t => consumeLimit(ctx, 'limit.sms_per_month', 1998, { transaction: t })); // 4000
    await expect(
      sequelize.transaction(t => consumeLimit(ctx, 'limit.sms_per_month', 1, { transaction: t })),
    ).rejects.toMatchObject({ status: 402, code: 'USAGE_LIMIT_EXCEEDED' });
  });

  it('programmer errors: no transaction, MONTHLY release, bad amount', async () => {
    const { society } = await subSociety({ plan: 'STANDARD' });
    const ctx = ctxFor(society.id!);
    await expect(consumeLimit(ctx, 'limit.guard_devices', 1, {} as never)).rejects.toThrow(/transaction/);
    await expect(
      sequelize.transaction(t => releaseLimit(ctx, 'limit.sms_per_month', 1, { transaction: t })),
    ).rejects.toThrow(/MONTHLY/);
    await expect(
      sequelize.transaction(t => consumeLimit(ctx, 'limit.guard_devices', 0, { transaction: t })),
    ).rejects.toThrow(/1\.\.1000000/);
    // release never goes below zero
    await sequelize.transaction(t => releaseLimit(ctx, 'limit.guard_devices', 5, { transaction: t }));
  });

  it('module 03 port: seats are consumed with a system context through opts.societyId and refused at the limit', async () => {
    const { society } = await subSociety({ plan: 'STARTER', flats: 30 }); // 2 seats
    await memberUser(society, 'society_admin');
    await memberUser(society, 'accountant');
    await expect(memberUser(society, 'facility_manager')).rejects.toMatchObject({
      code: 'USAGE_LIMIT_EXCEEDED',
    });
    void join;
  });

  it('T04-40 reconcile sets a drifted counter to the provider count and audits it', async () => {
    const { society } = await subSociety({ plan: 'STANDARD' });
    await sequelize.transaction(t =>
      consumeLimit(ctxFor(society.id!), 'limit.guard_devices', 3, { transaction: t }),
    );
    registerUsageProvider('limit.guard_devices', async () => 1);
    await reconcileUsage(society.id!);
    const c = (await UsageCounter.findOne({
      where: { societyId: society.id!, limitKey: 'limit.guard_devices' },
    }))!;
    expect(Number(c.used)).toBe(1);
    expect(
      await AuditLog.count({ where: { action: 'subscriptions.usage.reconciled', societyId: society.id! } }),
    ).toBeGreaterThan(0);
    usageProviders.delete('limit.guard_devices');
    void makeUser;
  });
});
