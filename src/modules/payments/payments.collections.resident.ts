import { Op, QueryTypes } from 'sequelize';
import { Collection, CollectionRequest, Unit, sequelize } from '../../models';
import { addDays, now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { PERM, ERR } from './payments.constants';
import { NotFoundError } from '../../utils/errors';
import { expensesPort, percentOf, societyIdOf } from './payments.collections.shared';

/** Resident side (8.9, BR-12-45): collections that have a request for one of the caller's units. Never names or payer identities. */
const CLOSED_WINDOW_DAYS = 90;

const notFound = () => new NotFoundError(ERR.collectionNotFound, 'Collection not found');

function visibleWhere(societyId: number) {
  return {
    societyId,
    [Op.or]: [
      { status: 'PUBLISHED' },
      { status: 'CLOSED', closedAt: { [Op.gte]: addDays(now(), -CLOSED_WINDOW_DAYS) } },
    ],
  };
}

async function myRequests(societyId: number, collectionIds: number[], unitIds: number[]) {
  if (!collectionIds.length || !unitIds.length) return new Map<number, ReturnType<typeof requestItem>[]>();
  const rows = await CollectionRequest.findAll({
    where: { societyId, collectionId: { [Op.in]: collectionIds }, unitId: { [Op.in]: unitIds } },
    order: [['id', 'ASC']],
  });
  const units = await Unit.findAll({
    where: { societyId, id: { [Op.in]: [...new Set(rows.map(r => Number(r.unitId)))] } },
    attributes: ['id', 'label'],
  });
  const labels = new Map(units.map(u => [Number(u.id), u.label]));
  const out = new Map<number, ReturnType<typeof requestItem>[]>();
  for (const r of rows) {
    const list = out.get(Number(r.collectionId)) ?? [];
    list.push(requestItem(r, labels.get(Number(r.unitId)) ?? ''));
    out.set(Number(r.collectionId), list);
  }
  return out;
}

const requestItem = (r: CollectionRequest, unitLabel: string) => ({
  id: Number(r.id),
  unitId: Number(r.unitId),
  unitLabel,
  status: r.status,
  amountPaise: Number(r.amountPaise),
  paidPaise: Number(r.paidPaise),
});

function itemOf(c: Collection, mine: ReturnType<typeof requestItem>[]) {
  const hidden = c.payListVisibility === 'HIDDEN';
  return {
    id: Number(c.id),
    title: c.title,
    kind: c.kind,
    purpose: c.purpose,
    isMandatory: Boolean(c.isMandatory),
    amountMode: c.amountMode,
    amountPerUnitPaise: Number(c.amountPerUnitPaise),
    minAmountPaise: Number(c.minAmountPaise),
    dueDate: c.dueDate,
    status: c.status,
    targetPaise: Number(c.targetPaise),
    collectedPaise: Number(c.collectedPaise),
    percent: percentOf(Number(c.collectedPaise), Number(c.targetPaise)),
    ...(hidden ? {} : { contributorCount: Number(c.contributorCount), requestCount: Number(c.requestCount) }),
    myRequests: mine,
  };
}

export async function listMyCollections(ctx: Ctx) {
  const societyId = societyIdOf(ctx);
  const unitIds = ctx.unitIds ?? [];
  if (!unitIds.length) return [];
  const rows = await sequelize.query<{ collectionId: number }>(
    'SELECT DISTINCT collectionId FROM collection_requests WHERE societyId = :societyId AND unitId IN (:unitIds)',
    { replacements: { societyId, unitIds }, type: QueryTypes.SELECT },
  );
  const cols = await Collection.findAll({
    where: { ...visibleWhere(societyId), id: { [Op.in]: rows.map(r => Number(r.collectionId)) } },
    order: [
      ['dueDate', 'ASC'],
      ['id', 'DESC'],
    ],
  });
  const mine = await myRequests(
    societyId,
    cols.map(c => Number(c.id)),
    unitIds,
  );
  return cols.map(c => itemOf(c, mine.get(Number(c.id)) ?? []));
}

export async function getMyCollection(ctx: Ctx, id: number) {
  const societyId = societyIdOf(ctx);
  const unitIds = ctx.unitIds ?? [];
  const c = await Collection.findOne({ where: { ...visibleWhere(societyId), id } });
  if (!c || !unitIds.length) throw notFound();
  const mine = (await myRequests(societyId, [id], unitIds)).get(id) ?? [];
  if (mine.length === 0) throw notFound();
  const base = itemOf(c, mine);
  const out: Record<string, unknown> = { ...base };
  if (c.payListVisibility === 'FLATS_ONLY' || c.payListVisibility === 'FLATS_AND_AMOUNTS') {
    const paid = await sequelize.query<{ unitLabel: string; paidPaise: string }>(
      `SELECT u.label AS unitLabel, r.paidPaise FROM collection_requests r JOIN units u ON u.id = r.unitId
        WHERE r.collectionId = :id AND r.paidPaise > 0 ORDER BY u.label`,
      { replacements: { id }, type: QueryTypes.SELECT },
    );
    out.whoPaid = paid.map(p =>
      c.payListVisibility === 'FLATS_ONLY'
        ? { unitLabel: p.unitLabel }
        : { unitLabel: p.unitLabel, paidPaise: Number(p.paidPaise) },
    );
  }
  if (ctx.permissions?.has(PERM.residentFinancesView)) {
    const spend = await expensesPort.listForCollection(societyId, id);
    out.spentPaise = spend.spentPaise;
    out.expenses = spend.expenses;
  }
  return out;
}
