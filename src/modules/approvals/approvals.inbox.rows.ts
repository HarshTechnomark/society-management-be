import { Op, type WhereOptions } from 'sequelize';
import { User, type ApprovalAction, type ApprovalRequest } from '../../models';
import { nowMs } from '../../lib/clock';
import { typeMeta } from './approvals.catalogue';
import type { Evaluated } from './approvals.inbox.eval';
import { REASON_TEXT } from './approvals.inbox.eval';

const n = (v: unknown): number => Number(v);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Display names of users, one query. */
export async function namesOf(ids: Iterable<number | null | undefined>): Promise<Map<number, string | null>> {
  const set = [...new Set([...ids].filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string | null>();
  if (!set.length) return map;
  const rows = await User.findAll({ where: { id: set }, attributes: ['id', 'name'] });
  for (const r of rows) map.set(n(r.id), r.name);
  return map;
}

/** Start of a calendar day (`YYYY-MM-DD`) in an IANA time zone, as a UTC instant. */
export function zonedStart(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (ms: number): number => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(new Date(ms));
    const g = (t: string) => Number(p.find(x => x.type === t)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

export interface FilterInput {
  type?: string;
  overdue?: boolean;
  q?: string;
  from?: string;
  to?: string;
}
/** SQL conditions shared by the list routes (8.1, 8.3): type, overdue, text, created range in society time. */
export function filterWhere(f: FilterInput, tz: string): WhereOptions[] {
  const and: WhereOptions[] = [];
  if (f.type) and.push({ type: f.type });
  if (f.overdue) and.push({ status: 'PENDING', dueAt: { [Op.lt]: new Date(nowMs()) } });
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    and.push({ [Op.or]: [{ title: { [Op.like]: like } }, { summary: { [Op.like]: like } }] });
  }
  if (f.from) and.push({ createdAt: { [Op.gte]: zonedStart(f.from, tz) } });
  if (f.to) {
    const next = new Date(`${f.to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    and.push({ createdAt: { [Op.lt]: zonedStart(next.toISOString().slice(0, 10), tz) } });
  }
  return and;
}

export const orderOf = (sortBy: string, sortOrder?: string): [string, string][] => {
  const dir = (sortOrder ?? 'desc').toUpperCase();
  return [
    [sortBy, dir],
    ['id', dir],
  ];
};

/** The row of 8.1 and 8.3. */
export function listRow(
  req: ApprovalRequest,
  ev: Evaluated | undefined,
  names: Map<number, string | null>,
  bulkBelowPaise: number,
) {
  const meta = typeMeta(req.type);
  const open = req.status === 'PENDING';
  const due = req.dueAt;
  const my = ev?.my;
  const bulkEligible =
    open && Boolean(req.allowBulk) && !req.stepUpRequired && n(req.amountPaise) < bulkBelowPaise;
  return {
    id: n(req.id),
    type: req.type,
    typeLabel: meta?.label ?? req.type,
    title: req.title,
    summary: req.summary,
    amountPaise: n(req.amountPaise),
    status: req.status,
    currentStepNo: n(req.currentStepNo),
    totalSteps: n(req.totalSteps),
    currentStepName: ev?.step.currentStepName ?? null,
    approvalsNeeded: ev?.step.approvalsNeeded ?? 0,
    approvalsGiven: ev?.step.approvalsGiven ?? 0,
    round: n(req.round),
    requester: { userId: n(req.requesterUserId), name: names.get(n(req.requesterUserId)) ?? null },
    createdAt: iso(req.createdAt),
    dueAt: iso(due),
    isOverdue: open && due !== null && due.getTime() < nowMs(),
    escalated: req.escalatedAt !== null,
    stepUpRequired: Boolean(req.stepUpRequired),
    bulkEligible,
    hasEligibleApprover: Boolean(req.hasEligibleApprover),
    stuckAt: iso(req.stuckAt),
    myAction: {
      canAct: my?.canAct ?? false,
      onBehalfOf: my?.onBehalfOf ?? null,
      reason: my?.reason ?? null,
      ...(my?.reason ? { reasonText: REASON_TEXT[my.reason] } : {}),
    },
    version: n(req.version),
  };
}

/** One history line (8.5, 8.6). */
export function actionLine(a: ApprovalAction, names: Map<number, string | null>) {
  return {
    action: a.action,
    round: n(a.round),
    actorName: a.actorName,
    ...(a.onBehalfOfUserId !== null ? { onBehalfOfName: names.get(n(a.onBehalfOfUserId)) ?? null } : {}),
    actorRoleKey: a.actorRoleKey,
    stepNo: a.stepNo === null ? null : n(a.stepNo),
    comment: a.comment,
    at: a.createdAt.toISOString(),
  };
}

export const actionNameIds = (rows: ApprovalAction[]): number[] =>
  rows.filter(a => a.onBehalfOfUserId !== null).map(a => n(a.onBehalfOfUserId));
