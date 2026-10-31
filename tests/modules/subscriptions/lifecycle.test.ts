import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  EntitlementOverride,
  Subscription,
  SubscriptionAddon,
  UsageCounter,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { systemCtx, type Ctx } from '../../../src/types/context';
import {
  consumeLimit,
  currentGeneration,
  getEntitlements,
  isFeatureOn,
  setAbsoluteUsage,
} from '../../../src/modules/subscriptions/entitlements.service';
import {
  applyCancellation,
  cancelForClosure,
  changePlan,
  createInitial,
  getBillingSnapshot,
  listDueForInvoicing,
  onFlatCountChanged,
  onPlatformInvoicePaid,
  runRenewals,
  setAutopay,
  startPaid,
} from '../../../src/modules/subscriptions/subscriptions.service';
import { buyAddon } from '../../../src/modules/subscriptions/subscriptions.society.service';
import { closeUsageMonths } from '../../../src/modules/subscriptions/subscriptions.usage';
import {
  processAddonExpiry,
  processOverrideExpiry,
} from '../../../src/modules/subscriptions/subscriptions.jobs';
import { makeSociety } from '../../helpers/access';
import { callsOf, resetSubs, subSociety } from '../../helpers/subscriptions';

afterAll(closeDb);
beforeEach(async () => {
  await resetSubs();
  setNow('2026-11-17T06:30:00Z');
});

const ctxFor = (societyId: number): Ctx => ({
  ...systemCtx('t'),
  user: { id: 1, name: 'Tester', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
  society: { id: societyId, name: 'x', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});
const reload = async (id: number) => (await Subscription.findByPk(id))!;

describe('renewal (6.5)', () => {
  it('T04-17 a scheduled downgrade applies at renewal; Premium keys stay readable for 90 days', async () => {
    const { society, sub } = await subSociety({ plan: 'PREMIUM' });
    await changePlan(
      ctxFor(society.id!),
      society.id!,
      { planCode: 'STANDARD', version: sub.version },
      'SOCIETY',
    );
    setNow('2026-12-01T00:30:00Z');
    expect(await runRenewals()).toBe(1);
    const s = await reload(sub.id!);
    expect(s.currentPeriodStart).toBe('2026-12-01');
    expect(s.downgradedAt).not.toBeNull();
    expect(s.downgradedFromPlanVersionId).toBe(sub.planVersionId);
    expect((await getEntitlements(society.id!)).planCode).toBe('STANDARD');
    expect(await isFeatureOn(society.id!, 'governance.polls_engine', 'read')).toBe(true);
    expect(await isFeatureOn(society.id!, 'governance.polls_engine', 'write')).toBe(false);
    expect(callsOf('issuePeriodInvoice')).toHaveLength(1);
    expect(await AuditLog.count({ where: { action: 'subscriptions.subscription.downgrade_applied' } })).toBe(
      1,
    );
    setNow('2027-03-02T00:30:00Z');
    expect(await isFeatureOn(society.id!, 'governance.polls_engine', 'read')).toBe(false);
  });

  it('a downgrade blocked by usage at renewal is postponed, then cleared after two postponements', async () => {
    const { society, sub } = await subSociety({ plan: 'PREMIUM' });
    await changePlan(
      ctxFor(society.id!),
      society.id!,
      { planCode: 'STANDARD', version: sub.version },
      'SOCIETY',
    );
    await setAbsoluteUsage(society.id!, 'limit.automation_rules', 5);
    setNow('2026-12-01T00:30:00Z');
    await runRenewals();
    let s = await reload(sub.id!);
    expect([s.pendingChangeType, s.pendingChangeAt, s.pendingPostponements]).toEqual([
      'DOWNGRADE',
      '2027-01-01',
      1,
    ]);
    setNow('2027-01-01T00:30:00Z');
    await runRenewals();
    setNow('2027-02-01T00:30:00Z');
    await runRenewals();
    s = await reload(sub.id!);
    expect([s.pendingChangeType, s.pendingPostponements]).toEqual([null, 0]);
    expect((await getEntitlements(society.id!)).planCode).toBe('PREMIUM');
  });

  it('T04-41 flats 60 → 75 on day 11, then renewal and getBillingSnapshot', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    setNow('2026-11-11T06:30:00Z');
    await setAbsoluteUsage(society.id!, 'limit.flats', 75);
    await sequelize.transaction(t => onFlatCountChanged(ctxFor(society.id!), society.id!, t));
    setNow('2026-12-01T00:30:00Z');
    await runRenewals();
    const snap = await getBillingSnapshot(sub.id!, '2026-12-01');
    expect(snap).toMatchObject({
      planKey: 'STANDARD',
      billableFlats: 75,
      pricePerFlatPerMonthPaise: 1500,
      annualFreeMonths: 0,
      periodEnd: '2026-12-31',
    });
    expect(snap.previousPeriod!.flatSegments).toEqual([
      { fromDate: '2026-11-01', toDate: '2026-11-10', billableFlats: 60 },
      { fromDate: '2026-11-11', toDate: '2026-11-30', billableFlats: 75 },
    ]);
    // T04-43
    await expect(getBillingSnapshot(sub.id!, '2026-11-01')).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_STATE',
    });
  });

  it('T04-42 listDueForInvoicing renews first and returns the new period once', async () => {
    const { sub } = await subSociety({ plan: 'STANDARD' });
    setNow('2026-12-02T00:30:00Z');
    const due = await listDueForInvoicing('2026-12-02');
    expect(due.filter(d => d.subscriptionId === sub.id)).toEqual([
      { subscriptionId: sub.id, periodStart: '2026-12-01' },
    ]);
    expect((await reload(sub.id!)).currentPeriodStart).toBe('2026-12-01');
  });

  it('cancellation at period end cancels at renewal and calls module 05', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD' });
    await sequelize.transaction(t =>
      applyCancellation(
        ctxFor(society.id!),
        { subscriptionId: sub.id!, requestedBy: 1, reason: 'Closing down' },
        t,
      ),
    );
    setNow('2026-12-01T00:30:00Z');
    await runRenewals();
    const s = await reload(sub.id!);
    expect([s.status, s.statusReason]).toEqual(['CANCELLED', 'CANCELLED_AT_PERIOD_END']);
    expect(callsOf('closeForSubscriptionCancellation')).toHaveLength(1);
    expect(Object.values((await getEntitlements(society.id!)).features).filter(f => f.on)).toHaveLength(14);
  });
});

describe('module 05 and 06 interfaces (8.9)', () => {
  it('T04-27 createInitial ACTIVE issues the period invoice in the caller transaction; a rollback leaves nothing', async () => {
    const society = await makeSociety('New CHS');
    let tx: unknown;
    await expect(
      sequelize.transaction(async t => {
        tx = t;
        const r = await createInitial(
          ctxFor(society.id!),
          { societyId: society.id!, planKey: 'STANDARD', billingCycle: 'MONTHLY', startAs: 'ACTIVE' },
          t,
        );
        expect(r.invoice).not.toBeNull();
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    expect(callsOf('issuePeriodInvoice')[0]!.t).toBe(tx);
    expect(await Subscription.count({ where: { societyId: society.id! } })).toBe(0);
    await sequelize.transaction(t =>
      createInitial(
        ctxFor(society.id!),
        { societyId: society.id!, planKey: 'STANDARD', billingCycle: 'MONTHLY', startAs: 'ACTIVE' },
        t,
      ),
    );
    const s = (await Subscription.findOne({ where: { societyId: society.id! } }))!;
    expect([s.status, s.billingAnchorDay, s.currentPeriodStart, s.currentPeriodEnd]).toEqual([
      'ACTIVE',
      17,
      '2026-11-17',
      '2026-12-16',
    ]);
  });

  it('T04-28 / T04-29 reopen gets a new row; two live rows violate the unique index', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD' });
    await sequelize.transaction(t => cancelForClosure(ctxFor(society.id!), society.id!, t));
    await sequelize.transaction(t =>
      startPaid(
        ctxFor(society.id!),
        { societyId: society.id!, planKey: 'STARTER', billingCycle: 'ANNUAL' },
        t,
      ),
    );
    const rows = await Subscription.findAll({ where: { societyId: society.id! }, order: [['id', 'ASC']] });
    expect(rows.map(r => [r.id, r.status, r.statusReason])).toEqual([
      [sub.id, 'CANCELLED', 'SOCIETY_CLOSED'],
      [rows[1]!.id, 'ACTIVE', 'PAID_START'],
    ]);
    const copy = rows[1]!.get({ plain: true }) as Record<string, unknown>;
    delete copy.id;
    await expect(Subscription.create(copy as never)).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
    });
  });

  it('T04-45 trial cancellation approved cancels now and calls module 05 in the same transaction', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', status: 'TRIALING' });
    let tx: unknown;
    await sequelize.transaction(async t => {
      tx = t;
      await applyCancellation(
        ctxFor(society.id!),
        { subscriptionId: sub.id!, requestedBy: 1, reason: 'Not for us' },
        t,
      );
    });
    expect([(await reload(sub.id!)).status, (await reload(sub.id!)).statusReason]).toEqual([
      'CANCELLED',
      'TRIAL_CANCELLED',
    ]);
    expect(callsOf('closeForSubscriptionCancellation')[0]!.t).toBe(tx);
  });

  it('T04-44 setAutopay is 404 while the flag platform.autopay is off', async () => {
    const { sub } = await subSociety({ plan: 'STANDARD' });
    await expect(
      sequelize.transaction(t => setAutopay(systemCtx('t'), sub.id!, { autopayStatus: 'ACTIVE' }, t)),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('T04-25 an SMS pack activates once when its invoice is paid; +2000 for this usage month only', async () => {
    const { society } = await subSociety({ plan: 'STANDARD' });
    const ctx = ctxFor(society.id!);
    const r = await buyAddon(ctx, { addonCode: 'SMS_PACK_2000', quantity: 1 });
    expect((await getEntitlements(society.id!)).limits['limit.sms_per_month']!.limit).toBe(2000);
    await sequelize.transaction(t => onPlatformInvoicePaid(ctx, r.invoiceId!, t));
    await sequelize.transaction(t => onPlatformInvoicePaid(ctx, r.invoiceId!, t));
    const row = (await SubscriptionAddon.findByPk(r.subscriptionAddon.id))!;
    expect([row.status, row.periodKey, row.endsAt?.toISOString()]).toEqual([
      'ACTIVE',
      '2026-11-01',
      '2026-11-30T18:30:00.000Z',
    ]);
    expect(await AuditLog.count({ where: { action: 'subscriptions.subscription_addon.activated' } })).toBe(1);
    expect((await getEntitlements(society.id!)).limits['limit.sms_per_month']!.limit).toBe(4000);
    setNow('2026-12-01T00:30:00Z');
    expect((await getEntitlements(society.id!)).limits['limit.sms_per_month']!.limit).toBe(2000);
    expect(await processAddonExpiry()).toBe(1);
    expect((await SubscriptionAddon.findByPk(row.id!))!.endedReason).toBe('EXPIRED');
  });
});

describe('overage (BR-04-21)', () => {
  it('T04-49 annual society: one OVERAGE invoice at month close; a rerun makes no second call', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', cycle: 'ANNUAL' });
    await sequelize.transaction(t =>
      consumeLimit(ctxFor(society.id!), 'limit.sms_per_month', 2300, { transaction: t }),
    );
    setNow('2026-12-01T00:30:00Z');
    await closeUsageMonths();
    await closeUsageMonths();
    const calls = callsOf('issueOneTimeInvoice');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      purchaseRef: `OVERAGE:${sub.id}:2026-11-01:limit.sms_per_month`,
      quantity: 300,
      unitPricePaise: 25,
      lineType: 'OVERAGE',
    });
    const c = (await UsageCounter.findOne({
      where: { societyId: society.id!, limitKey: 'limit.sms_per_month', periodKey: '2026-11-01' },
    }))!;
    expect([
      Number(c.overageUnits),
      c.cycleAtClose,
      c.overageInvoiceId !== null,
      Number(c.limitAtClose),
    ]).toEqual([300, 'ANNUAL', true, 2000]);
  });

  it('T04-50 monthly society: the next snapshot carries the overage and no one-time invoice is issued', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD' });
    await sequelize.transaction(t =>
      consumeLimit(ctxFor(society.id!), 'limit.sms_per_month', 2300, { transaction: t }),
    );
    setNow('2026-12-01T00:30:00Z');
    await runRenewals();
    const snap = await getBillingSnapshot(sub.id!, '2026-12-01');
    expect(snap.previousPeriod!.overages).toEqual([
      { limitKey: 'limit.sms_per_month', label: 'SMS above plan limit', quantity: 300, unitPricePaise: 25 },
    ]);
    expect(callsOf('issueOneTimeInvoice')).toHaveLength(0);
  });
});

describe('override expiry job', () => {
  it('closes expired overrides once, audits and bumps the generation', async () => {
    const { society } = await subSociety({ plan: 'STANDARD' });
    await EntitlementOverride.create({
      societyId: society.id!,
      targetType: 'KEY',
      entitlementKey: 'governance.polls_engine',
      moduleNo: null,
      isEnabled: true,
      limitValue: null,
      isUnlimited: false,
      source: 'PREMIUM_TRIAL',
      reason: 'Premium feature trial',
      startsAt: new Date('2026-11-01T00:00:00Z'),
      expiresAt: new Date('2026-11-15T00:00:00Z'),
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      expiryProcessedAt: null,
      createdBy: null,
      updatedBy: null,
      version: 1,
    } as never);
    const g = await currentGeneration(society.id!);
    expect(await processOverrideExpiry()).toBe(1);
    expect(await processOverrideExpiry()).toBe(0);
    expect(await currentGeneration(society.id!)).toBe(g + 1);
    expect(await AuditLog.count({ where: { action: 'subscriptions.override.expired' } })).toBe(1);
    expect(await isFeatureOn(society.id!, 'governance.polls_engine')).toBe(false);
  });
});
