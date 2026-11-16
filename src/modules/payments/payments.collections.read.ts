import { Collection, sequelize } from '../../models';
import { QueryTypes } from 'sequelize';
import { ReadTimeoutError, readRows, type ReadOpts } from '../billing/billing.dues.queries';
import { invoices } from '../billing/billing.public';
import { paymentsPorts } from './payments.ports';
import { expensesPort, percentOf } from './payments.collections.shared';

/**
 * Readers of sections 8.26 and 8.27 owned by sub-module 12.5: `collections.get`, `collections.efficiency` and
 * `paymentsReports.collectionProgress`. The coordinator wires them into `payments.public.ts` and `payments.reports.ts`.
 */
export async function getCollectionForOtherModules(societyId: number, id: number) {
  const c = await Collection.findOne({ where: { id, societyId } });
  if (!c) return null;
  return {
    id: Number(c.id),
    name: c.title,
    title: c.title,
    kind: c.kind,
    status: c.status,
    fundId: Number(c.fundId),
    isMandatory: Boolean(c.isMandatory),
    targetPaise: Number(c.targetPaise),
    collectedPaise: Number(c.collectedPaise),
    dueDate: c.dueDate,
  };
}

/** Percent 0 to 100 of the month's regular and supplementary billing that allocations have collected; null when nothing was billed. */
export async function collectionEfficiency(societyId: number, month: string): Promise<number | null> {
  const { billedPaise, invoiceIds } = await invoices.billedForMonth(societyId, month);
  if (billedPaise <= 0 || invoiceIds.length === 0) return null;
  const [row] = await sequelize.query<{ collected: string | null }>(
    `SELECT COALESCE(SUM(amountPaise), 0) AS collected FROM payment_allocations
      WHERE societyId = :societyId AND targetType = 'INVOICE' AND invoiceId IN (:ids)`,
    { replacements: { societyId, ids: invoiceIds }, type: QueryTypes.SELECT },
  );
  const collected = Math.max(0, Number(row?.collected ?? 0));
  return Math.min(100, Math.round((collected * 100) / billedPaise));
}

const PROGRESS_SORT = {
  dueDate: 'c.dueDate',
  title: 'c.title',
  collectedPaise: 'collectedPaise',
  percent: 'percent',
} as const;

export interface ProgressQuery {
  status?: string[];
  kind?: string[];
  page: number;
  limit: number;
  sortBy: keyof typeof PROGRESS_SORT;
  sortDir: 'asc' | 'desc';
  buildingIds?: number[];
}

/** 8.27 `collectionProgress`: with `buildingIds` the counts and the collected amount are recomputed from requests of those buildings. */
export async function collectionProgress(
  societyId: number,
  q: ProgressQuery,
  opts: ReadOpts = { deadlineMs: 0 },
) {
  if (!(q.sortBy in PROGRESS_SORT))
    throw new Error(`collectionProgress: sortBy ${String(q.sortBy)} is not allowed`);
  if (q.sortDir !== 'asc' && q.sortDir !== 'desc') throw new Error('collectionProgress: bad sortDir');
  if (!(q.limit >= 1 && q.limit <= 1000)) throw new Error('collectionProgress: limit must be 1 to 1000');
  const scoped = Boolean(q.buildingIds?.length);
  const where = ['c.societyId = :societyId', 'c.deletedAt IS NULL'];
  const rep: Record<string, unknown> = { societyId };
  if (q.status?.length) {
    where.push('c.status IN (:statuses)');
    rep.statuses = q.status;
  }
  if (q.kind?.length) {
    where.push('c.kind IN (:kinds)');
    rep.kinds = q.kind;
  }
  if (scoped) rep.buildingIds = q.buildingIds;
  const agg = scoped
    ? `JOIN (SELECT r.collectionId, SUM(r.status <> 'CANCELLED') AS requestCount, SUM(r.status = 'PAID') AS paidCount,
                    SUM(r.paidPaise > 0) AS contributorCount, COALESCE(SUM(r.paidPaise), 0) AS collectedPaise
               FROM collection_requests r JOIN units u ON u.id = r.unitId
              WHERE r.societyId = :societyId AND u.buildingId IN (:buildingIds) GROUP BY r.collectionId) a ON a.collectionId = c.id`
    : '';
  const cols = scoped
    ? 'a.requestCount, a.paidCount, a.contributorCount, a.collectedPaise'
    : 'c.requestCount, c.paidCount, c.contributorCount, c.collectedPaise';
  const collectedExpr = scoped ? 'a.collectedPaise' : 'c.collectedPaise';
  const base = `FROM collections c ${agg} WHERE ${where.join(' AND ')}`;
  const [tot] = await readRows<{ n: string; target: string | null; collected: string | null }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(c.targetPaise), 0) AS target, COALESCE(SUM(${collectedExpr}), 0) AS collected ${base}`,
    rep,
    opts,
  );
  const rows = await readRows<Record<string, string | number | null>>(
    `SELECT c.id, c.title, c.kind, c.isMandatory, c.status, c.targetPaise, ${cols}, c.dueDate, c.fundId,
            LEAST(100, FLOOR(${collectedExpr} * 100 / GREATEST(c.targetPaise, 1))) AS percent
       ${base} ORDER BY ${PROGRESS_SORT[q.sortBy]} ${q.sortDir.toUpperCase()}, c.id ASC LIMIT :limit OFFSET :offset`,
    { ...rep, limit: q.limit, offset: (q.page - 1) * q.limit },
    opts,
  );
  const out = [];
  for (const r of rows) {
    let spentPaise: number | null;
    try {
      spentPaise = (await expensesPort.listForCollection(societyId, Number(r.id))).spentPaise;
    } catch {
      spentPaise = null;
    }
    out.push({
      id: Number(r.id),
      title: String(r.title),
      kind: String(r.kind),
      isMandatory: Boolean(r.isMandatory),
      status: String(r.status),
      targetPaise: Number(r.targetPaise),
      collectedPaise: Number(r.collectedPaise),
      percent: percentOf(Number(r.collectedPaise), Number(r.targetPaise)),
      requestCount: Number(r.requestCount),
      paidCount: Number(r.paidCount),
      contributorCount: Number(r.contributorCount),
      dueDate: String(r.dueDate).slice(0, 10),
      fundName: (await paymentsPorts().funds.name(societyId, Number(r.fundId))) ?? '',
      spentPaise,
    });
  }
  return {
    rows: out,
    total: Number(tot?.n ?? 0),
    totals: { targetPaise: Number(tot?.target ?? 0), collectedPaise: Number(tot?.collected ?? 0) },
  };
}
export { ReadTimeoutError };
