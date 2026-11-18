import { Op, QueryTypes, type WhereOptions } from 'sequelize';
import { Ticket, TicketAssignment, TicketCategory, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { societyToday } from '../billing/billing.runs.shared';
import { NON_TERMINAL, type AssigneeType, type TicketKind } from './helpdesk.constants';
import { dayAfter, dayStart } from './helpdesk.admin.list';
import { setting } from './helpdesk.shared';

/** 8.19 stats and the 8.31 reader functions of module 24. Percentages are rounded half-up to one decimal and `null` when the denominator is 0. */

export const round1 = (x: number): number => Math.floor(x * 10 + 0.5 + 1e-9) / 10;
const pct = (n: number, d: number): number | null => (d ? round1((n / d) * 100) : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};
const minutes = (a: Date, b: Date): number => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

export interface HelpdeskStats {
  open: number;
  openByPriority: Record<'P1' | 'P2' | 'P3' | 'P4', number>;
  /** Open P1 + P2: the same number as the list `counts.URGENT`. */
  urgent: number;
  unassigned: number;
  breachedOpen: number;
  created: number;
  resolved: number;
  responseMetPct: number | null;
  resolutionMetPct: number | null;
  medianFirstResponseMinutes: number | null;
  medianResolutionMinutes: number | null;
  reopenRatePct: number | null;
  csatAvg: number | null;
  csatCount: number;
  backlogAge: { lt1d: number; d1to3: number; d3to7: number; gt7d: number };
  topCategories: { categoryId: number; name: string; count: number }[];
}

/** Society-local default range: the last 30 days up to today. */
export async function defaultRange(societyId: number): Promise<{ from: string; to: string }> {
  const to = await societyToday(societyId);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

export async function summary(
  societyId: number,
  from: string,
  to: string,
  filters: { kind?: TicketKind; categoryId?: number } = {},
): Promise<HelpdeskStats> {
  const base: WhereOptions[] = [{ societyId }];
  if (filters.kind) base.push({ kind: filters.kind });
  if (filters.categoryId)
    base.push({ [Op.or]: [{ categoryId: filters.categoryId }, { subCategoryId: filters.categoryId }] });
  const a = dayStart(from);
  const b = dayAfter(to);
  const inRange = (col: string): WhereOptions => ({ [col]: { [Op.gte]: a, [Op.lt]: b } });
  const w = (...extra: WhereOptions[]): WhereOptions => ({ [Op.and]: [...base, ...extra] });
  const open = await Ticket.findAll({
    where: w({ status: { [Op.in]: [...NON_TERMINAL] } }),
    attributes: ['id', 'status', 'priority', 'createdAt', 'responseBreached', 'resolutionBreached'],
  });
  const created = await Ticket.count({ where: w(inRange('createdAt'), { mergedIntoTicketId: null }) });
  const resolvedRows = await Ticket.findAll({
    where: w(inRange('resolvedAt'), { status: { [Op.ne]: 'CANCELLED' } }),
    attributes: [
      'slaStartAt',
      'resolvedAt',
      'firstResponseAt',
      'resolutionBreached',
      'csatAvgTenths',
      'csatCount',
    ],
  });
  const responded = await Ticket.findAll({
    where: w(inRange('firstResponseAt')),
    attributes: ['responseBreached'],
  });
  const reopened = await Ticket.count({
    where: w(inRange('slaStartAt'), { slaCycle: { [Op.gt]: 1 } }),
  });
  const cats = await sequelize.query<{ categoryId: number; n: number }>(
    `SELECT categoryId, COUNT(*) AS n FROM tickets WHERE societyId = :societyId AND createdAt >= :a AND createdAt < :b AND mergedIntoTicketId IS NULL
       ${filters.kind ? 'AND kind = :kind' : ''} ${filters.categoryId ? 'AND (categoryId = :cat OR subCategoryId = :cat)' : ''}
     GROUP BY categoryId ORDER BY n DESC, categoryId ASC LIMIT 5`,
    {
      replacements: { societyId, a, b, kind: filters.kind, cat: filters.categoryId },
      type: QueryTypes.SELECT,
    },
  );
  const names = new Map(
    (
      await TicketCategory.findAll({
        where: { id: cats.map(c => c.categoryId) },
        attributes: ['id', 'name'],
        paranoid: false,
      })
    ).map(c => [c.id, c.name]),
  );
  const at = now();
  const age = (t: { createdAt: Date }) => (at.getTime() - t.createdAt.getTime()) / 86_400_000;
  const byPriority = { P1: 0, P2: 0, P3: 0, P4: 0 };
  for (const t of open) byPriority[t.priority]++;
  const resolved = resolvedRows.length;
  const rated = resolvedRows.filter(r => r.csatCount > 0 && r.csatAvgTenths !== null);
  const csatCount = rated.reduce((s, r) => s + r.csatCount, 0);
  const csatSum = rated.reduce((s, r) => s + (r.csatAvgTenths ?? 0) * r.csatCount, 0);
  return {
    open: open.length,
    openByPriority: byPriority,
    urgent: byPriority.P1 + byPriority.P2,
    unassigned: open.filter(t => t.status === 'OPEN' || t.status === 'REOPENED').length,
    breachedOpen: open.filter(t => t.responseBreached || t.resolutionBreached).length,
    created,
    resolved,
    responseMetPct: pct(responded.filter(r => !r.responseBreached).length, responded.length),
    resolutionMetPct: pct(resolvedRows.filter(r => !r.resolutionBreached).length, resolved),
    medianFirstResponseMinutes: median(
      resolvedRows.filter(r => r.firstResponseAt).map(r => minutes(r.slaStartAt, r.firstResponseAt!)),
    ),
    medianResolutionMinutes: median(resolvedRows.map(r => minutes(r.slaStartAt, r.resolvedAt!))),
    reopenRatePct: pct(reopened, resolved),
    csatAvg: csatCount ? round1(csatSum / csatCount / 10) : null,
    csatCount,
    backlogAge: {
      lt1d: open.filter(t => age(t) < 1).length,
      d1to3: open.filter(t => age(t) >= 1 && age(t) < 3).length,
      d3to7: open.filter(t => age(t) >= 3 && age(t) < 7).length,
      gt7d: open.filter(t => age(t) >= 7).length,
    },
    topCategories: cats.map(c => ({
      categoryId: Number(c.categoryId),
      name: names.get(Number(c.categoryId)) ?? '',
      count: Number(c.n),
    })),
  };
}

/** Per month (`YYYY-MM`, oldest first, ending with the current month): created, resolved, resolution met, CSAT. */
export async function monthly(societyId: number, months: number) {
  const today = await societyToday(societyId);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const out: {
    month: string;
    created: number;
    resolved: number;
    resolutionMetPct: number | null;
    csatAvg: number | null;
  }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const s = await summary(societyId, `${key}-01`, last);
    out.push({
      month: key,
      created: s.created,
      resolved: s.resolved,
      resolutionMetPct: s.resolutionMetPct,
      csatAvg: s.csatAvg,
    });
  }
  return out;
}

/** Groups of non-merged tickets created in the range sharing (location or unit or asset, category) with at least `helpdesk.recurringCount` tickets. */
export async function recurring(societyId: number, from: string, to: string) {
  const min = await setting<number>(societyId, 'helpdesk.recurringCount');
  const rows = await Ticket.findAll({
    where: {
      societyId,
      mergedIntoTicketId: null,
      createdAt: { [Op.gte]: dayStart(from), [Op.lt]: dayAfter(to) },
    },
    attributes: ['id', 'locationNodeId', 'unitId', 'assetId', 'categoryId'],
    order: [['id', 'ASC']],
  });
  const groups = new Map<
    string,
    {
      locationNodeId: number | null;
      unitId: number | null;
      assetId: number | null;
      categoryId: number;
      count: number;
      ticketIds: number[];
    }
  >();
  for (const r of rows) {
    const key = `${r.assetId ? `a${r.assetId}` : r.locationNodeId ? `l${r.locationNodeId}` : `u${r.unitId}`}:${r.categoryId}`;
    const g = groups.get(key) ?? {
      locationNodeId: r.assetId ? null : r.locationNodeId,
      unitId: r.assetId || r.locationNodeId ? null : r.unitId,
      assetId: r.assetId,
      categoryId: r.categoryId,
      count: 0,
      ticketIds: [],
    };
    g.count++;
    g.ticketIds.push(r.id);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter(g => g.count >= min)
    .sort((a, b) => b.count - a.count || a.categoryId - b.categoryId);
}

/** Tickets resolved in the range grouped by their assignee (the assignment current at the end). */
export async function assigneeProductivity(societyId: number, from: string, to: string) {
  const rows = await Ticket.findAll({
    where: {
      societyId,
      status: { [Op.in]: ['RESOLVED', 'CLOSED'] },
      resolvedAt: { [Op.gte]: dayStart(from), [Op.lt]: dayAfter(to) },
      currentAssignmentId: { [Op.ne]: null },
    },
    attributes: [
      'currentAssignmentId',
      'slaStartAt',
      'resolvedAt',
      'resolutionBreached',
      'csatAvgTenths',
      'csatCount',
    ],
  });
  const asg = new Map(
    (rows.length
      ? await TicketAssignment.findAll({ where: { id: rows.map(r => r.currentAssignmentId!) } })
      : []
    ).map(a => [a.id, a]),
  );
  const groups = new Map<string, { a: TicketAssignment; rows: Ticket[] }>();
  for (const r of rows) {
    const a = asg.get(r.currentAssignmentId!);
    if (!a) continue;
    const key = `${a.assigneeType}:${a.assigneeUserId ?? ''}:${a.staffId ?? ''}:${a.vendorId ?? ''}:${a.externalMobile ?? ''}`;
    const g = groups.get(key) ?? { a, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ a, rows: rs }) => {
      const rated = rs.filter(r => r.csatCount > 0 && r.csatAvgTenths !== null);
      const n = rated.reduce((s, r) => s + r.csatCount, 0);
      return {
        assigneeType: a.assigneeType as AssigneeType,
        assigneeUserId: a.assigneeUserId,
        staffId: a.staffId,
        vendorId: a.vendorId,
        label: a.assigneeLabel,
        resolved: rs.length,
        medianResolutionMinutes: median(rs.map(r => minutes(r.slaStartAt, r.resolvedAt!))),
        resolutionMetPct: pct(rs.filter(r => !r.resolutionBreached).length, rs.length),
        csatAvg: n
          ? round1(rated.reduce((s, r) => s + (r.csatAvgTenths ?? 0) * r.csatCount, 0) / n / 10)
          : null,
      };
    })
    .sort((x, y) => y.resolved - x.resolved || x.label.localeCompare(y.label));
}
