import { Collection, CollectionRequest, sequelize } from '../../models';
import { QueryTypes } from 'sequelize';
import { emitToRoom } from '../../lib/realtime';
import { RT, roomFinance, roomPublic } from './payments.constants';
import { n } from './payments.shared';

/**
 * Recompute of the collection totals from its requests (job `collections:refresh-totals`, 9.1). The core enqueues it when a
 * request's `paidPaise` changes; 12.5 owns the processor registration but this function is the body.
 */
export async function refreshCollectionTotals(collectionId: number): Promise<boolean> {
  const c = await Collection.findByPk(collectionId, { paranoid: false });
  if (!c) return false;
  const [row] = await sequelize.query<{
    requestCount: string;
    paidCount: string;
    contributorCount: string;
    collectedPaise: string | null;
  }>(
    `SELECT SUM(status <> 'CANCELLED') AS requestCount, SUM(status = 'PAID') AS paidCount,
            SUM(paidPaise > 0) AS contributorCount, SUM(paidPaise) AS collectedPaise
       FROM collection_requests WHERE collectionId = :id`,
    { replacements: { id: collectionId }, type: QueryTypes.SELECT },
  );
  const next = {
    requestCount: n(row?.requestCount),
    paidCount: n(row?.paidCount),
    contributorCount: n(row?.contributorCount),
    collectedPaise: n(row?.collectedPaise),
  };
  await Collection.update(next, { where: { id: collectionId }, hooks: false });
  const societyId = n(c.societyId);
  const payload = { collectionId, targetPaise: n(c.targetPaise), ...next };
  emitToRoom(roomFinance(societyId), RT.collectionProgress, payload);
  emitToRoom(
    roomPublic(societyId),
    RT.collectionProgress,
    c.payListVisibility === 'HIDDEN'
      ? { collectionId, collectedPaise: next.collectedPaise, targetPaise: n(c.targetPaise) }
      : payload,
  );
  return true;
}

export type { CollectionRequest };
