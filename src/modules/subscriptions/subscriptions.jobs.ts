import { Op } from 'sequelize';
import { EntitlementOverride, SubscriptionAddon, sequelize } from '../../models';
import { addDays, addMinutes, istDate, now } from '../../lib/clock';
import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { FEATURE_BY_KEY } from './subscriptions.catalogue';
import { SUBSCRIPTIONS_QUEUE, invalidate } from './entitlements.service';
import { endAddon, runRenewals } from './subscriptions.service';
import { closeUsageMonths, purgeUsage, reconcileUsage, sendUsageThreshold } from './subscriptions.usage';
import { applyMigration } from './subscriptions.plans.service';
import { staleFlags } from './flags.service';
import { notifyViewers } from './subscriptions.util';

/** Queue `subscriptions` (section 9.1). Payloads carry ids only; every processor is safe to run twice. */
const SYSTEM: Ctx = { requestId: 'job', ip: '', userAgent: '' };

/** Overrides whose `expiresAt` passed: invalidate, audit, notify trial end; 2 days before a trial ends, a reminder. */
export async function processOverrideExpiry(): Promise<number> {
  const at = now();
  const due = await EntitlementOverride.findAll({
    where: { expiresAt: { [Op.lte]: at }, expiryProcessedAt: null },
    attributes: ['id'],
    limit: 500,
  });
  let n = 0;
  for (const d of due)
    await sequelize.transaction(async t => {
      const o = await EntitlementOverride.findByPk(d.id!, { transaction: t, lock: t.LOCK.UPDATE });
      if (!o || o.expiryProcessedAt) return;
      o.expiryProcessedAt = now();
      await o.save({ transaction: t });
      await audit(
        SYSTEM,
        {
          action: 'subscriptions.override.expired',
          entityType: 'entitlement_override',
          entityId: o.id!,
          entityLabel: o.entitlementKey ?? `module ${o.moduleNo}`,
          societyId: o.societyId,
          after: { expiresAt: o.expiresAt },
        },
        t,
      );
      if (o.source === 'PREMIUM_TRIAL')
        notifyViewers(t, o.societyId, 'subscription.feature_trial_ended', {
          featureTitle: FEATURE_BY_KEY.get(o.entitlementKey ?? '')?.title ?? o.entitlementKey,
        });
      invalidate(o.societyId, t);
      n += 1;
    });
  // reminder window: trials ending between 2 days and 2 days + 15 minutes from now (the job runs every 15 minutes)
  const ending = await EntitlementOverride.findAll({
    where: {
      source: 'PREMIUM_TRIAL',
      revokedAt: null,
      expiresAt: { [Op.gt]: addDays(at, 2), [Op.lte]: addMinutes(addDays(at, 2), 15) },
    },
  });
  for (const o of ending)
    await sequelize.transaction(async t =>
      notifyViewers(t, o.societyId, 'subscription.feature_trial_ending', {
        featureTitle: FEATURE_BY_KEY.get(o.entitlementKey ?? '')?.title ?? o.entitlementKey,
        expiresAt: o.expiresAt!.toISOString().slice(0, 10),
      }),
    );
  return n;
}

/** ONE_TIME packs past `endsAt` → ENDED (EXPIRED); recurring scheduled cancellations past `endsAt` → ENDED (CANCELLED). */
export async function processAddonExpiry(): Promise<number> {
  const due = await SubscriptionAddon.findAll({
    where: { status: ['ACTIVE', 'CANCEL_SCHEDULED'], endsAt: { [Op.lte]: now() } },
    attributes: ['id'],
    limit: 500,
  });
  let n = 0;
  for (const d of due)
    await sequelize.transaction(async t => {
      const a = await SubscriptionAddon.findByPk(d.id!, { transaction: t, lock: t.LOCK.UPDATE });
      if (!a || a.status === 'ENDED' || a.status === 'PENDING_PAYMENT' || !a.endsAt || a.endsAt > now())
        return;
      await endAddon(SYSTEM, a, a.billingType === 'ONE_TIME' ? 'EXPIRED' : 'CANCELLED', t);
      invalidate(a.societyId, t);
      n += 1;
    });
  return n;
}

let registered = false;
export function registerSubscriptionJobs(): void {
  if (registered) return;
  registered = true;
  registerQueue(SUBSCRIPTIONS_QUEUE, 'Renewals, usage months, overrides, add-ons, flags', 3);
  const job = (name: string, fn: (data: Record<string, unknown>) => Promise<unknown>) =>
    registerProcessor(SUBSCRIPTIONS_QUEUE, `subscriptions:${name}`, fn);
  job('renewals', () => runRenewals());
  job('close-usage-months', () => closeUsageMonths());
  job('apply-migration', d =>
    applyMigration(
      { ...SYSTEM, user: undefined },
      d.subscriptionIds as number[],
      d.targetVersionId as number,
      d.noticeDays as number,
      String(d.reason ?? 'Plan version migration'),
    ),
  );
  job('override-expiry', () => processOverrideExpiry());
  job('addon-expiry', () => processAddonExpiry());
  job('usage-threshold', d => sendUsageThreshold(d as { societyId: number; limitKey: string; pct: number }));
  job('usage-reconcile', () => reconcileUsage());
  // the scheduler has no monthly or weekly cadence: purge runs daily (cheap, idempotent); the stale-flag reminder acts on Mondays
  job('usage-purge', () => purgeUsage());
  job('flag-stale-reminder', async () =>
    new Date(`${istDate()}T00:00:00Z`).getUTCDay() === 1 ? staleFlags() : [],
  );
  registerRepeatable(SUBSCRIPTIONS_QUEUE, 'subscriptions:renewals', { dailyAtIst: '00:15' });
  registerRepeatable(SUBSCRIPTIONS_QUEUE, 'subscriptions:close-usage-months', { dailyAtIst: '00:20' });
  registerRepeatable(SUBSCRIPTIONS_QUEUE, 'subscriptions:override-expiry', { everyMs: 15 * 60_000 });
  registerRepeatable(SUBSCRIPTIONS_QUEUE, 'subscriptions:addon-expiry', { hourlyAtMinute: 5 });
  registerRepeatable(SUBSCRIPTIONS_QUEUE, 'subscriptions:usage-reconcile', { dailyAtIst: '03:00' });
  registerRepeatable(SUBSCRIPTIONS_QUEUE, 'subscriptions:usage-purge', { dailyAtIst: '03:30' });
  registerRepeatable(SUBSCRIPTIONS_QUEUE, 'subscriptions:flag-stale-reminder', { dailyAtIst: '10:00' });
}
