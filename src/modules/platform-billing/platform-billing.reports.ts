/**
 * Platform reports (8.24 to 8.27, 9.3): approvals queue, dunning list, revenue (MRR, series, plan mix, ageing, top
 * societies; BR-06-45, BR-06-46), GST summary and TDS receivable with CSV. Reads only; nothing here changes state.
 */
import { Op, QueryTypes } from 'sequelize';
import {
  AuditLog,
  DunningEvent,
  PlatformCredit,
  PlatformInvoice,
  PlatformPayment,
  Society,
  SocietyLifecycleEvent,
  User,
  sequelize,
} from '../../models';
import { istDate, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { roundHalfUp } from '../../lib/money';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { addDaysYmd, OPEN_STATUSES } from './pricing';
import { billingSettings } from './platform-billing.settings';
import { todayIst } from './platform-billing.settlement';
import { num } from './platform-billing.shared';

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header: string[], rows: unknown[][]): string =>
  [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
const rupees = (p: number) => (p / 100).toFixed(2);
const csvList = (v: string | undefined): string[] | undefined => v?.split(',').filter(Boolean);

async function namesOf(ids: (number | null)[]): Promise<Map<number, string>> {
  const list = [...new Set(ids.filter((x): x is number => x !== null))];
  const users = list.length ? await User.findAll({ where: { id: list }, attributes: ['id', 'name'] }) : [];
  return new Map(users.map(u => [u.id!, u.name ?? 'User']));
}
async function societyNames(ids: number[]): Promise<Map<number, string>> {
  const list = [...new Set(ids)];
  const rows = list.length ? await Society.findAll({ where: { id: list }, attributes: ['id', 'name'] }) : [];
  return new Map(rows.map(s => [s.id!, s.name]));
}

// ------------------------------------------------------------------ 8.24 approvals queue
export const APPROVAL_TYPES = [
  'MANUAL_PAYMENT',
  'REFUND',
  'MANUAL_INVOICE',
  'CREDIT_NOTE',
  'GOODWILL_CREDIT',
  'WRITE_OFF',
  'PAYMENT_MISMATCH',
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

interface RawItem {
  type: ApprovalType;
  id: number;
  societyId: number;
  amountPaise: number;
  createdBy: number | null;
  createdAt: Date;
  version: number;
  label: string | null;
  extra?: Record<string, unknown>;
}

/** Mismatches stay in the queue for a week after the audit row (unsettled orders only). */
const MISMATCH_DAYS = 7;

export async function approvalsQueue(
  ctx: Ctx,
  q: { type?: ApprovalType; page: number; limit: number; sortOrder: 'asc' | 'desc' },
) {
  const want = (t: ApprovalType) => !q.type || q.type === t;
  const items: RawItem[] = [];
  if (want('MANUAL_PAYMENT') || want('REFUND')) {
    const rows = await PlatformPayment.findAll({
      where: {
        status: 'PENDING_APPROVAL',
        kind: [...(want('MANUAL_PAYMENT') ? ['PAYMENT'] : []), ...(want('REFUND') ? ['REFUND'] : [])],
      },
    });
    for (const p of rows)
      items.push({
        type: p.kind === 'REFUND' ? 'REFUND' : 'MANUAL_PAYMENT',
        id: p.id!,
        societyId: p.societyId,
        amountPaise: num(p.amountPaise),
        createdBy: p.createdBy,
        createdAt: p.createdAt!,
        version: p.version,
        label: p.bankReference,
      });
  }
  if (want('MANUAL_INVOICE') || want('CREDIT_NOTE')) {
    const rows = await PlatformInvoice.findAll({
      where: {
        status: 'DRAFT',
        documentType: [
          ...(want('MANUAL_INVOICE') ? ['INVOICE'] : []),
          ...(want('CREDIT_NOTE') ? ['CREDIT_NOTE'] : []),
        ],
      },
    });
    for (const i of rows)
      items.push({
        type: i.documentType === 'CREDIT_NOTE' ? 'CREDIT_NOTE' : 'MANUAL_INVOICE',
        id: i.id!,
        societyId: i.societyId,
        amountPaise: num(i.totalPaise) || num(i.subtotalPaise),
        createdBy: i.createdBy,
        createdAt: i.createdAt!,
        version: i.version,
        label: i.invoiceNo,
      });
  }
  if (want('GOODWILL_CREDIT')) {
    const rows = await PlatformCredit.findAll({
      where: { status: 'PENDING_APPROVAL', entryType: 'GOODWILL' },
    });
    for (const c of rows)
      items.push({
        type: 'GOODWILL_CREDIT',
        id: c.id!,
        societyId: c.societyId,
        amountPaise: num(c.amountPaise),
        createdBy: c.createdBy,
        createdAt: c.createdAt!,
        version: c.version,
        label: c.reason,
      });
  }
  if (want('WRITE_OFF')) {
    const rows = await PlatformInvoice.findAll({
      where: {
        documentType: 'INVOICE',
        status: OPEN_STATUSES as unknown as string[],
        writeOffRequestedBy: { [Op.ne]: null },
      },
    });
    for (const i of rows)
      items.push({
        type: 'WRITE_OFF',
        id: i.id!,
        societyId: i.societyId,
        amountPaise: num(i.amountDuePaise),
        createdBy: i.writeOffRequestedBy,
        createdAt: i.writeOffRequestedAt ?? i.updatedAt!,
        version: i.version,
        label: i.invoiceNo,
        extra: { reason: i.writeOffReason },
      });
  }
  if (want('PAYMENT_MISMATCH')) {
    const since = new Date(now().getTime() - MISMATCH_DAYS * 86_400_000);
    const logs = await AuditLog.findAll({
      where: { action: 'platform_billing.payment.mismatch', createdAt: { [Op.gte]: since } },
      order: [['id', 'DESC']],
    });
    const byPayment = new Map<number, AuditLog>();
    for (const l of logs) if (!byPayment.has(Number(l.entityId))) byPayment.set(Number(l.entityId), l);
    const ids = [...byPayment.keys()];
    const rows = ids.length
      ? await PlatformPayment.findAll({
          where: { id: ids, kind: 'PAYMENT', status: ['CREATED', 'FAILED', 'EXPIRED'] },
        })
      : [];
    for (const p of rows) {
      const after = (byPayment.get(p.id!)?.after ?? {}) as { gatewayAmountPaise?: number };
      items.push({
        type: 'PAYMENT_MISMATCH',
        id: p.id!,
        societyId: p.societyId,
        amountPaise: num(p.amountPaise),
        createdBy: p.createdBy,
        createdAt: byPayment.get(p.id!)!.createdAt!,
        version: p.version,
        label: p.gatewayOrderId,
        extra: { gatewayOrderId: p.gatewayOrderId, gatewayAmountPaise: after.gatewayAmountPaise ?? null },
      });
    }
  }
  const dir = q.sortOrder === 'asc' ? 1 : -1;
  items.sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()) || dir * (a.id - b.id));
  const page = items.slice((q.page - 1) * q.limit, q.page * q.limit);
  const people = await namesOf(page.map(i => i.createdBy));
  const societies = await societyNames(page.map(i => i.societyId));
  const me = ctx.user?.id ?? null;
  return {
    data: page.map(i => ({
      type: i.type,
      id: i.id,
      societyId: i.societyId,
      societyName: societies.get(i.societyId) ?? null,
      amountPaise: i.amountPaise,
      label: i.label,
      createdBy: i.createdBy === null ? null : { id: i.createdBy, name: people.get(i.createdBy) ?? null },
      createdAt: i.createdAt.toISOString(),
      version: i.version,
      // a mismatch is settled by recording the payment manually, so there is nothing to approve
      canApprove: i.type !== 'PAYMENT_MISMATCH' && i.createdBy !== me,
      ...(i.extra ?? {}),
    })),
    pagination: pageMeta(q.page, q.limit, items.length),
  };
}

// ------------------------------------------------------------------ 8.25 dunning list
export interface DunningQuery {
  status?: string;
  page: number;
  limit: number;
  sortBy: 'daysLate' | 'overduePaise' | 'nextSuspensionDate';
  sortOrder: 'asc' | 'desc';
}

export async function dunningList(q: DunningQuery) {
  const s = await billingSettings();
  const min = Math.max(1, s['billing.dunningMinDuePaise']);
  const today = todayIst();
  const statuses = csvList(q.status) ?? ['PAST_DUE', 'SUSPENDED'];
  const societies = await Society.findAll({
    where: { status: statuses },
    attributes: ['id', 'name', 'city', 'status', 'suspensionHoldUntil'],
  });
  const ids = societies.map(x => x.id!);
  const open = ids.length
    ? await PlatformInvoice.findAll({
        where: {
          societyId: ids,
          documentType: 'INVOICE',
          status: OPEN_STATUSES as unknown as string[],
          amountDuePaise: { [Op.gt]: 0 },
          dueDate: { [Op.lt]: today },
        },
      })
    : [];
  const events = ids.length
    ? await DunningEvent.findAll({
        where: { societyId: ids, outcome: 'DONE', step: ['REMINDER', 'PAST_DUE', 'SUSPENDED'] },
        order: [['id', 'DESC']],
      })
    : [];
  const pending = ids.length
    ? ((await PlatformPayment.findAll({
        attributes: ['societyId', [sequelize.fn('SUM', sequelize.col('amountPaise')), 'total']],
        where: { societyId: ids, kind: 'PAYMENT', status: 'PENDING_APPROVAL' },
        group: ['societyId'],
        raw: true,
      })) as unknown as { societyId: number; total: string }[])
    : [];
  const pendingBy = new Map(pending.map(p => [p.societyId, Number(p.total)]));
  const rows = societies
    .map(soc => {
      const inv = open.filter(i => i.societyId === soc.id);
      if (!inv.length) return null;
      const oldest = inv.map(i => i.dueDate!).sort()[0]!;
      const last = events.find(e => e.societyId === soc.id);
      const suspensions = inv
        .filter(i => num(i.amountDuePaise) >= min && i.suspendOn)
        .map(i => i.suspendOn!)
        .sort();
      return {
        societyId: soc.id!,
        societyName: soc.name,
        city: soc.city,
        status: soc.status,
        overduePaise: inv.reduce((a, i) => a + num(i.amountDuePaise), 0),
        overdueInvoiceCount: inv.length,
        oldestDueDate: oldest,
        daysLate: Math.round(
          (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000,
        ),
        lastStep: last
          ? last.step === 'REMINDER'
            ? `REMINDER ${last.offsetDays! >= 0 ? '+' : ''}${last.offsetDays}`
            : last.step
          : null,
        nextSuspensionDate: suspensions[0] ?? null,
        holdUntil: soc.suspensionHoldUntil ? istDate(soc.suspensionHoldUntil) : null,
        pendingManualPaymentPaise: pendingBy.get(soc.id!) ?? 0,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const dir = q.sortOrder === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = q.sortBy === 'nextSuspensionDate' ? (a.nextSuspensionDate ?? '9999') : a[q.sortBy];
    const bv = q.sortBy === 'nextSuspensionDate' ? (b.nextSuspensionDate ?? '9999') : b[q.sortBy];
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir || a.societyId - b.societyId;
  });
  return {
    data: rows.slice((q.page - 1) * q.limit, q.page * q.limit),
    pagination: pageMeta(q.page, q.limit, rows.length),
  };
}

// ------------------------------------------------------------------ revenue (BR-06-45, BR-06-46)
const monthsOf = (cycle: string | null): number => (cycle === 'ANNUAL' ? 12 : 1);
const endOfIstDay = (d: string): Date => new Date(`${d}T23:59:59.999+05:30`);
const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};
const prevMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 2, 1));
  return d.toISOString().slice(0, 7);
};

interface ValueRow {
  id: number;
  societyId: number;
  planKey: string | null;
  periodStart: string;
  periodEnd: string;
  months: number;
  value: number;
}

/** Everything BR-06-45 needs, loaded once; `at(date)` answers per society. */
export class MrrModel {
  private constructor(
    private readonly byInvoice: Map<number, ValueRow[]>,
    private readonly timeline: Map<number, { at: number; status: string }[]>,
  ) {}

  static async load(): Promise<MrrModel> {
    const rows = await sequelize.query<{
      id: number;
      societyId: number;
      planKey: string | null;
      periodStart: string;
      periodEnd: string;
      billingCycle: string | null;
      value: string | null;
    }>(
      `SELECT i.id, i.societyId, i.planKey, i.periodStart, i.periodEnd, i.billingCycle,
              SUM(CASE WHEN l.lineType IN ('PLAN','DISCOUNT','ADDON') THEN l.amountPaise ELSE 0 END) AS value
         FROM platform_invoices i
         LEFT JOIN platform_invoice_lines l ON l.invoiceId = i.id
        WHERE i.documentType = 'INVOICE' AND i.invoiceKind = 'PERIOD' AND i.periodStart IS NOT NULL
          AND i.status NOT IN ('VOID','DRAFT','REJECTED')
        GROUP BY i.id, i.societyId, i.planKey, i.periodStart, i.periodEnd, i.billingCycle`,
      { type: QueryTypes.SELECT },
    );
    const byInvoice = new Map<number, ValueRow[]>();
    for (const r of rows) {
      const list = byInvoice.get(Number(r.societyId)) ?? [];
      list.push({
        id: Number(r.id),
        societyId: Number(r.societyId),
        planKey: r.planKey,
        periodStart: String(r.periodStart),
        periodEnd: String(r.periodEnd),
        months: monthsOf(r.billingCycle),
        value: Number(r.value ?? 0),
      });
      byInvoice.set(Number(r.societyId), list);
    }
    const ids = [...byInvoice.keys()];
    const events = ids.length
      ? await SocietyLifecycleEvent.findAll({
          where: { societyId: ids, toStatus: { [Op.ne]: null } },
          attributes: ['societyId', 'toStatus', 'createdAt', 'id'],
          order: [
            ['createdAt', 'ASC'],
            ['id', 'ASC'],
          ],
        })
      : [];
    const timeline = new Map<number, { at: number; status: string }[]>();
    for (const e of events) {
      const list = timeline.get(e.societyId) ?? [];
      list.push({ at: e.createdAt!.getTime(), status: e.toStatus! });
      timeline.set(e.societyId, list);
    }
    return new MrrModel(byInvoice, timeline);
  }

  /** Status of module 05 `getStatusAt` semantics: the last transition up to the end of the IST day. */
  private statusAt(societyId: number, date: string): string | null {
    const t = endOfIstDay(date).getTime();
    let status: string | null = null;
    for (const e of this.timeline.get(societyId) ?? []) {
      if (e.at > t) break;
      status = e.status;
    }
    return status;
  }

  /** MRR per society on the date (only societies with a value above 0). */
  at(date: string): Map<number, { mrrPaise: number; planKey: string | null }> {
    const out = new Map<number, { mrrPaise: number; planKey: string | null }>();
    for (const [societyId, list] of this.byInvoice) {
      const hit = list
        .filter(r => r.periodStart <= date && date <= r.periodEnd)
        .sort((a, b) => b.id - a.id)[0];
      if (!hit) continue;
      const status = this.statusAt(societyId, date);
      if (status !== 'ACTIVE' && status !== 'PAST_DUE') continue;
      const mrrPaise = roundHalfUp(hit.value, hit.months);
      if (mrrPaise > 0) out.set(societyId, { mrrPaise, planKey: hit.planKey });
    }
    return out;
  }

  total(date: string): number {
    let sum = 0;
    for (const v of this.at(date).values()) sum += v.mrrPaise;
    return sum;
  }
}

/** Module 07 dashboard (9.3). */
export async function getMrrSummary(input: { asOf: Date; comparedTo: Date }) {
  const m = await MrrModel.load();
  const mrrPaise = m.total(istDate(input.asOf));
  const previousMrrPaise = m.total(istDate(input.comparedTo));
  return { mrrPaise, previousMrrPaise, netChangePaise: mrrPaise - previousMrrPaise };
}

const mondayOf = (d: string): string => {
  const dt = new Date(`${d}T00:00:00Z`);
  const dow = (dt.getUTCDay() + 6) % 7;
  return addDaysYmd(d, -dow);
};

export async function getMrrSeries(input: { from: string; to: string; bucket: 'DAY' | 'WEEK' }) {
  const m = await MrrModel.load();
  const labels: string[] = [];
  const mrrPaise: number[] = [];
  const step = input.bucket === 'DAY' ? 1 : 7;
  let start = input.bucket === 'DAY' ? input.from : mondayOf(input.from);
  while (start <= input.to) {
    const end = addDaysYmd(start, step - 1);
    labels.push(start);
    mrrPaise.push(m.total(end > input.to ? input.to : end));
    start = addDaysYmd(start, step);
  }
  return { labels, mrrPaise };
}

const pct2 = (n: number, d: number): string => {
  if (d <= 0) return '0.00';
  const v = roundHalfUp(n * 10_000, d); // hundredths of a percent
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`;
};

export async function revenueSeriesFor(m: MrrModel, asOf: string, months: number) {
  const series: {
    month: string;
    startMrrPaise: number;
    newPaise: number;
    expansionPaise: number;
    contractionPaise: number;
    churnedPaise: number;
    endMrrPaise: number;
    logoChurnPct: string;
    revenueChurnPct: string;
  }[] = [];
  let month = asOf.slice(0, 7);
  const list: string[] = [];
  for (let i = 0; i < months; i++) {
    list.unshift(month);
    month = prevMonth(month);
  }
  for (const mo of list) {
    const S = lastDayOf(prevMonth(mo));
    const lastDay = lastDayOf(mo);
    const E = lastDay > asOf ? asOf : lastDay;
    const a = m.at(S);
    const b = m.at(E);
    let startMrr = 0;
    let endMrr = 0;
    let neu = 0;
    let exp = 0;
    let con = 0;
    let churned = 0;
    let churnedCount = 0;
    for (const v of a.values()) startMrr += v.mrrPaise;
    for (const [id, v] of b) {
      endMrr += v.mrrPaise;
      const was = a.get(id)?.mrrPaise ?? 0;
      if (was === 0) neu += v.mrrPaise;
      else if (v.mrrPaise > was) exp += v.mrrPaise - was;
      else if (v.mrrPaise < was) con += was - v.mrrPaise;
    }
    for (const [id, v] of a)
      if (!b.has(id)) {
        churned += v.mrrPaise;
        churnedCount += 1;
      }
    series.push({
      month: mo,
      startMrrPaise: startMrr,
      newPaise: neu,
      expansionPaise: exp,
      contractionPaise: con,
      churnedPaise: churned,
      endMrrPaise: endMrr,
      logoChurnPct: pct2(churnedCount, a.size),
      revenueChurnPct: pct2(churned + con, startMrr),
    });
  }
  return series;
}

const monthRangeIst = (asOf: string): { from: Date; to: Date; fromYmd: string; toYmd: string } => {
  const fromYmd = `${asOf.slice(0, 7)}-01`;
  const toYmd = lastDayOf(asOf.slice(0, 7));
  return {
    from: new Date(`${fromYmd}T00:00:00+05:30`),
    to: new Date(new Date(`${toYmd}T00:00:00+05:30`).getTime() + 86_400_000),
    fromYmd,
    toYmd,
  };
};

const cacheKey = (asOf: string, months: number) => `plt-revenue:${asOf}:${months}`;
/** Test and admin helper: drops cached revenue answers. */
export const clearRevenueCache = (): Promise<void> => kv().cacheDelPrefix('plt-revenue:');

/** 8.26; cached 10 minutes per `(asOf, months)`. */
export async function revenueReport(q: { asOf?: string; months: number }) {
  const asOf = q.asOf ?? todayIst();
  const key = cacheKey(asOf, q.months);
  const hit = await kv().cacheGet(key);
  if (hit) return JSON.parse(hit) as Awaited<ReturnType<typeof computeRevenue>>;
  const out = await computeRevenue(asOf, q.months);
  await kv().cacheSet(key, JSON.stringify(out), 600);
  return out;
}

async function computeRevenue(asOf: string, months: number) {
  const m = await MrrModel.load();
  const now0 = m.at(asOf);
  let mrr = 0;
  const byPlan = new Map<string, number>();
  for (const v of now0.values()) {
    mrr += v.mrrPaise;
    const k = v.planKey ?? 'OTHER';
    byPlan.set(k, (byPlan.get(k) ?? 0) + v.mrrPaise);
  }
  const range = monthRangeIst(asOf);
  const collected = num(
    await PlatformPayment.sum('amountPaise', {
      where: { kind: 'PAYMENT', status: 'CAPTURED', capturedAt: { [Op.gte]: range.from, [Op.lt]: range.to } },
    }),
  );
  const issued = await PlatformInvoice.findAll({
    attributes: ['documentType', 'totalPaise', 'taxPaise'],
    where: {
      issueDate: { [Op.between]: [range.fromYmd, range.toYmd] },
      status: { [Op.notIn]: ['DRAFT', 'REJECTED'] },
    },
  });
  let billed = 0;
  let gst = 0;
  for (const i of issued) {
    const sign = i.documentType === 'CREDIT_NOTE' ? -1 : 1;
    billed += sign * num(i.totalPaise); // net of credit notes issued in the month
    gst += sign * num(i.taxPaise);
  }
  const open = await PlatformInvoice.findAll({
    attributes: ['amountDuePaise', 'dueDate'],
    where: {
      documentType: 'INVOICE',
      status: OPEN_STATUSES as unknown as string[],
      amountDuePaise: { [Op.gt]: 0 },
    },
  });
  const ageing = { notDuePaise: 0, d1to15Paise: 0, d16to30Paise: 0, d31to60Paise: 0, over60Paise: 0 };
  let outstanding = 0;
  let overdue = 0;
  for (const i of open) {
    const amt = num(i.amountDuePaise);
    outstanding += amt;
    const late = Math.round(
      (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${i.dueDate}T00:00:00Z`)) / 86_400_000,
    );
    if (late <= 0) ageing.notDuePaise += amt;
    else {
      overdue += amt;
      if (late <= 15) ageing.d1to15Paise += amt;
      else if (late <= 30) ageing.d16to30Paise += amt;
      else if (late <= 60) ageing.d31to60Paise += amt;
      else ageing.over60Paise += amt;
    }
  }
  const [bal] = await sequelize.query<{ total: string | null }>(
    `SELECT SUM(c.balanceAfterPaise) AS total FROM platform_credits c
      WHERE c.status = 'POSTED' AND NOT EXISTS (
        SELECT 1 FROM platform_credits n WHERE n.societyId = c.societyId AND n.status = 'POSTED'
          AND (n.postedAt > c.postedAt OR (n.postedAt = c.postedAt AND n.id > c.id)))`,
    { type: QueryTypes.SELECT },
  );
  const top = [...now0.entries()].sort((a, b) => b[1].mrrPaise - a[1].mrrPaise || a[0] - b[0]).slice(0, 10);
  const names = await societyNames(top.map(([id]) => id));
  return {
    asOf,
    mrrPaise: mrr,
    arrPaise: mrr * 12,
    payingSocieties: now0.size,
    collectedThisMonthPaise: collected,
    billedThisMonthPaise: billed,
    outstandingPaise: outstanding,
    overduePaise: overdue,
    gstThisMonthPaise: gst,
    creditBalancesPaise: Number(bal?.total ?? 0),
    mrrByPlan: [...byPlan.entries()]
      .map(([planKey, mrrPaise]) => ({ planKey, mrrPaise }))
      .sort((a, b) => b.mrrPaise - a.mrrPaise || a.planKey.localeCompare(b.planKey)),
    ageing,
    series: await revenueSeriesFor(m, asOf, months),
    topSocieties: top.map(([societyId, v]) => ({
      societyId,
      name: names.get(societyId) ?? null,
      mrrPaise: v.mrrPaise,
    })),
  };
}

// ------------------------------------------------------------------ 8.27 GST summary and TDS receivable
export async function gstSummary(ctx: Ctx, q: { month: string; format: 'json' | 'csv' }) {
  const from = `${q.month}-01`;
  const to = lastDayOf(q.month);
  const docs = await PlatformInvoice.findAll({
    where: { issueDate: { [Op.between]: [from, to] }, status: { [Op.notIn]: ['DRAFT', 'REJECTED'] } },
    order: [['id', 'ASC']],
  });
  const groups = new Map<
    string,
    {
      supplyType: string;
      placeOfSupplyStateCode: string;
      documentType: string;
      count: number;
      taxablePaise: number;
      cgstPaise: number;
      sgstPaise: number;
      igstPaise: number;
    }
  >();
  for (const d of docs) {
    const supplyType = d.billingGstin ? 'B2B' : 'B2C';
    const key = `${d.documentType}|${supplyType}|${d.placeOfSupplyStateCode}`;
    const sign = d.documentType === 'CREDIT_NOTE' ? -1 : 1;
    const g = groups.get(key) ?? {
      supplyType,
      placeOfSupplyStateCode: d.placeOfSupplyStateCode,
      documentType: d.documentType,
      count: 0,
      taxablePaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
    };
    g.count += 1;
    g.taxablePaise += sign * num(d.subtotalPaise);
    g.cgstPaise += sign * num(d.cgstPaise);
    g.sgstPaise += sign * num(d.sgstPaise);
    g.igstPaise += sign * num(d.igstPaise);
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort(
    (a, b) =>
      a.documentType.localeCompare(b.documentType) * -1 ||
      a.supplyType.localeCompare(b.supplyType) ||
      a.placeOfSupplyStateCode.localeCompare(b.placeOfSupplyStateCode),
  );
  const net = rows.reduce(
    (a, r) => ({
      taxablePaise: a.taxablePaise + r.taxablePaise,
      cgstPaise: a.cgstPaise + r.cgstPaise,
      sgstPaise: a.sgstPaise + r.sgstPaise,
      igstPaise: a.igstPaise + r.igstPaise,
    }),
    { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
  );
  if (q.format === 'csv') {
    await audit(ctx, {
      action: 'platform_billing.report.exported',
      entityType: 'report',
      entityId: 'gst-summary',
      after: { month: q.month, rows: rows.length },
    });
    return {
      csv: toCsv(
        ['Document type', 'Supply type', 'Place of supply', 'Count', 'Taxable', 'CGST', 'SGST', 'IGST'],
        rows.map(r => [
          r.documentType,
          r.supplyType,
          r.placeOfSupplyStateCode,
          r.count,
          rupees(r.taxablePaise),
          rupees(r.cgstPaise),
          rupees(r.sgstPaise),
          rupees(r.igstPaise),
        ]),
      ),
    };
  }
  return { json: { month: q.month, rows, net } };
}

/** `2026-27` to its date range; a quarter (April based) narrows it. */
export function financialYearRange(fy: string, quarter?: number): { from: string; to: string } {
  const y = Number(fy.slice(0, 4));
  const startMonth = 3 + ((quarter ?? 1) - 1) * 3; // 0-based month index from April
  const spanMonths = quarter ? 3 : 12;
  const from = new Date(Date.UTC(y, startMonth, 1));
  const to = new Date(Date.UTC(y, startMonth + spanMonths, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export async function tdsReceivable(
  ctx: Ctx,
  q: { financialYear: string; quarter?: number; status?: string; format: 'json' | 'csv' },
) {
  const range = financialYearRange(q.financialYear, q.quarter);
  const statuses = csvList(q.status);
  const claims = await PlatformPayment.findAll({
    where: {
      kind: 'TDS',
      deductedOn: { [Op.between]: [range.from, range.to] },
      ...(statuses ? { status: statuses } : {}),
    },
    order: [['id', 'ASC']],
  });
  const names = await societyNames(claims.map(c => c.societyId));
  const groups = new Map<
    string,
    {
      societyId: number;
      societyName: string | null;
      tdsSection: string;
      claimedPaise: number;
      verifiedPaise: number;
      rejectedPaise: number;
      missingCertificates: number;
    }
  >();
  for (const c of claims) {
    const key = `${c.societyId}|${c.tdsSection}`;
    const g = groups.get(key) ?? {
      societyId: c.societyId,
      societyName: names.get(c.societyId) ?? null,
      tdsSection: String(c.tdsSection),
      claimedPaise: 0,
      verifiedPaise: 0,
      rejectedPaise: 0,
      missingCertificates: 0,
    };
    g.claimedPaise += num(c.amountPaise);
    if (c.status === 'VERIFIED') g.verifiedPaise += num(c.amountPaise);
    if (c.status === 'REJECTED') g.rejectedPaise += num(c.amountPaise);
    if (c.status !== 'REJECTED' && c.tdsCertificateFileId === null) g.missingCertificates += 1;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort(
    (a, b) =>
      (a.societyName ?? '').localeCompare(b.societyName ?? '') || a.tdsSection.localeCompare(b.tdsSection),
  );
  if (q.format === 'csv') {
    await audit(ctx, {
      action: 'platform_billing.report.exported',
      entityType: 'report',
      entityId: 'tds-receivable',
      after: { financialYear: q.financialYear, quarter: q.quarter ?? null, rows: rows.length },
    });
    return {
      csv: toCsv(
        ['Society', 'Section', 'Claimed', 'Verified', 'Rejected', 'Missing certificates'],
        rows.map(r => [
          r.societyName,
          r.tdsSection,
          rupees(r.claimedPaise),
          rupees(r.verifiedPaise),
          rupees(r.rejectedPaise),
          r.missingCertificates,
        ]),
      ),
    };
  }
  return { json: { financialYear: q.financialYear, quarter: q.quarter ?? null, ...range, rows } };
}
