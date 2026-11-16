import { Op } from 'sequelize';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { now } from '../../lib/clock';
import { Payment, Unit } from '../../models';
import { onAuditCommitted } from '../../utils/audit';
import { monthBoundsOf } from './payments.admin.month';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { ENT, EFFECTIVE_STATUSES } from './payments.constants';
import { efficiencyForMonth, paymentTotals, readRows } from './payments.reports';
import { n, societyToday } from './payments.shared';

/**
 * `GET /payments/summary` and `GET /payments/live-feed` (8.13). The summary is cached 30 seconds per society and month in
 * the module 01 key-value store; any committed audit row of a payment action clears the society's cache (`touch`).
 */
const TTL = 30;
const key = (societyId: number, month: string) => `payments:summary:${societyId}:${month}`;
const PAYMENT_ACTION = /^payments\.(payment|cheque|receipt|advance)\./;

const onAudit = (row: { societyId: number | null; action: string }): void => {
  if (!row.societyId || !PAYMENT_ACTION.test(row.action)) return;
  kv()
    .cacheDelPrefix(`payments:summary:${row.societyId}:`)
    .catch(err => logger.warn({ err }, 'payments summary cache clear failed'));
};

/** Module-level handler: `onAuditCommitted` ignores a function it already holds, so registering twice is harmless. */
export const registerSummaryCache = (): void => onAuditCommitted(onAudit);

export async function getSummary(societyId: number, monthInput?: string) {
  const today = await societyToday(societyId);
  const month = monthInput ?? today.slice(0, 7);
  const k = key(societyId, month);
  try {
    const hit = await kv().cacheGet(k);
    if (hit) return JSON.parse(hit) as Awaited<ReturnType<typeof compute>>;
  } catch (err) {
    logger.warn({ err }, 'payments summary cache read failed');
  }
  const value = await compute(societyId, month, today);
  try {
    await kv().cacheSet(k, JSON.stringify(value), TTL);
  } catch (err) {
    logger.warn({ err }, 'payments summary cache write failed');
  }
  return value;
}

async function compute(societyId: number, month: string, today: string) {
  const { from, to } = monthBoundsOf(month);
  const [day, mon] = await Promise.all([
    paymentTotals(societyId, today, today),
    paymentTotals(societyId, from, to),
  ]);
  const byMethod: Record<string, number> = {};
  for (const m of new Set([...Object.keys(mon.byMethod), ...Object.keys(mon.carriedByMethod)])) {
    const v = (mon.byMethod[m] ?? 0) - (mon.carriedByMethod[m] ?? 0);
    if (v !== 0) byMethod[m] = v;
  }
  const [counts] = await readRows<{ pending: string; review: string; clearing: string; clearingAmt: string }>(
    `SELECT SUM(status = 'PENDING_APPROVAL') AS pending, SUM(needsReview = 1) AS review,
            SUM(method = 'CHEQUE' AND status IN ('RECEIVED','DEPOSITED')) AS clearing,
            COALESCE(SUM(CASE WHEN method = 'CHEQUE' AND status IN ('RECEIVED','DEPOSITED') THEN amountPaise END), 0) AS clearingAmt
       FROM payments WHERE societyId = :societyId`,
    { societyId },
  );
  const out: Record<string, unknown> = {
    today: { collectedPaise: day.receivedPaise - day.carriedPaise, count: day.paymentCount },
    month: { collectedPaise: mon.receivedPaise - mon.carriedPaise, count: mon.paymentCount, byMethod },
  };
  if (await isFeatureOn(societyId, ENT.efficiency, 'read')) {
    const e = await efficiencyForMonth(societyId, month);
    out.efficiency = {
      billedPaise: e.billedPaise,
      collectedAgainstBilledPaise: e.collectedPaise,
      percent: e.percent,
    };
  }
  out.pendingApprovalCount = n(counts?.pending);
  out.chequesInClearing = { count: n(counts?.clearing), amountPaise: n(counts?.clearingAmt) };
  out.needsReviewCount = n(counts?.review);
  out.generatedAt = now().toISOString();
  return out as {
    today: { collectedPaise: number; count: number };
    month: { collectedPaise: number; count: number; byMethod: Record<string, number> };
    efficiency?: { billedPaise: number; collectedAgainstBilledPaise: number; percent: number };
    pendingApprovalCount: number;
    chequesInClearing: { count: number; amountPaise: number };
    needsReviewCount: number;
    generatedAt: string;
  };
}

export const whatOf = (p: Pick<Payment, 'toInvoicesPaise' | 'toCollectionsPaise' | 'toAdvancePaise'>) => {
  const inv = n(p.toInvoicesPaise) > 0;
  const col = n(p.toCollectionsPaise) > 0;
  const adv = n(p.toAdvancePaise) > 0;
  if (inv && !col && !adv) return 'maintenance';
  if (col && !inv && !adv) return 'contribution';
  if (adv && !inv && !col) return 'advance';
  return 'mixed';
};

/** Latest 50 effective payments, newest first. */
export async function liveFeed(societyId: number) {
  const rows = await Payment.findAll({
    where: { societyId, status: { [Op.in]: EFFECTIVE_STATUSES as unknown as string[] } },
    include: [{ model: Unit, attributes: ['label'], required: false }],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 50,
  });
  return rows.map(p => ({
    id: n(p.id),
    unitLabel: (p as unknown as { Unit?: { label: string } }).Unit?.label ?? '',
    amountPaise: n(p.amountPaise),
    method: p.method,
    what: whatOf(p),
    receiptNo: p.receiptNo,
    at: (p.capturedAt ?? p.createdAt).toISOString(),
  }));
}
