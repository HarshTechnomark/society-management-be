import { Op } from 'sequelize';
import { Building, Invoice, InvoiceLine, Unit } from '../../models';
import { addDaysYmd, diffDays } from './billing.calc.period';
import {
  defaultersOf,
  efficiencyOf,
  ownerPartiesOf,
  readRows,
  summaryOf,
  type DefaulterResult,
  type ReadOpts,
  type SummaryDto,
} from './billing.dues.queries';
import { balanceEventsFor, outstandingAsOf } from './billing.latefee.events';
import { billingPorts } from './billing.ports';
import { societyToday } from './billing.setup.shared';

export { ReadTimeoutError } from './billing.dues.queries';
export type { ReadOpts } from './billing.dues.queries';

/**
 * Report readers for module 24 (section 8.25), exported as `billingReports`. Read-only; every function takes the society id from
 * the caller's context. They use the same query functions as `GET /billing/summary` and `/defaulters`
 * (`billing.dues.queries.ts`), so endpoint and reader cannot drift. `opts.deadlineMs` aborts a slow query with
 * `ReadTimeoutError`; `opts.replica` is accepted but there is no read replica yet.
 */
const n = (v: unknown): number => Number(v ?? 0);
type Dir = 'asc' | 'desc';
const sortRows = <T>(rows: T[], key: (r: T) => string | number, dir: Dir): T[] =>
  [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return dir === 'asc' ? c : -c;
  });
const pageOf = <T>(rows: T[], page: number, limit: number): T[] =>
  rows.slice((page - 1) * limit, page * limit);

export interface ListQuery {
  page: number;
  limit: number;
  sortDir: Dir;
  buildingIds?: number[];
}

/** Units of the society restricted to the buildings (null: no restriction). */
async function buildingUnitIds(societyId: number, buildingIds?: number[]): Promise<Set<number> | null> {
  if (!buildingIds?.length) return null;
  const rows = await Unit.findAll({
    where: { societyId, buildingId: { [Op.in]: buildingIds } },
    attributes: ['id'],
  });
  return new Set(rows.map(u => Number(u.id)));
}

export interface AgeingRow {
  unitId: number;
  unitLabel: string;
  ownerName: string;
  notDuePaise: number;
  d1_30Paise: number;
  d31_60Paise: number;
  d61_90Paise: number;
  d91PlusPaise: number;
  totalPaise: number;
  disputedPaise: number;
}
type AgeingTotals = Record<
  | 'notDuePaise'
  | 'd1_30Paise'
  | 'd31_60Paise'
  | 'd61_90Paise'
  | 'd91PlusPaise'
  | 'totalPaise'
  | 'disputedPaise',
  number
>;

export const billingReports = {
  /** Exactly `GET /billing/summary` (without the cache and the `month` echo). */
  async summary(societyId: number, month: string, opts: ReadOpts = {}): Promise<SummaryDto> {
    return summaryOf(societyId, month, await societyToday(societyId), opts);
  },

  /** BR-11-64; rows and totals equal `GET /billing/defaulters` for the same filters (plus the unmasked owner mobile). */
  async defaulters(
    societyId: number,
    q: ListQuery & {
      minDaysOverdue: number;
      minAmountPaise: number;
      sortBy: 'overduePaise' | 'daysOverdue' | 'unitLabel';
    },
    opts: ReadOpts = {},
  ): Promise<DefaulterResult> {
    return defaultersOf(societyId, { ...q }, await societyToday(societyId), opts);
  },

  /**
   * Ageing per flat at `asOf` by days past `dueDate`. Today it reads the current outstanding column; for an earlier day the
   * outstanding of each invoice is rebuilt from its dated events (allocations by `allocatedOn`, notes by `noteDate`).
   * `disputedPaise` repeats the disputed part of all open amounts and is not added to `totalPaise`.
   */
  async ageingByUnit(
    societyId: number,
    asOf: string,
    q: ListQuery & { unitId?: number; sortBy: 'totalPaise' | 'd91PlusPaise' | 'unitLabel' },
    opts: ReadOpts = {},
  ): Promise<{ rows: AgeingRow[]; total: number; totals: AgeingTotals }> {
    const today = await societyToday(societyId);
    const where = {
      societyId,
      invoiceDate: { [Op.lte]: asOf },
      ...(asOf >= today ? { status: { [Op.ne]: 'CANCELLED' }, outstandingPaise: { [Op.gt]: 0 } } : {}),
      ...(q.unitId ? { unitId: q.unitId } : {}),
    };
    // one deadline-aware probe so a slow database fails fast as a ReadTimeoutError
    await readRows('SELECT 1 AS ok', {}, opts);
    const invoices = await Invoice.findAll({ where, order: [['id', 'ASC']] });
    const events = asOf >= today ? null : await balanceEventsFor(societyId, invoices);
    const allowed = await buildingUnitIds(societyId, q.buildingIds);
    const byUnit = new Map<number, AgeingRow>();
    for (const inv of invoices) {
      const unitId = n(inv.unitId);
      if (allowed && !allowed.has(unitId)) continue;
      const out = events ? outstandingAsOf(events.get(n(inv.id)) ?? [], asOf) : n(inv.outstandingPaise);
      if (out <= 0) continue;
      const row =
        byUnit.get(unitId) ??
        ({
          unitId,
          unitLabel: inv.unitLabel,
          ownerName: '',
          notDuePaise: 0,
          d1_30Paise: 0,
          d31_60Paise: 0,
          d61_90Paise: 0,
          d91PlusPaise: 0,
          totalPaise: 0,
          disputedPaise: 0,
        } as AgeingRow);
      const late = diffDays(inv.dueDate, asOf);
      if (late <= 0) row.notDuePaise += out;
      else if (late <= 30) row.d1_30Paise += out;
      else if (late <= 60) row.d31_60Paise += out;
      else if (late <= 90) row.d61_90Paise += out;
      else row.d91PlusPaise += out;
      row.totalPaise += out;
      if (inv.isDisputed) row.disputedPaise += out;
      byUnit.set(unitId, row);
    }
    const all = [...byUnit.values()];
    const owners = await ownerPartiesOf(
      societyId,
      all.map(r => r.unitId),
      asOf,
    );
    for (const r of all) r.ownerName = owners.get(r.unitId)?.name ?? '';
    const totals = all.reduce<AgeingTotals>(
      (a, r) => ({
        notDuePaise: a.notDuePaise + r.notDuePaise,
        d1_30Paise: a.d1_30Paise + r.d1_30Paise,
        d31_60Paise: a.d31_60Paise + r.d31_60Paise,
        d61_90Paise: a.d61_90Paise + r.d61_90Paise,
        d91PlusPaise: a.d91PlusPaise + r.d91PlusPaise,
        totalPaise: a.totalPaise + r.totalPaise,
        disputedPaise: a.disputedPaise + r.disputedPaise,
      }),
      {
        notDuePaise: 0,
        d1_30Paise: 0,
        d31_60Paise: 0,
        d61_90Paise: 0,
        d91PlusPaise: 0,
        totalPaise: 0,
        disputedPaise: 0,
      },
    );
    const sorted = sortRows(all, r => (q.sortBy === 'unitLabel' ? r.unitLabel : r[q.sortBy]), q.sortDir);
    return { rows: pageOf(sorted, q.page, q.limit), total: all.length, totals };
  },

  /**
   * Billed, collected and outstanding of non-cancelled REGULAR and SUPPLEMENTARY invoices with `periodStart` in `from`..`to`
   * (at most 731 days), grouped by month, charge head or building. For `chargeHead`, billed is the head's line amounts and
   * collected / outstanding are the invoice's paid / open amounts shared in proportion to the line amounts (integer, largest
   * remainder to the first group).
   */
  async collectionSummary(
    societyId: number,
    q: ListQuery & {
      from: string;
      to: string;
      groupBy: 'month' | 'chargeHead' | 'building';
      sortBy: 'group' | 'billedPaise' | 'collectedPaise';
    },
    opts: ReadOpts = {},
  ) {
    if (diffDays(q.from, q.to) + 1 > 731) throw new RangeError('The range is at most 731 days');
    await readRows('SELECT 1 AS ok', {}, opts);
    const invoices = await Invoice.findAll({
      where: {
        societyId,
        status: { [Op.ne]: 'CANCELLED' },
        invoiceType: { [Op.in]: ['REGULAR', 'SUPPLEMENTARY'] },
        periodStart: { [Op.gte]: q.from, [Op.lte]: q.to },
      },
    });
    const units = new Map(
      (
        await Unit.findAll({
          where: { societyId, id: { [Op.in]: [...new Set(invoices.map(i => n(i.unitId)))] } },
          attributes: ['id', 'buildingId'],
        })
      ).map(u => [n(u.id), n(u.buildingId)]),
    );
    const allowed = q.buildingIds?.length ? new Set(q.buildingIds) : null;
    const kept = invoices.filter(i => !allowed || allowed.has(units.get(n(i.unitId)) ?? -1));
    const groups = new Map<
      string,
      { billedPaise: number; collectedPaise: number; outstandingPaise: number }
    >();
    const add = (g: string, b: number, c: number, o: number) => {
      const x = groups.get(g) ?? { billedPaise: 0, collectedPaise: 0, outstandingPaise: 0 };
      x.billedPaise += b;
      x.collectedPaise += c;
      x.outstandingPaise += o;
      groups.set(g, x);
    };
    const open = (i: Invoice) => n(i.totalPaise) + n(i.debitedPaise) - n(i.creditedPaise) - n(i.paidPaise);
    if (q.groupBy === 'month')
      for (const i of kept) add(i.periodStart!.slice(0, 7), n(i.totalPaise), n(i.paidPaise), open(i));
    else if (q.groupBy === 'building') {
      const codes = new Map(
        (await Building.findAll({ where: { societyId }, attributes: ['id', 'code'] })).map(b => [
          n(b.id),
          b.code,
        ]),
      );
      for (const i of kept)
        add(codes.get(units.get(n(i.unitId)) ?? -1) ?? 'UNKNOWN', n(i.totalPaise), n(i.paidPaise), open(i));
    } else {
      const lines = await InvoiceLine.findAll({
        where: {
          societyId,
          lineKind: { [Op.in]: ['CHARGE', 'INTEREST', 'LATE_FEE'] },
          invoiceId: { [Op.in]: kept.map(i => n(i.id)) },
        },
      });
      for (const i of kept) {
        const mine = lines.filter(l => n(l.invoiceId) === n(i.id));
        const sum = mine.reduce((a, l) => a + n(l.amountPaise), 0) || 1;
        let paid = n(i.paidPaise);
        let rest = open(i);
        mine.forEach((l, idx) => {
          const last = idx === mine.length - 1;
          const p = last ? paid : Math.floor((n(i.paidPaise) * n(l.amountPaise)) / sum);
          const o = last ? rest : Math.floor((open(i) * n(l.amountPaise)) / sum);
          paid -= p;
          rest -= o;
          add(l.headKey ?? 'OTHER', n(l.amountPaise), p, o);
        });
      }
    }
    const rows = [...groups].map(([group, g]) => ({
      group,
      ...g,
      efficiencyPct: efficiencyOf(g.collectedPaise, g.billedPaise),
    }));
    const totals = rows.reduce(
      (a, r) => ({
        billedPaise: a.billedPaise + r.billedPaise,
        collectedPaise: a.collectedPaise + r.collectedPaise,
        outstandingPaise: a.outstandingPaise + r.outstandingPaise,
      }),
      { billedPaise: 0, collectedPaise: 0, outstandingPaise: 0 },
    );
    const sorted = sortRows(rows, r => r[q.sortBy], q.sortDir);
    return { rows: pageOf(sorted, q.page, q.limit), total: rows.length, totals };
  },

  /**
   * Payment behaviour for every flat with at least 2 ISSUED, PARTIALLY_PAID or PAID invoices: its last 6 non-cancelled invoices
   * that are paid or overdue at `asOf`; `paymentCount` and `chequeReturns12m` come from module 12 (ports). No personal data.
   */
  async paymentBehaviour(societyId: number, asOf: string, opts: ReadOpts = {}) {
    await readRows('SELECT 1 AS ok', {}, opts);
    const all = await Invoice.findAll({
      where: {
        societyId,
        status: { [Op.in]: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] },
        invoiceDate: { [Op.lte]: asOf },
      },
      order: [
        ['dueDate', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    const byUnit = new Map<number, Invoice[]>();
    for (const i of all) byUnit.set(n(i.unitId), [...(byUnit.get(n(i.unitId)) ?? []), i]);
    const since = addDaysYmd(asOf, -365);
    const rows = [];
    for (const [unitId, list] of [...byUnit].sort((a, b) => a[0] - b[0])) {
      if (list.length < 2) continue;
      const last = list
        .filter(
          i =>
            (i.settledOn !== null && i.settledOn <= asOf) || (n(i.outstandingPaise) > 0 && i.dueDate < asOf),
        )
        .slice(0, 6);
      const invoices = [];
      for (const i of last) {
        const allocations = await billingPorts().payments.listAllocationsForInvoice(societyId, n(i.id));
        invoices.push({
          invoiceId: n(i.id),
          dueDate: i.dueDate,
          settledOn: i.settledOn,
          outstandingPaise: n(i.outstandingPaise),
          paymentCount: allocations.filter(a => a.amountPaise > 0 && a.allocatedOn <= asOf).length,
        });
      }
      rows.push({
        unitId,
        invoices,
        chequeReturns12m: await billingPorts().payments.chequeReturnCount(societyId, unitId, since),
      });
    }
    return { rows, total: rows.length };
  },
};
