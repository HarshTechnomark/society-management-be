import { Society, Subscription, sequelize } from '../src/models';
import { addDays, now } from '../src/lib/clock';
import { DEMO_FLAGS, seedFlags, seedPlanCatalogue } from '../src/modules/subscriptions/subscriptions.seed';
import { createTrial } from '../src/modules/subscriptions/subscriptions.service';
import { invalidate, setAbsoluteUsage } from '../src/modules/subscriptions/entitlements.service';
import { reconcileUsage } from '../src/modules/subscriptions/subscriptions.usage';
import { localDate, periodFrom } from '../src/modules/subscriptions/pricing';
import { planByCode, currentVersion, chargedOf } from '../src/modules/subscriptions/subscriptions.util';
import type { PlanCode } from '../src/modules/subscriptions/subscriptions.catalogue';

/**
 * Module 04 seeders (section 7.11). `seedSubscriptionCatalogue` runs everywhere: plans, v1 versions, every catalogue key per
 * version, add-ons and the base flags (`platform.autopay`, `payments.upi_autopay`). `seedDemoSubscriptions` (not production):
 * the prototype flags and one subscription per demo society. Both are idempotent.
 */
export const seedSubscriptionCatalogue = seedPlanCatalogue;

interface DemoSub {
  slug: string;
  plan: PlanCode;
  status: 'ACTIVE' | 'TRIALING';
  flats: number;
}
/** Spec 7.11: Sky Heights CHS (72 flats) PREMIUM, Green Park CHS (30 flats) STARTER, Tulip Gardens CHS STANDARD trial. */
export const DEMO_SUBSCRIPTIONS: DemoSub[] = [
  { slug: 'sky-heights', plan: 'PREMIUM', status: 'ACTIVE', flats: 72 },
  { slug: 'green-park', plan: 'STARTER', status: 'ACTIVE', flats: 30 },
  { slug: 'tulip-gardens', plan: 'STANDARD', status: 'TRIALING', flats: 0 },
];

export async function seedDemoSubscriptions(): Promise<{
  created: string[];
  skipped: string[];
  flags: number;
}> {
  if (process.env.NODE_ENV === 'production') throw new Error('demo subscriptions must not run in production');
  const created: string[] = [];
  const skipped: string[] = [];
  const flags = await seedFlags(DEMO_FLAGS);
  for (const d of DEMO_SUBSCRIPTIONS) {
    const society = await Society.findOne({ where: { slug: d.slug } });
    if (!society) continue;
    if (await Subscription.findOne({ where: { societyId: society.id! } })) {
      skipped.push(d.slug);
      continue;
    }
    // module 08 owns flats; until it exists the demo flat count is written straight into the `limit.flats` counter
    await setAbsoluteUsage(society.id!, 'limit.flats', d.flats);
    await sequelize.transaction(async t => {
      // module 05 owns `trialEndsAt` (14-day trial from sign-up); until it exists the seed uses creation + 14 days
      const trialEndsAt = addDays(society.createdAt ?? now(), 14);
      const { subscriptionId } = await createTrial(society.id!, d.plan, trialEndsAt, t);
      if (d.status === 'TRIALING') return;
      const sub = (await Subscription.findByPk(subscriptionId, { transaction: t }))!;
      const v = await currentVersion(await planByCode(d.plan, t), t);
      const today = localDate(now(), society.timezone);
      const period = periodFrom(`${today.slice(0, 8)}01`, 1, 1);
      Object.assign(sub, {
        status: 'ACTIVE',
        statusReason: 'PAID_START',
        statusChangedAt: now(),
        paidStartedAt: now(),
        trialEndsAt: null,
        billingCycle: 'MONTHLY',
        billingAnchorDay: 1,
        currentPeriodStart: period.periodStart,
        currentPeriodEnd: period.periodEnd,
        lastInvoicedPeriodStart: period.periodStart,
        billableFlats: d.flats,
        flatSegments: [
          { fromDate: period.periodStart, toDate: null, billableFlats: chargedOf(sub, v, d.flats) },
        ],
      });
      sub.version += 1;
      await sub.save({ transaction: t });
      invalidate(society.id!, t);
    });
    created.push(`${d.slug} ${d.plan} ${d.status}`);
  }
  return { created, skipped, flags };
}

/** After memberships and roles exist: set the seat and custom-role counters from the module 03 tables. */
export const reconcileDemoUsage = (): Promise<number> => reconcileUsage();
