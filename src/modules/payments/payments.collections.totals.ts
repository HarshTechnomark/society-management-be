import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize, type Collection } from '../../models';
import { emitProgress } from './payments.collections.shared';

/**
 * In-transaction form of the totals of `collections:refresh-totals` (9.1; the job itself is the core's `refreshCollectionTotals`): recompute `requestCount` (not CANCELLED), `paidCount` (PAID), `contributorCount`
 * (paidPaise > 0) and `collectedPaise` (sum of paidPaise) from the requests. The caller holds the collection lock.
 */
export async function recomputeTotals(c: Collection, t: Transaction): Promise<Collection> {
  const [row] = await sequelize.query<{
    requestCount: string;
    paidCount: string;
    contributorCount: string;
    collectedPaise: string;
  }>(
    `SELECT SUM(status <> 'CANCELLED') AS requestCount, SUM(status = 'PAID') AS paidCount,
            SUM(paidPaise > 0) AS contributorCount, COALESCE(SUM(paidPaise), 0) AS collectedPaise
       FROM collection_requests WHERE collectionId = :id`,
    { replacements: { id: c.id }, type: QueryTypes.SELECT, transaction: t },
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
