import { Society, Subscription, sequelize } from '../../src/models';
import { MemoryKv, setKv } from '../../src/lib/kv';
import { drainQueues } from '../../src/lib/queue';
import { registerSubscriptions } from '../../src/modules/subscriptions/subscriptions.public';
import {
  integrationCalls,
  setSubscriptionIntegrations,
} from '../../src/modules/subscriptions/subscriptions.integrations';
import { DEMO_FLAGS, seedFlags, seedPlanCatalogue } from '../../src/modules/subscriptions/subscriptions.seed';
import {
  clearVersionRowsCache,
  setAbsoluteUsage,
} from '../../src/modules/subscriptions/entitlements.service';
import { createTrial } from '../../src/modules/subscriptions/subscriptions.service';
import { periodFrom } from '../../src/modules/subscriptions/pricing';
import { chargedOf, currentVersion, planByCode } from '../../src/modules/subscriptions/subscriptions.util';
import type { PlanCode } from '../../src/modules/subscriptions/subscriptions.catalogue';
import { now } from '../../src/lib/clock';
import { makeSociety, resetAccess } from './access';

let catalogueReady = false;

/** Rebuilds plans, versions, entitlement rows, add-ons and flags from the seed (DELETE keeps ids unique across tests). */
export async function resetCatalogue(): Promise<void> {
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [
    'feature_flag_overrides',
    'feature_flags',
    'plan_entitlements',
    'addons',
    'plan_versions',
    'plans',
  ])
    await sequelize.query(`DELETE FROM ${t}`);
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  clearVersionRowsCache();
  await seedPlanCatalogue();
  await seedFlags(DEMO_FLAGS);
  catalogueReady = true;
}

/** Fresh society data, memory cache, real module 04 ports and recording module 05/06 stubs. */
export async function resetSubs(o: { catalogue?: boolean } = {}): Promise<void> {
  await drainQueues();
  setKv(new MemoryKv());
  await resetAccess();
  registerSubscriptions();
  setSubscriptionIntegrations();
  integrationCalls.length = 0;
  if (o.catalogue || !catalogueReady) await resetCatalogue();
  else {
    await sequelize.query('DELETE FROM feature_flag_overrides');
    await sequelize.query("DELETE FROM plan_versions WHERE status = 'DRAFT'");
  }
}

export interface SubSocietyOpts {
  plan?: PlanCode;
  status?: 'ACTIVE' | 'TRIALING';
  flats?: number;
  cycle?: 'MONTHLY' | 'ANNUAL';
  anchor?: number;
  /** First day of the current period (defaults to the 1st of the frozen month). */
  periodStart?: string;
  name?: string;
  societyStatus?: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED';
}

/** A society with roles and a subscription (ACTIVE by default, MONTHLY, anchor 1, period of the current month). */
export async function subSociety(o: SubSocietyOpts = {}): Promise<{ society: Society; sub: Subscription }> {
  const society = await makeSociety(o.name ?? 'Sky Heights CHS', {
    status: o.societyStatus ?? (o.status === 'TRIALING' ? 'TRIAL' : 'ACTIVE'),
  });
  if (o.flats !== undefined) await setAbsoluteUsage(society.id!, 'limit.flats', o.flats);
  const plan = o.plan ?? 'STANDARD';
  const { subscriptionId } = await sequelize.transaction(t =>
    createTrial(
      society.id!,
      plan === 'ENTERPRISE' ? 'PREMIUM' : plan,
      new Date(now().getTime() + 14 * 86_400_000),
      t,
    ),
  );
  const sub = (await Subscription.findByPk(subscriptionId))!;
  if ((o.status ?? 'ACTIVE') === 'ACTIVE') {
    const v = await currentVersion(await planByCode(plan));
    const anchor = o.anchor ?? 1;
    const start = o.periodStart ?? `${now().toISOString().slice(0, 8)}${String(anchor).padStart(2, '0')}`;
    const cycle = o.cycle ?? 'MONTHLY';
    const p = periodFrom(start, anchor, cycle === 'ANNUAL' ? 12 : 1);
    const flats = o.flats ?? 0;
    if (plan === 'ENTERPRISE') {
      sub.planId = (await planByCode('ENTERPRISE')).id!;
      sub.customPricePerFlatPaise = 2000;
    }
    sub.planVersionId = v.id!;
    Object.assign(sub, {
      status: 'ACTIVE',
      statusReason: 'PAID_START',
      paidStartedAt: now(),
      billingCycle: cycle,
      billingAnchorDay: anchor,
      currentPeriodStart: p.periodStart,
      currentPeriodEnd: p.periodEnd,
      lastInvoicedPeriodStart: p.periodStart,
      billableFlats: flats,
      flatSegments: [{ fromDate: p.periodStart, toDate: null, billableFlats: chargedOf(sub, v, flats) }],
    });
    sub.version += 1;
    await sub.save();
  }
  setKv(new MemoryKv());
  return { society, sub: (await Subscription.findByPk(sub.id!))! };
}

export const callsOf = (fn: string) => integrationCalls.filter(c => c.fn === fn);
