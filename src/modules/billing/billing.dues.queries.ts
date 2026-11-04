import { Op, QueryTypes } from 'sequelize';
import { Resident, UnitResident, sequelize } from '../../models';
import { addDaysYmd, diffDays } from './billing.calc.period';
import { policyFor } from './billing.latefee-policy.service';

/**
 * The one query per measure of the dues dashboard and the defaulter list (sections 8.22 and 8.25): the endpoints and
 * `billingReports` call these functions, so they cannot drift. Everything is scoped by `societyId`. Amounts are integer paise.
 */

/** Optional read limits of the report readers (8.25): `deadlineMs` aborts a slow query; `replica` is accepted, there is no replica yet. */
export interface ReadOpts {
  deadlineMs?: number;
  replica?: boolean;
}

export class ReadTimeoutError extends Error {
  constructor() {
    super('The report read timed out');
    this.name = 'ReadTimeoutError';
  }
}

const TIMEOUT_CODES = new Set([3024, 1317, 1969]);
const isTimeout = (err: unknown): boolean => {
  const e = err as { original?: { errno?: number }; parent?: { errno?: number }; errno?: number };
  return TIMEOUT_CODES.has(Number(e?.original?.errno ?? e?.parent?.errno ?? e?.errno));
};

/**
 * Runs a SELECT. With `deadlineMs` the optimizer hint `MAX_EXECUTION_TIME` aborts it in the database and the error becomes
 * `ReadTimeoutError` (module 24 maps it to `504 REPORT_TIMEOUT`).
 */
export async function readRows<T extends object>(
  sql: string,
  replacements: Record<string, unknown>,
  opts: ReadOpts = {},
): Promise<T[]> {
  const text =
    opts.deadlineMs && opts.deadlineMs > 0
      ? sql.replace(/^\s*SELECT\b/i, `SELECT /*+ MAX_EXECUTION_TIME(${Math.floor(opts.deadlineMs)}) */`)
      : sql;
  try {
    return await sequelize.query<T>(text, { replacements, type: QueryTypes.SELECT });
  } catch (err) {
    if (isTimeout(err)) throw new ReadTimeoutError();
    throw err;
  }
}

const n = (v: unknown): number => Number(v ?? 0);

// ------------------------------------------------------------------ summary (8.22)
export interface AgeingBucket {
  bucket: '0_30' | '31_60' | '61_90' | '90_PLUS';
  amountPaise: number;
}
export interface SummaryDto {
  billedPaise: number;
  collectedPaise: number;
  /** One decimal, half-up, as a string (`'95.5'`); null when nothing was billed. */
  efficiencyPct: string | null;
  outstandingPaise: number;
  overdueFlats: number;
  ageing: AgeingBucket[];
}

/** `collected x 100 / billed` with one decimal, half-up, from integers; null when `billed` is 0. */
export function efficiencyOf(collectedPaise: number, billedPaise: number): string | null {
  if (billedPaise <= 0) return null;
  const tenths = (BigInt(collectedPaise) * 1000n * 2n + BigInt(billedPaise)) / (BigInt(billedPaise) * 2n);
  return `${tenths / 10n}.${tenths % 10n}`;
}

export const monthBounds = (month: string): { from: string; to: string } => {
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: addDaysYmd(next, -1) };
};

/** `billed` of 8.22: Σ `totalPaise` of non-cancelled REGULAR and SUPPLEMENTARY invoices with `periodStart` in the month. */
export async function billedForMonth(
  societyId: number,
  month: string,
  opts: ReadOpts = {},
): Promise<{ billedPaise: number; collectedPaise: number; invoiceIds: number[] }> {
  const { from, to } = monthBounds(month);
  const rows = await readRows<{ id: number; totalPaise: string; paidPaise: string }>(
    `SELECT id, totalPaise, paidPaise FROM invoices
      WHERE societyId = :societyId AND status <> 'CANCELLED' AND invoiceType IN ('REGULAR', 'SUPPLEMENTARY')
        AND periodStart >= :from AND periodStart <= :to ORDER BY id`,
    { societyId, from, to },
    opts,
  );
  return {
    billedPaise: rows.reduce((a, r) => a + n(r.totalPaise), 0),
    collectedPaise: rows.reduce((a, r) => a + n(r.paidPaise), 0),
    invoiceIds: rows.map(r => n(r.id)),
  };
}

/** The dashboard KPIs of 8.22 (billed, collected, efficiency, outstanding, overdue flats, ageing) at `today`. */
export async function summaryOf(
  societyId: number,
  month: string,
  today: string,
  opts: ReadOpts = {},
): Promise<SummaryDto> {
  const { billedPaise, collectedPaise } = await billedForMonth(societyId, month, opts);
  const [open] = await readRows<Record<string, string | null>>(
    `SELECT COALESCE(SUM(outstandingPaise), 0) AS outstanding,
            COUNT(DISTINCT CASE WHEN dueDate < :today THEN unitId END) AS overdueFlats,
            COALESCE(SUM(CASE WHEN DATEDIFF(:today, dueDate) BETWEEN 1 AND 30 THEN outstandingPaise END), 0) AS b1,
            COALESCE(SUM(CASE WHEN DATEDIFF(:today, dueDate) BETWEEN 31 AND 60 THEN outstandingPaise END), 0) AS b2,
            COALESCE(SUM(CASE WHEN DATEDIFF(:today, dueDate) BETWEEN 61 AND 90 THEN outstandingPaise END), 0) AS b3,
            COALESCE(SUM(CASE WHEN DATEDIFF(:today, dueDate) > 90 THEN outstandingPaise END), 0) AS b4
       FROM invoices WHERE societyId = :societyId AND status <> 'CANCELLED' AND outstandingPaise > 0`,
    { societyId, today },
    opts,
  );
  return {
    billedPaise,
    collectedPaise,
    efficiencyPct: efficiencyOf(collectedPaise, billedPaise),
    outstandingPaise: n(open?.outstanding),
    overdueFlats: n(open?.overdueFlats),
    ageing: [
      { bucket: '0_30', amountPaise: n(open?.b1) },
      { bucket: '31_60', amountPaise: n(open?.b2) },
      { bucket: '61_90', amountPaise: n(open?.b3) },
      { bucket: '90_PLUS', amountPaise: n(open?.b4) },
    ],
  };
}

// ------------------------------------------------------------------ defaulters (BR-11-64, 8.22)
export interface DefaulterQuery {
  minDaysOverdue: number;
  minAmountPaise: number;
  buildingIds?: number[];
  sortBy: 'overduePaise' | 'daysOverdue' | 'unitLabel';
  sortDir: 'asc' | 'desc';
  /** Omitted: every row (the CSV export and the report reader's totals). */
  page?: number;
  limit?: number;
}
export interface DefaulterRow {
  unitId: number;
  unitLabel: string;
  ownerName: string;
  billToNames: string;
  ownerMobile: string | null;
  overduePaise: number;
  oldestDueDate: string;
  daysOverdue: number;
  invoiceCount: number;
}
export interface DefaulterResult {
  rows: DefaulterRow[];
  total: number;
  totals: { flats: number; overduePaise: number };
}

/** BR-11-9 owner party of each unit on a date: primary link, else `OWNER`, else the `CO_OWNER` with the lowest link id. */
export async function ownerPartiesOf(
  societyId: number,
  unitIds: number[],
  date: string,
): Promise<Map<number, { residentId: number; name: string; mobile: string | null }>> {
  const out = new Map<number, { residentId: number; name: string; mobile: string | null }>();
  if (!unitIds.length) return out;
  const links = await UnitResident.findAll({
    where: {
      societyId,
      unitId: { [Op.in]: unitIds },
      relation: { [Op.in]: ['OWNER', 'CO_OWNER'] },
      fromDate: { [Op.lte]: date },
      [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: date } }],
    },
    order: [['id', 'ASC']],
  });
  const people = new Map(
    (
      await Resident.findAll({
        where: { societyId, id: { [Op.in]: [...new Set(links.map(l => l.residentId))] } },
        paranoid: false,
      })
    ).map(r => [r.id!, r]),
  );
  const rank = (l: UnitResident) => (l.relation === 'OWNER' ? (l.isPrimary ? 0 : 1) : 2);
  for (const unitId of unitIds) {
    const pick = links.filter(l => l.unitId === unitId).sort((a, b) => rank(a) - rank(b) || a.id! - b.id!)[0];
    const p = pick ? people.get(pick.residentId) : undefined;
    if (pick && p) out.set(unitId, { residentId: p.id!, name: p.name, mobile: p.mobile });
  }
  return out;
}

const SORT_SQL: Record<DefaulterQuery['sortBy'], string> = {
  overduePaise: 'overduePaise',
  daysOverdue: 'oldestDueDate',
  unitLabel: 'unitLabel',
};

/**
 * BR-11-64: flats whose overdue amount (Σ outstanding of non-disputed, non-cancelled invoices with `dueDate + graceDays < today`)
 * is at least `minAmountPaise` and whose oldest such due date is at least `minDaysOverdue` days ago. `graceDays` comes from the
 * late fee policy effective today (0 without one).
 */
export async function defaultersOf(
  societyId: number,
  q: DefaulterQuery,
  today: string,
  opts: ReadOpts = {},
): Promise<DefaulterResult> {
  const grace = Number((await policyFor(societyId, today))?.graceDays ?? 0);
  const buildings = q.buildingIds?.length ? 'AND u.buildingId IN (:buildingIds)' : '';
  const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
  // days overdue grow as the oldest due date gets older, so the sort direction on `daysOverdue` is reversed
  const order =
    q.sortBy === 'daysOverdue'
      ? `oldestDueDate ${dir === 'ASC' ? 'DESC' : 'ASC'}`
      : `${SORT_SQL[q.sortBy]} ${dir}`;
  const paging =
    q.page && q.limit ? `LIMIT ${Math.floor(q.limit)} OFFSET ${Math.floor((q.page - 1) * q.limit)}` : '';
  const base = `FROM invoices i JOIN units u ON u.id = i.unitId
      WHERE i.societyId = :societyId AND i.status <> 'CANCELLED' AND i.isDisputed = 0 AND i.outstandingPaise > 0
        AND DATE_ADD(i.dueDate, INTERVAL :grace DAY) < :today ${buildings}
      GROUP BY i.unitId
     HAVING SUM(i.outstandingPaise) >= :minAmount AND DATEDIFF(:today, MIN(i.dueDate)) >= :minDays`;
  const rep = {
    societyId,
    today,
    grace,
    minAmount: q.minAmountPaise,
    minDays: q.minDaysOverdue,
    buildingIds: q.buildingIds ?? [0],
  };
  const rows = await readRows<{
    unitId: number;
    unitLabel: string;
    overduePaise: string;
    oldestDueDate: string | Date;
    invoiceCount: number;
    billToNames: string | null;
  }>(
    `SELECT i.unitId AS unitId, MAX(i.unitLabel) AS unitLabel, SUM(i.outstandingPaise) AS overduePaise,
            MIN(i.dueDate) AS oldestDueDate, COUNT(*) AS invoiceCount,
            GROUP_CONCAT(DISTINCT i.billToName ORDER BY i.billToName SEPARATOR ', ') AS billToNames
       ${base} ORDER BY ${order}, unitId ASC ${paging}`,
    rep,
    opts,
  );
  const [all] = await readRows<{ flats: number; overdue: string | null }>(
    `SELECT COUNT(*) AS flats, COALESCE(SUM(t.overduePaise), 0) AS overdue FROM
       (SELECT SUM(i.outstandingPaise) AS overduePaise ${base}) t`,
    rep,
    opts,
  );
  const owners = await ownerPartiesOf(
    societyId,
    rows.map(r => n(r.unitId)),
    today,
  );
  return {
    rows: rows.map(r => {
      const oldest =
        typeof r.oldestDueDate === 'string' ? r.oldestDueDate : r.oldestDueDate.toISOString().slice(0, 10);
      const o = owners.get(n(r.unitId));
      return {
        unitId: n(r.unitId),
        unitLabel: r.unitLabel,
        ownerName: o?.name ?? '',
        billToNames: r.billToNames ?? '',
        ownerMobile: o?.mobile ?? null,
        overduePaise: n(r.overduePaise),
        oldestDueDate: oldest.slice(0, 10),
        daysOverdue: diffDays(oldest.slice(0, 10), today),
        invoiceCount: n(r.invoiceCount),
      };
    }),
    total: n(all?.flats),
    totals: { flats: n(all?.flats), overduePaise: n(all?.overdue) },
  };
}
