import { Op } from 'sequelize';
import { Society, Subscription, SubscriptionAddon, UsageCounter, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { BYTES_PER_GB, LIMITS, LIMIT_BY_KEY } from './subscriptions.catalogue';
import {
  counterLimit,
  getEntitlements,
  loadVersionRows,
  periodKeyFor,
  setAbsoluteUsage,
  usageProviders,
  versionLimit,
  flatsCount,
} from './entitlements.service';
import { integrations } from './subscriptions.integrations';
import { addDaysYmd, addMonthsAnchored, localDate, parseYmd, usageMonth } from './pricing';
import { notifyViewers } from './subscriptions.util';

const SYSTEM: Ctx = { requestId: 'job', ip: '', userAgent: '' };

/** Effective limit of a usage month at close (plan + recurring add-ons + that month's packs, or a KEY override). */
async function limitForMonth(
  sub: Subscription | null,
  key: string,
  periodKey: string,
): Promise<number | null> {
  if (!sub) return 0;
  const ent = await getEntitlements(sub.societyId);
  const l = ent.limits[key];
  if (!l) return 0;
  if (l.overrideApplied) return l.limit;
  const rows = await loadVersionRows(sub.planVersionId);
  const base = versionLimit(rows, key, await flatsCount(sub.societyId));
  if (base === null) return null;
  const addons = await SubscriptionAddon.findAll({
    where: {
      subscriptionId: sub.id!,
      [Op.or]: [
        { billingType: 'RECURRING', status: ['ACTIVE', 'CANCEL_SCHEDULED'] },
        { billingType: 'ONE_TIME', periodKey, status: ['ACTIVE', 'ENDED'] },
      ],
    },
  });
  let inc = 0;
  for (const a of addons)
    for (const g of a.grants) if (g.type === 'LIMIT_INCREMENT' && g.key === key) inc += g.amount * a.quantity;
  return base + inc;
}

/**
 * Job `subscriptions:close-usage-months` (BR-04-21): closes usage months that ended, records `overageUnits` for SOFT
 * limits and `cycleAtClose`; ANNUAL subscriptions get a one-time OVERAGE invoice at close. Storage (ABSOLUTE SOFT) gets a
 * month snapshot row first. Safe to run twice (`closedAt IS NULL` under a row lock; module 06 dedupes `purchaseRef`).
 */
export async function closeUsageMonths(onlySocietyId?: number): Promise<number> {
  const subs = await Subscription.findAll({
    where: { status: { [Op.ne]: 'CANCELLED' }, ...(onlySocietyId ? { societyId: onlySocietyId } : {}) },
  });
  const anchors = new Map(subs.map(s => [s.societyId, s]));
  // storage snapshots for the month that just ended
  for (const s of subs) {
    const society = await Society.findByPk(s.societyId, { attributes: ['id', 'timezone'] });
    const current = usageMonth(localDate(now(), society?.timezone), s.billingAnchorDay).periodStart;
    const prev = addMonthsAnchored(current, s.billingAnchorDay, -1);
    if (s.createdAt && localDate(s.createdAt, society?.timezone) >= current) continue;
    const exists = await UsageCounter.findOne({
      where: { societyId: s.societyId, limitKey: 'limit.storage_gb', periodKey: prev },
    });
    if (exists) continue;
    const all = await UsageCounter.findOne({
      where: { societyId: s.societyId, limitKey: 'limit.storage_gb', periodKey: 'ALL' },
    });
    await UsageCounter.create({
      societyId: s.societyId,
      limitKey: 'limit.storage_gb',
      periodKey: prev,
      used: Number(all?.used ?? 0),
      lastWarnedPct: 0,
      closedAt: null,
      limitAtClose: null,
      overageUnits: 0,
      cycleAtClose: null,
      overageInvoiceId: null,
      lastReconciledAt: null,
    }).catch(() => undefined);
  }

  const open = await UsageCounter.findAll({
    where: {
      closedAt: null,
      periodKey: { [Op.ne]: 'ALL' },
      ...(onlySocietyId ? { societyId: onlySocietyId } : {}),
    },
    attributes: ['id', 'societyId', 'periodKey'],
  });
  let closed = 0;
  for (const row of open) {
    const sub = anchors.get(row.societyId) ?? null;
    const society = await Society.findByPk(row.societyId, { attributes: ['id', 'timezone'] });
    const current = usageMonth(
      localDate(now(), society?.timezone),
      sub?.billingAnchorDay ?? parseYmd(row.periodKey).d,
    ).periodStart;
    if (row.periodKey >= current) continue;
    try {
      await sequelize.transaction(async t => {
        const c = await UsageCounter.findByPk(row.id!, { transaction: t, lock: t.LOCK.UPDATE });
        if (!c || c.closedAt) return;
        const def = LIMIT_BY_KEY.get(c.limitKey);
        const limit = counterLimit(c.limitKey, await limitForMonth(sub, c.limitKey, c.periodKey));
        let overageUnits = 0;
        if (def?.enforcement === 'SOFT' && limit !== null) {
          const over = Math.max(0, Number(c.used) - limit);
          const unit = c.limitKey === 'limit.storage_gb' ? BYTES_PER_GB : (def.overage?.unitSize ?? 1);
          overageUnits = Math.ceil(over / unit);
        }
        c.closedAt = now();
        c.limitAtClose = limit;
        c.overageUnits = overageUnits;
        c.cycleAtClose = sub?.billingCycle ?? 'MONTHLY';
        await c.save({ transaction: t });
        if (sub && sub.status === 'ACTIVE' && sub.billingCycle === 'ANNUAL' && overageUnits > 0) {
          const rows = await loadVersionRows(sub.planVersionId, t);
          const inv = await integrations().billing.issueOneTimeInvoice(
            SYSTEM,
            {
              subscriptionId: sub.id!,
              purchaseRef: `OVERAGE:${sub.id}:${c.periodKey}:${c.limitKey}`,
              addonKey: c.limitKey,
              label: def?.overageLabel ?? c.limitKey,
              quantity: overageUnits,
              unitPricePaise: rows.limits[c.limitKey]?.overagePricePaise ?? def?.overage?.pricePaise ?? 0,
              lineType: 'OVERAGE',
            },
            t,
          );
          if (inv) {
            c.overageInvoiceId = inv.id;
            await c.save({ transaction: t });
          }
        }
        closed += 1;
      });
    } catch (err) {
      logger.error({ err, counterId: row.id }, 'usage month close failed');
      if (onlySocietyId) throw err;
    }
  }
  return closed;
}

/** Job `subscriptions:usage-reconcile`: ABSOLUTE counters from registered providers; differences are overwritten and audited. */
export async function reconcileUsage(onlySocietyId?: number): Promise<number> {
  const subs = await Subscription.findAll({
    where: { status: { [Op.ne]: 'CANCELLED' }, ...(onlySocietyId ? { societyId: onlySocietyId } : {}) },
    attributes: ['societyId'],
  });
  let changed = 0;
  for (const { societyId } of subs)
    for (const [key, count] of usageProviders) {
      try {
        const actual = await count(societyId);
        const row = await UsageCounter.findOne({ where: { societyId, limitKey: key, periodKey: 'ALL' } });
        const was = Number(row?.used ?? 0);
        if (row && was === actual) continue;
        await sequelize.transaction(async t => {
          await setAbsoluteUsage(societyId, key, actual, t);
          await audit(
            SYSTEM,
            {
              action: 'subscriptions.usage.reconciled',
              entityType: 'usage_counter',
              entityId: `${societyId}:${key}`,
              societyId,
              before: { used: was },
              after: { used: actual },
            },
            t,
          );
        });
        if (was !== actual) changed += 1;
      } catch (err) {
        logger.error({ err, societyId, key }, 'usage reconcile failed');
      }
    }
  return changed;
}

/** Job `subscriptions:usage-purge`: closed month rows older than 24 months. */
export async function purgeUsage(): Promise<number> {
  const today = localDate(now());
  const cutoff = addMonthsAnchored(today, parseYmd(today).d, -24);
  return UsageCounter.destroy({
    where: { closedAt: { [Op.ne]: null }, periodKey: { [Op.ne]: 'ALL', [Op.lt]: cutoff } },
  });
}

/** Job `subscriptions:usage-threshold`. */
export async function sendUsageThreshold(data: {
  societyId: number;
  limitKey: string;
  pct: number;
}): Promise<void> {
  await sequelize.transaction(async t => {
    notifyViewers(t, data.societyId, 'subscription.usage_threshold', {
      pct: data.pct,
      limitKey: data.limitKey,
      limitTitle: LIMIT_BY_KEY.get(data.limitKey)?.title ?? data.limitKey,
    });
  });
}

/** `GET /subscription/usage` (8.5.3): all 12 limit keys for the current usage month. */
export async function usageView(societyId: number) {
  const ent = await getEntitlements(societyId);
  const counters = await UsageCounter.findAll({ where: { societyId, periodKey: ['ALL', ent.usageMonth] } });
  const items = LIMITS.map(l => {
    const periodKey = periodKeyFor(ent, l.key);
    const r = ent.limits[l.key]!;
    const used = Number(counters.find(c => c.limitKey === l.key && c.periodKey === periodKey)?.used ?? 0);
    const limitUnits = counterLimit(l.key, r.limit);
    const percent =
      limitUnits === null
        ? null
        : limitUnits === 0
          ? used > 0
            ? 100
            : 0
          : Math.floor((used * 100) / limitUnits);
    const unitSize = l.key === 'limit.storage_gb' ? BYTES_PER_GB : (l.overage?.unitSize ?? 1);
    const overageUnits =
      l.enforcement === 'SOFT' && limitUnits !== null
        ? Math.ceil(Math.max(0, used - limitUnits) / unitSize)
        : 0;
    return {
      limitKey: l.key,
      title: l.title,
      unit: l.unit,
      period: l.period,
      periodKey,
      enforcement: l.enforcement,
      limit: r.limit,
      ...(l.key === 'limit.storage_gb' ? { limitBytes: limitUnits } : {}),
      used,
      percent,
      addonIncrement: r.addonIncrement,
      overrideApplied: r.overrideApplied,
      overageUnits,
    };
  });
  return {
    periodKey: ent.usageMonth,
    periodEnd: addDaysYmd(addMonthsAnchored(ent.usageMonth, ent.billingAnchorDay, 1), -1),
    items,
  };
}

/** Admin seats for the Team screen: `{ limit, used }` (limit null = unlimited). */
export async function seatUsage(societyId: number): Promise<{ limit: number | null; used: number }> {
  const ent = await getEntitlements(societyId);
  const used = await UsageCounter.findOne({
    where: { societyId, limitKey: 'limit.admin_seats', periodKey: 'ALL' },
  });
  return { limit: ent.limits['limit.admin_seats']?.limit ?? 0, used: Number(used?.used ?? 0) };
}
