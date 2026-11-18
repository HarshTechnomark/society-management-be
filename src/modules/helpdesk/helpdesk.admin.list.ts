import { Op, QueryTypes, type Order, type WhereOptions } from 'sequelize';
import { Role, Ticket, TicketCategory, TicketUpvote, User, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import { pageMeta, type PageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { members } from '../access-control/access-control.public';
import { societyToday } from '../billing/billing.runs.shared';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { locations } from '../society-setup/society-setup.public';
import { AUDIT, ENT, ENTITY, ERR, LIMITS, LOAD_STATUSES, NON_TERMINAL } from './helpdesk.constants';
import { findSimilarBuilding } from './helpdesk.duplicates';
import { ensureSeededOnce } from './helpdesk.seed';
import { societyIdOf } from './helpdesk.shared';
import { loadLabels, toListItems, type TicketListItem } from './helpdesk.admin.dto';
import type { ExportQuery, ListQuery } from './helpdesk.admin.validation';
import { helpdeskPorts } from './helpdesk.ports';
import { loadEffectiveCategory } from './helpdesk.tickets.core';

/** 8.7 list, 8.20 export, 8.21 assignees and the building-issue duplicate check (8.11). */

type Filters = Omit<ListQuery, 'page' | 'limit'>;
const OPEN = [...NON_TERMINAL];
const IST = '+05:30';

/** Society local start of a `YYYY-MM-DD` day (Asia/Kolkata, as everywhere in the code base). */
export const dayStart = (ymd: string): Date => new Date(`${ymd}T00:00:00${IST}`);
export const dayAfter = (ymd: string): Date => new Date(dayStart(ymd).getTime() + 86_400_000);

const esc = (v: string | number): string => sequelize.escape(v);
const likeEsc = (s: string): string => `%${s.replace(/[\\%_]/g, c => `\\${c}`)}%`;

/** The status condition of a view (8.7). */
function viewWhere(view: Filters['view']): WhereOptions {
  switch (view) {
    case 'OPEN':
      return { status: { [Op.in]: OPEN } };
    case 'BUILDING':
      return { kind: 'BUILDING', status: { [Op.notIn]: ['CLOSED', 'CANCELLED'] } };
    case 'FLATS':
      return { kind: 'PERSONAL' };
    case 'URGENT':
      return { priority: { [Op.in]: ['P1', 'P2'] }, status: { [Op.in]: OPEN } };
    case 'RESOLVED':
      return { status: { [Op.in]: ['RESOLVED', 'CLOSED'] } };
    case 'UNASSIGNED':
      return { status: { [Op.in]: ['OPEN', 'REOPENED'] } };
    case 'BREACHED':
      return {
        status: { [Op.in]: OPEN },
        [Op.or]: [{ responseBreached: true }, { resolutionBreached: true }],
      };
    default:
      return {};
  }
}

/** 8.7 filters as one `where` (tenant scope always first). */
export function buildWhere(societyId: number, f: Filters): WhereOptions {
  const and: WhereOptions[] = [{ societyId }, viewWhere(f.view)];
  if (f.status) and.push({ status: { [Op.in]: f.status } });
  if (f.kind) and.push({ kind: f.kind });
  if (f.priority) and.push({ priority: { [Op.in]: f.priority } });
  if (f.categoryId) and.push({ [Op.or]: [{ categoryId: f.categoryId }, { subCategoryId: f.categoryId }] });
  if (f.assigneeUserId) and.push({ assigneeUserId: f.assigneeUserId });
  if (f.assigneeType)
    and.push({
      currentAssignmentId: {
        [Op.in]: sequelize.literal(
          `(SELECT id FROM ticket_assignments WHERE societyId = ${societyId} AND endedAt IS NULL AND assigneeType = ${esc(f.assigneeType)})`,
        ),
      },
    });
  if (f.unitId) and.push({ unitId: f.unitId });
  if (f.buildingId)
    and.push({
      [Op.or]: [
        { affectedBuildingId: f.buildingId },
        {
          unitId: {
            [Op.in]: sequelize.literal(
              `(SELECT id FROM units WHERE societyId = ${societyId} AND buildingId = ${esc(f.buildingId)})`,
            ),
          },
        },
      ],
    });
  if (f.locationNodeId) and.push({ locationNodeId: f.locationNodeId });
  if (f.isRecurring !== undefined) and.push({ isRecurring: f.isRecurring });
  if (f.createdFrom) and.push({ createdAt: { [Op.gte]: dayStart(f.createdFrom) } });
  if (f.createdTo) and.push({ createdAt: { [Op.lt]: dayAfter(f.createdTo) } });
  if (f.q) {
    const like = esc(likeEsc(f.q));
    const prefix = esc(`${f.q.replace(/[\\%_]/g, c => `\\${c}`)}%`);
    and.push({
      [Op.or]: [
        sequelize.literal(`Ticket.ticketNo LIKE ${prefix}`),
        sequelize.literal(`Ticket.title LIKE ${like}`),
        sequelize.literal(`Ticket.assigneeLabel LIKE ${like}`),
        sequelize.literal(
          `Ticket.unitId IN (SELECT id FROM units WHERE societyId = ${societyId} AND label LIKE ${like})`,
        ),
      ],
    });
  }
  return { [Op.and]: and };
}

function orderOf(f: Filters): Order {
  const dir = (
    f.sortOrder ?? (f.sortBy === 'priority' || f.sortBy === 'resolutionDueAt' ? 'asc' : 'desc')
  ).toUpperCase();
  return [
    [f.sortBy, dir],
    ['id', dir],
  ];
}

/** Segment-chip counts: whole society, independent of the filters in the query (8.7). */
export async function viewCounts(societyId: number): Promise<Record<string, number>> {
  const [r] = await sequelize.query<Record<string, string | number>>(
    `SELECT
       SUM(status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING_ON_RESIDENT','REOPENED')) AS OPEN,
       SUM(kind = 'BUILDING' AND status NOT IN ('CLOSED','CANCELLED')) AS BUILDING,
       SUM(kind = 'PERSONAL') AS FLATS,
       SUM(priority IN ('P1','P2') AND status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING_ON_RESIDENT','REOPENED')) AS URGENT,
       SUM(status IN ('RESOLVED','CLOSED')) AS RESOLVED,
       COUNT(*) AS ALL_
     FROM tickets WHERE societyId = :societyId`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    OPEN: n('OPEN'),
    BUILDING: n('BUILDING'),
    FLATS: n('FLATS'),
    URGENT: n('URGENT'),
    RESOLVED: n('RESOLVED'),
    ALL: n('ALL_'),
  };
}

export async function listTickets(
  ctx: Ctx,
  q: ListQuery,
): Promise<{ items: TicketListItem[]; counts: Record<string, number>; pagination: PageMeta }> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  const where = buildWhere(societyId, q);
  const { rows, count } = await Ticket.findAndCountAll({
    where,
    order: orderOf(q),
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const [items, counts] = await Promise.all([toListItems(ctx, rows), viewCounts(societyId)]);
  return { items, counts, pagination: pageMeta(q.page, q.limit, count) };
}

// ------------------------------------------------------------------ export (8.20)
const COLUMNS = [
  'ticketNo',
  'kind',
  'status',
  'priority',
  'category',
  'subCategory',
  'unitOrLocation',
  'affectedUnitCount',
  'requester',
  'assignee',
  'createdAt',
  'firstResponseAt',
  'resolvedAt',
  'closedAt',
  'responseBreached',
  'resolutionBreached',
  'upvoteCount',
  'csatScore',
  'reopenCount',
] as const;

/** One CSV cell: quoted when needed; a leading `=`, `+`, `-`, `@` is neutralised so a spreadsheet never runs it. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Same filters as the list; returns the CSV text and the row count. Internal comments are never exported. */
export async function exportTickets(
  ctx: Ctx,
  q: ExportQuery,
): Promise<{ csv: string; rows: number; filename: string }> {
  const societyId = societyIdOf(ctx);
  const where = buildWhere(societyId, q);
  const total = await Ticket.count({ where });
  if (total > LIMITS.exportMaxRows)
    throw new AppError(422, ERR.exportTooLarge, 'Too many tickets to export. Narrow the dates or filters.', [
      { field: 'createdFrom', message: `${total} tickets match; the maximum is ${LIMITS.exportMaxRows}` },
    ]);
  const rows = await Ticket.findAll({ where, order: orderOf(q), limit: LIMITS.exportMaxRows });
  const cats = new Map(
    (await TicketCategory.findAll({ where: { societyId }, attributes: ['id', 'name'], paranoid: false })).map(
      c => [c.id, c.name],
    ),
  );
  const labels = await loadLabels(societyId, rows);
  const lines = [COLUMNS.join(',')];
  for (const t of rows)
    lines.push(
      [
        t.ticketNo,
        t.kind,
        t.status,
        t.priority,
        cats.get(t.categoryId),
        t.subCategoryId ? cats.get(t.subCategoryId) : '',
        t.kind === 'PERSONAL' ? labels.unit(t.unitId) : labels.location(t.locationNodeId),
        t.affectedUnitCount,
        t.requesterName,
        t.assigneeLabel,
        t.createdAt,
        t.firstResponseAt,
        t.resolvedAt,
        t.closedAt,
        t.responseBreached,
        t.resolutionBreached,
        t.upvoteCount,
        t.csatScore,
        t.reopenCount,
      ]
        .map(csvCell)
        .join(','),
    );
  const today = await societyToday(societyId);
  await audit(ctx, {
    action: AUDIT.exported,
    entityType: ENTITY.ticket,
    entityId: 'export',
    after: { filters: q, rowCount: rows.length },
    societyId,
  });
  return { csv: `${lines.join('\r\n')}\r\n`, rows: rows.length, filename: `tickets-${today}.csv` };
}

// ------------------------------------------------------------------ assignees (8.21)
interface Listable {
  listAssignable?: (societyId: number, o?: { q?: string }) => Promise<Record<string, unknown>[]>;
}

export async function listAssignees(ctx: Ctx, q: { q?: string; type?: 'MEMBER' | 'STAFF' | 'VENDOR' }) {
  const societyId = societyIdOf(ctx);
  const needle = q.q?.toLowerCase();
  const out = {
    members: [] as Record<string, unknown>[],
    staff: [] as Record<string, unknown>[],
    vendors: [] as Record<string, unknown>[],
  };
  const load = async (where: string): Promise<Map<number, number>> => {
    const rows = await sequelize.query<{ k: number; n: number }>(
      `SELECT ${where} AS k, COUNT(*) AS n FROM tickets WHERE societyId = :societyId AND status IN (:statuses) AND ${where} IS NOT NULL GROUP BY ${where}`,
      { replacements: { societyId, statuses: [...LOAD_STATUSES] }, type: QueryTypes.SELECT },
    );
    return new Map(rows.map(r => [Number(r.k), Number(r.n)]));
  };
  if (!q.type || q.type === 'MEMBER') {
    const rows = (await members.listForSociety(societyId, { statuses: ['ACTIVE'] })).filter(
      m => m.roleScope === 'society' || m.roleScope === 'work',
    );
    const ids = [...new Set(rows.map(r => r.userId))];
    const users = new Map(
      (await User.findAll({ where: { id: ids }, attributes: ['id', 'name'] })).map(u => [u.id, u.name ?? '']),
    );
    const roleNames = await roleNameMap(
      societyId,
      rows.map(r => r.roleKey),
    );
    const loads = await load('assigneeUserId');
    const seen = new Set<number>();
    for (const m of rows) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      const name = users.get(m.userId) ?? `User ${m.userId}`;
      if (needle && !name.toLowerCase().includes(needle)) continue;
      out.members.push({
        userId: m.userId,
        name,
        roleKey: m.roleKey,
        roleName: roleNames.get(m.roleKey) ?? m.roleKey,
        openCount: loads.get(m.userId) ?? 0,
      });
    }
    out.members.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  const ports = helpdeskPorts() as unknown as { staffDirectory: Listable; vendors: Listable };
  if ((!q.type || q.type === 'STAFF') && (await isFeatureOn(societyId, ENT.staffWorkerMaster))) {
    const loads = await load('assigneeUserId');
    out.staff = ((await ports.staffDirectory.listAssignable?.(societyId, { q: q.q })) ?? []).map(s => ({
      ...s,
      openCount: s.userId ? (loads.get(Number(s.userId)) ?? 0) : 0,
    }));
  }
  if ((!q.type || q.type === 'VENDOR') && (await isFeatureOn(societyId, ENT.vendorDispatch)))
    out.vendors = (await ports.vendors.listAssignable?.(societyId, { q: q.q })) ?? [];
  return out;
}

async function roleNameMap(societyId: number, keys: string[]): Promise<Map<string, string>> {
  const rows = await Role.findAll({
    where: { societyId: { [Op.or]: [societyId, null] } as never, key: [...new Set(keys)] },
    attributes: ['key', 'name', 'societyId'],
    paranoid: false,
  });
  const map = new Map<string, string>();
  for (const r of rows) if (!map.has(r.key) || r.societyId) map.set(r.key, r.name);
  return map;
}

// ------------------------------------------------------------------ similar (8.11)
export interface SimilarItem {
  id: number;
  ticketNo: string;
  title: string;
  status: string;
  priority: string;
  locationLabel: string | null;
  upvoteCount: number;
  createdAt: string;
  iUpvoted: boolean;
  isRequester: boolean;
}

/** BR-15-17 for the admin route (and reused by `helpdeskWork`): `404 LOCATION_NOT_FOUND`, `404 CATEGORY_NOT_FOUND`. */
export async function similarBuildingIssues(
  ctx: Ctx,
  q: { locationNodeId: number; categoryId: number; q?: string },
): Promise<{ items: SimilarItem[] }> {
  const societyId = societyIdOf(ctx);
  const node = await locations.get(societyId, q.locationNodeId);
  if (!node) throw new AppError(404, ERR.locationNotFound, 'Location not found');
  await loadEffectiveCategory(societyId, q.categoryId, null);
  const found = await findSimilarBuilding(societyId, {
    locationNodeId: node.id,
    categoryId: q.categoryId,
    buildingId: node.buildingId,
    q: q.q,
  });
  if (!found.length) return { items: [] };
  const userId = ctx.user?.id ?? 0;
  const rows = await Ticket.findAll({ where: { societyId, id: found.map(f => f.id) } });
  const byId = new Map(rows.map(r => [r.id, r]));
  const mine = new Set(
    (
      await TicketUpvote.findAll({
        where: { ticketId: found.map(f => f.id), userId },
        attributes: ['ticketId'],
      })
    ).map(u => u.ticketId),
  );
  const labels = await loadLabels(societyId, rows);
  return {
    items: found.map(f => ({
      id: f.id,
      ticketNo: f.ticketNo,
      title: f.title,
      status: f.status,
      priority: f.priority,
      locationLabel: labels.location(f.locationNodeId),
      upvoteCount: f.upvoteCount,
      createdAt: f.createdAt.toISOString(),
      iUpvoted: mine.has(f.id),
      isRequester: byId.get(f.id)?.requesterUserId === userId,
    })),
  };
}
