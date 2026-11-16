import { moneyTx } from './payments.shared';
import { Op, QueryTypes } from 'sequelize';
import { CollectionRequest, sequelize, type Collection } from '../../models';
import { istDate, now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { NotFoundError, UnprocessableError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { PdfDoc, PAGE_W } from '../platform-billing/platform-billing.pdf-writer';
import { formatRupees } from '../../lib/money';
import { societyPorts } from '../societies/societies.ports';
import { toCsv } from '../society-setup/society-setup.csv';
import { units } from '../society-setup/society-setup.public';
import { societyToday } from '../billing/billing.runs.shared';
import { AUDIT, ERR } from './payments.constants';
import { loadCollection, lockCollection } from './payments.collections.service';
import {
  escapeLike,
  expensesPort,
  invalidState,
  requestNotFound,
  societyIdOf,
  staleVersion,
  touchReports,
  userIdOf,
} from './payments.collections.shared';
import { recomputeTarget, recomputeTotals } from './payments.collections.totals';
import { createRequestsFor } from './payments.collections.workflow';
import type { RequestListQuery } from './payments.collections.validation';

/** Collection requests and statement (8.23). */
const SORT_SQL = { unitLabel: 'u.label', paidPaise: 'r.paidPaise', lastPaidAt: 'r.lastPaidAt' } as const;
export const EXPORT_MAX_ROWS = 50_000;

interface RequestRow {
  id: number;
  unitId: number;
  unitLabel: string;
  billToName: string | null;
  amountPaise: string | number;
  paidPaise: string | number;
  status: string;
  invoiceId: number | null;
  lastPaidAt: Date | string | null;
  version?: number;
}

function filterSql(
  collectionId: number,
  societyId: number,
  q: Pick<RequestListQuery, 'status' | 'q' | 'buildingId'>,
) {
  const where = ['r.collectionId = :collectionId', 'r.societyId = :societyId'];
  const rep: Record<string, unknown> = { collectionId, societyId };
  if (q.status) {
    where.push('r.status IN (:statuses)');
    rep.statuses = q.status;
  }
  if (q.q) {
    where.push("u.label LIKE :q ESCAPE '\\\\'");
    rep.q = `%${escapeLike(q.q)}%`;
  }
  if (q.buildingId) {
    where.push('u.buildingId = :buildingId');
    rep.buildingId = q.buildingId;
  }
  return { where: where.join(' AND '), rep };
}

const FROM = `FROM collection_requests r
   JOIN units u ON u.id = r.unitId
   LEFT JOIN residents b ON b.id = r.billToResidentId`;

const dto = (r: RequestRow) => ({
  id: Number(r.id),
  unitId: Number(r.unitId),
  unitLabel: r.unitLabel,
  billToName: r.billToName,
  amountPaise: Number(r.amountPaise),
  paidPaise: Number(r.paidPaise),
  status: r.status,
  invoiceId: r.invoiceId ? Number(r.invoiceId) : null,
  lastPaidAt: r.lastPaidAt ? new Date(r.lastPaidAt).toISOString() : null,
  ...(r.version ? { version: Number(r.version) } : {}),
});

export async function listRequests(societyId: number, collectionId: number, q: RequestListQuery) {
  await loadCollection(societyId, collectionId);
  const { where, rep } = filterSql(collectionId, societyId, q);
  const [{ n }] = await sequelize.query<{ n: string }>(`SELECT COUNT(*) AS n ${FROM} WHERE ${where}`, {
    replacements: rep,
    type: QueryTypes.SELECT,
  });
  const rows = await sequelize.query<RequestRow>(
    `SELECT r.id, r.unitId, u.label AS unitLabel, b.name AS billToName, r.amountPaise, r.paidPaise, r.status,
            r.invoiceId, r.lastPaidAt, r.version ${FROM} WHERE ${where}
      ORDER BY ${SORT_SQL[q.sortBy]} ${q.sortOrder === 'desc' ? 'DESC' : 'ASC'}, r.id ASC LIMIT :limit OFFSET :offset`,
    { replacements: { ...rep, limit: q.limit, offset: (q.page - 1) * q.limit }, type: QueryTypes.SELECT },
  );
  return { data: rows.map(dto), pagination: pageMeta(q.page, q.limit, Number(n)) };
}

const rupees = (paise: number) => (paise / 100).toFixed(2);

export async function exportRequests(
  ctx: Ctx,
  collectionId: number,
  q: Pick<RequestListQuery, 'status' | 'q' | 'buildingId'>,
): Promise<{ csv: Buffer; rows: number; fileName: string }> {
  const societyId = societyIdOf(ctx);
  const c = await loadCollection(societyId, collectionId);
  const { where, rep } = filterSql(collectionId, societyId, q);
  const rows = await sequelize.query<RequestRow>(
    `SELECT r.id, r.unitId, u.label AS unitLabel, b.name AS billToName, r.amountPaise, r.paidPaise, r.status,
            r.invoiceId, r.lastPaidAt ${FROM} WHERE ${where} ORDER BY u.label ASC, r.id ASC LIMIT ${EXPORT_MAX_ROWS + 1}`,
    { replacements: rep, type: QueryTypes.SELECT },
  );
  if (rows.length > EXPORT_MAX_ROWS)
    throw new UnprocessableError(ERR.exportTooLarge, 'Too many rows to export; narrow the filter');
  const csv = toCsv(
    ['Flat', 'Bill-to', 'Asked (INR)', 'Paid (INR)', 'Status', 'Last paid'],
    rows.map(r => [
      r.unitLabel,
      r.billToName ?? '',
      rupees(Number(r.amountPaise)),
      rupees(Number(r.paidPaise)),
      r.status,
      r.lastPaidAt ? istDate(new Date(r.lastPaidAt)) : '',
    ]),
  );
  await audit(ctx, {
    action: AUDIT.requestExported,
    entityType: 'collection',
    entityId: collectionId,
    entityLabel: c.title,
    societyId,
    after: { rows: rows.length, filter: q },
  });
  return { csv, rows: rows.length, fileName: `collection-${collectionId}-requests.csv` };
}

export async function addRequests(
  ctx: Ctx,
  collectionId: number,
  input: { unitIds: number[]; version: number },
) {
  const societyId = societyIdOf(ctx);
  const today = await societyToday(societyId);
  const wanted = [...new Set(input.unitIds)];
  const found = await units.listActive(societyId, { unitIds: wanted });
  if (found.length !== wanted.length) {
    const have = new Set(found.map(u => u.id));
    throw new NotFoundError(
      ERR.unitNotFound,
      `Unknown or archived flats: ${wanted.filter(i => !have.has(i)).join(', ')}`,
    );
  }
  return moneyTx(async t => {
    const c = await lockCollection(societyId, collectionId, t);
    if (c.status !== 'PUBLISHED')
      throw invalidState('Flats can be added only while the collection is published');
    if (Number(c.version) !== input.version) throw staleVersion();
    const existing = await CollectionRequest.findAll({
      where: { collectionId, unitId: { [Op.in]: wanted } },
      attributes: ['unitId'],
      transaction: t,
    });
    const have = new Set(existing.map(r => Number(r.unitId)));
    const fresh = found.filter(u => !have.has(u.id));
    const { created, skippedNoBillTo } = await createRequestsFor(ctx, c, fresh, today, t, true);
    await c.update({ version: Number(c.version) + 1, updatedBy: userIdOf(ctx) }, { transaction: t });
    await recomputeTotals(c, t);
    await recomputeTarget(c, t);
    await audit(
      ctx,
      {
        action: AUDIT.requestAdded,
        entityType: 'collection',
        entityId: collectionId,
        entityLabel: c.title,
        societyId,
        after: { unitIds: created.map(r => Number(r.unitId)), skippedUnitIds: [...have], skippedNoBillTo },
      },
      t,
    );
    touchReports(t, societyId);
    return {
      addedCount: created.length,
      addedUnitIds: created.map(r => Number(r.unitId)),
      skippedUnitIds: wanted.filter(i => have.has(i)),
      skipped: [
        ...wanted.filter(i => have.has(i)).map(unitId => ({ unitId, reason: 'Already in this collection' })),
        ...skippedNoBillTo.map(unitId => ({ unitId, reason: 'This flat has no owner or bill-to party' })),
      ],
      targetPaise: Number(c.targetPaise),
      requestCount: Number(c.requestCount),
      version: Number(c.version),
    };
  });
}

export async function waiveRequest(ctx: Ctx, requestId: number, input: { reason: string; version: number }) {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    const r = await CollectionRequest.findOne({
      where: { id: requestId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!r) throw requestNotFound();
    const c = await lockCollection(societyId, Number(r.collectionId), t);
    if (r.status !== 'OPEN') throw invalidState('Only an open request can be waived');
    if (Number(r.paidPaise) !== 0) throw invalidState('A request with money paid cannot be waived');
    if (c.isMandatory) throw invalidState('A mandatory request is relieved with a credit note');
    if (Number(r.version) !== input.version) throw staleVersion();
    const uid = userIdOf(ctx);
    await r.update(
      { status: 'WAIVED', waivedReason: input.reason, updatedBy: uid, version: Number(r.version) + 1 },
      { transaction: t },
    );
    await recomputeTotals(c, t);
    await recomputeTarget(c, t);
    await audit(
      ctx,
      {
        action: AUDIT.requestWaived,
        entityType: 'collection_request',
        entityId: requestId,
        entityLabel: c.title,
        societyId,
        reason: input.reason,
        after: { collectionId: Number(c.id), unitId: Number(r.unitId) },
      },
      t,
    );
    touchReports(t, societyId);
    return {
      id: Number(r.id),
      collectionId: Number(c.id),
      unitId: Number(r.unitId),
      status: r.status,
      waivedReason: r.waivedReason,
      version: Number(r.version),
    };
  });
}

// ------------------------------------------------------------------ statement

function renderStatementPdf(
  c: Collection,
  s: {
    collectedPaise: number;
    contributorCount: number;
    spentPaise: number;
    balancePaise: number;
    expenses: { title: string; category: string; date: string; amountPaise: number }[];
  },
  societyName: string,
): Buffer {
  const d = new PdfDoc();
  const L = 40;
  const R = PAGE_W - 40;
  let y = 52;
  d.text(L, y, societyName, { size: 15, bold: true, maxWidth: 400 });
  d.text(R, y, 'COLLECTION STATEMENT', { size: 12, bold: true, align: 'right' });
  y += 20;
  d.text(L, y, c.title, { size: 12, bold: true, maxWidth: 480 });
  y += 14;
  d.text(L, y, `Kind: ${c.kind}    Due: ${c.dueDate}    Status: ${c.status}    Date: ${istDate(now())}`, {
    size: 9,
  });
  y += 10;
  d.line(L, y, R, y, 1);
  y += 18;
  const row = (label: string, value: string, bold = false) => {
    d.text(L, y, label, { size: 10, bold });
    d.text(R, y, value, { size: 10, bold, align: 'right' });
    y += 15;
  };
  row('Target', formatRupees(Number(c.targetPaise)));
  row(`Collected (${s.contributorCount} flats)`, formatRupees(s.collectedPaise));
  row('Spent', formatRupees(s.spentPaise));
  row('Balance', formatRupees(s.balancePaise), true);
  y += 10;
  if (s.expenses.length) {
    d.text(L, y, 'Spending', { size: 10, bold: true });
    y += 15;
    for (const e of s.expenses.slice(0, 40)) {
      d.text(L, y, `${e.date}  ${e.title} (${e.category})`, { size: 9, maxWidth: 400 });
      d.text(R, y, formatRupees(e.amountPaise), { size: 9, align: 'right' });
      y += 13;
    }
  }
  return d.build(`Statement ${c.title}`);
}

export async function collectionStatement(ctx: Ctx, collectionId: number, format: 'json' | 'pdf') {
  const societyId = societyIdOf(ctx);
  const c = await loadCollection(societyId, collectionId);
  const spend = await expensesPort.listForCollection(societyId, collectionId);
  const body = {
    collectedPaise: Number(c.collectedPaise),
    contributorCount: Number(c.contributorCount),
    spentPaise: spend.spentPaise,
    balancePaise: Number(c.collectedPaise) - spend.spentPaise,
    expenses: spend.expenses,
  };
  let out: unknown = body;
  if (format === 'pdf') {
    const pdf = renderStatementPdf(c, body, ctx.society?.name || 'Society');
    const files = societyPorts().files;
    const stored = await files.storeSystemFile({
      societyId,
      purpose: 'EXPORT_FILE',
      content: pdf,
      name: `collection-${collectionId}-statement.pdf`,
      contentType: 'application/pdf',
      ownerUserId: userIdOf(ctx),
    });
    const link = await files.downloadUrl(stored.fileId, 5);
    out = { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }
  await audit(ctx, {
    action: AUDIT.collectionStatementDownloaded,
    entityType: 'collection',
    entityId: collectionId,
    entityLabel: c.title,
    societyId,
    after: { format },
  });
  return out;
}
