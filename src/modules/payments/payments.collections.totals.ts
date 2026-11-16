import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize, type Collection } from '../../models';
import { emitProgress } from './payments.collections.shared';

/**
 * In-transaction form of the totals of `collections:refresh-totals` (9.1; the job itself is the core's `refreshCollectionTotals`): recompute `requestCount` (not CANCELLED; a CLOSED collection counts every request so the denominator does not change on close), `paidCount` (PAID), `contributorCount`
 * (paidPaise > 0) and `collectedPaise` (sum of paidPaise) from the requests. The caller holds the collection lock.
 */
export async function recomputeTotals(c: Collection, t: Transaction): Promise<Collection> {
  const [row] = await sequelize.query<{
    requestCount: string;
    paidCount: string;
    contributorCount: string;
    collectedPaise: string;
  }>(
    `SELECT SUM(status <> 'CANCELLED' OR :closed) AS requestCount, SUM(status = 'PAID') AS paidCount,
            SUM(paidPaise > 0) AS contributorCount, COALESCE(SUM(paidPaise), 0) AS collectedPaise
       FROM collection_requests WHERE collectionId = :id`,
    {
      replacements: { id: c.id, closed: c.status === 'CLOSED' ? 1 : 0 },
      type: QueryTypes.SELECT,
      transaction: t,
    },
  );
  await c.update(
    {
      requestCount: Number(row?.requestCount ?? 0),
      paidCount: Number(row?.paidCount ?? 0),
      contributorCount: Number(row?.contributorCount ?? 0),
      collectedPaise: Number(row?.collectedPaise ?? 0),
    },
    { transaction: t, silent: false },
  );
  t.afterCommit(() => emitProgress(c));
  return c;
}

/**
 * Fixed-amount collections: the target follows the requests, `sum(amountPaise)` of the requests that are neither CANCELLED
 * nor WAIVED (flats added or waived after publishing). A voluntary collection keeps the target the admin typed; a target
 * that would drop to zero is left as it was. The caller holds the collection lock.
 */
export async function recomputeTarget(c: Collection, t: Transaction): Promise<void> {
  if (c.amountMode === 'VOLUNTARY') return;
  const [row] = await sequelize.query<{ total: string | null }>(
    `SELECT SUM(amountPaise) AS total FROM collection_requests
      WHERE collectionId = :id AND status NOT IN ('CANCELLED', 'WAIVED')`,
    { replacements: { id: c.id }, type: QueryTypes.SELECT, transaction: t },
  );
  const total = Number(row?.total ?? 0);
  if (total >= 100 && total !== Number(c.targetPaise))
    await c.update({ targetPaise: total }, { transaction: t });
}
