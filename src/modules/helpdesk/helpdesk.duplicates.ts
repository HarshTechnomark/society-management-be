import { Op, QueryTypes, type Transaction } from 'sequelize';
import { Ticket, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { NON_TERMINAL, LIMITS, SETTING, type TicketKind } from './helpdesk.constants';
import { setting } from './helpdesk.shared';
import type { SimilarTicket } from './helpdesk.types';

/** Duplicate detection (BR-15-17, BR-15-19) and the recurring tag (BR-15-16). */

/**
 * BR-15-17: open BUILDING tickets with the same category created within `helpdesk.duplicateWindowHours` at the same node, in the same building
 * (`affectedBuildingId` equal) or affecting the whole society. Ordered: same node first, FULLTEXT relevance of `q` (when given), upvotes desc,
 * newest first; at most 5.
 */
export async function findSimilarBuilding(
  societyId: number,
  q: { locationNodeId: number; categoryId: number; buildingId: number | null; q?: string },
  t?: Transaction,
): Promise<SimilarTicket[]> {
  const hours = await setting<number>(societyId, SETTING.duplicateWindowHours);
  const since = new Date(now().getTime() - hours * 3_600_000);
  const rows = await Ticket.findAll({
    where: {
      societyId,
      kind: 'BUILDING',
      status: { [Op.in]: [...NON_TERMINAL] },
      categoryId: q.categoryId,
      createdAt: { [Op.gte]: since },
      [Op.or]: [
        { locationNodeId: q.locationNodeId },
        ...(q.buildingId ? [{ affectedBuildingId: q.buildingId }] : []),
        { affectedLevel: 'SOCIETY' },
      ],
    },
    transaction: t,
  });
  let relevance = new Map<number, number>();
  const text = q.q?.trim();
  if (text && text.length >= 2 && rows.length) {
    const scores = await sequelize.query<{ id: number; score: number }>(
      `SELECT id, MATCH(title, description) AGAINST (:text IN NATURAL LANGUAGE MODE) AS score FROM tickets WHERE id IN (:ids)`,
      { replacements: { text, ids: rows.map(r => r.id) }, type: QueryTypes.SELECT, transaction: t },
    );
    relevance = new Map(scores.map(s => [Number(s.id), Number(s.score)]));
  }
  return rows
    .map(r => ({
      id: r.id,
      ticketNo: r.ticketNo,
      title: r.title,
      status: r.status,
      priority: r.priority,
      locationNodeId: r.locationNodeId,
      upvoteCount: r.upvoteCount,
      createdAt: r.createdAt,
      sameNode: r.locationNodeId === q.locationNodeId,
    }))
    .sort(
      (a, b) =>
        Number(b.sameNode) - Number(a.sameNode) ||
        (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0) ||
        b.upvoteCount - a.upvoteCount ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id - a.id,
    )
    .slice(0, LIMITS.similarMax);
}

/** BR-15-19: open personal complaints of the same unit and category created in the last 7 days (a hint after creation; never blocks). */
export async function similarPersonalIds(
  societyId: number,
  unitId: number,
  categoryId: number,
  excludeId?: number,
  t?: Transaction,
): Promise<number[]> {
  const since = new Date(now().getTime() - LIMITS.personalSimilarDays * 86_400_000);
  const rows = await Ticket.findAll({
    where: {
      societyId,
      kind: 'PERSONAL',
      unitId,
      categoryId,
      status: { [Op.in]: [...NON_TERMINAL] },
      createdAt: { [Op.gte]: since },
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
    attributes: ['id'],
    order: [['id', 'DESC']],
    transaction: t,
  });
  return rows.map(r => r.id);
}

/**
 * BR-15-16: true when at least `helpdesk.recurringCount` tickets (this one included) share the same location+category (building issues), unit+category
 * (personal) or asset, were created within `helpdesk.recurringWindowDays` and are not merged. Counts the new ticket itself (`ticketId` is excluded from the
 * query and added as one).
 */
export async function recurringCheck(
  societyId: number,
  t0: {
    kind: TicketKind;
    locationNodeId: number | null;
    unitId: number | null;
    categoryId: number;
    assetId: number | null;
    ticketId: number;
  },
  t?: Transaction,
): Promise<boolean> {
  const [need, days] = await Promise.all([
    setting<number>(societyId, SETTING.recurringCount),
    setting<number>(societyId, SETTING.recurringWindowDays),
  ]);
  const since = new Date(now().getTime() - days * 86_400_000);
  const same =
    t0.kind === 'BUILDING'
      ? { locationNodeId: t0.locationNodeId, categoryId: t0.categoryId }
      : { unitId: t0.unitId, categoryId: t0.categoryId };
  const where = {
    societyId,
    mergedIntoTicketId: null,
    createdAt: { [Op.gte]: since },
    id: { [Op.ne]: t0.ticketId },
  };
  const n = await Ticket.count({ where: { ...where, ...same }, transaction: t });
  if (n + 1 >= need) return true;
  if (t0.assetId)
    return (await Ticket.count({ where: { ...where, assetId: t0.assetId }, transaction: t })) + 1 >= need;
  return false;
}
