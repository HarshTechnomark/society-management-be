import { Op, type WhereOptions } from 'sequelize';
import { ApprovalRequest, sequelize } from '../../models';
import { nowMs } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { APPROVAL_TYPES, CATALOGUE } from './approvals.catalogue';
import {
  DEFAULT_BULK_BELOW_PAISE,
  DEFAULT_STEP_UP_ABOVE_PAISE,
  LIMITS,
  OPEN_STATUSES,
  PERM,
  SETTING,
} from './approvals.constants';
import { COUNT_TTL_SECONDS, countKey, readEpoch } from './approvals.inbox.epoch';
import { loadActions, stepInfo, Viewer, type Evaluated } from './approvals.inbox.eval';
import { filterWhere, listRow, namesOf, orderOf } from './approvals.inbox.rows';
import type { ListQuery, SubmittedQuery } from './approvals.inbox.validation';
import { getHandlers } from './approvals.registry';

const n = (v: unknown): number => Number(v);

export interface Page<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  meta: { truncated: boolean };
}
const pageOf = <T>(data: T[], page: number, limit: number, total: number, truncated = false): Page<T> => ({
  data,
  pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  meta: { truncated },
});

async function readSetting(societyId: number, key: string, fallback: number): Promise<number> {
  try {
    return Number(await settings.get(societyId, key)) || fallback;
  } catch {
    return fallback;
  }
}
export const bulkBelowOf = (societyId: number): Promise<number> =>
  readSetting(societyId, SETTING.bulkApproveBelowPaise, DEFAULT_BULK_BELOW_PAISE);
export const stepUpAboveOf = (societyId: number): Promise<number> =>
  readSetting(societyId, SETTING.stepUpAbovePaise, DEFAULT_STEP_UP_ABOVE_PAISE);

const ctxIds = (ctx: Ctx) => ({ societyId: ctx.society!.id, userId: ctx.user!.id });
const tzOf = (ctx: Ctx): string => ctx.society?.timezone ?? 'Asia/Kolkata';

/** Open requests of the society, oldest first, at most `LIMITS.inboxMax` (8.1). */
async function loadOpen(societyId: number, extra: WhereOptions[], statuses: readonly string[]) {
  const where: WhereOptions = { [Op.and]: [{ societyId, status: [...statuses] }, ...extra] };
  const total = await ApprovalRequest.count({ where });
  const rows = await ApprovalRequest.findAll({ where, order: [['id', 'ASC']], limit: LIMITS.inboxMax });
  if (total > LIMITS.inboxMax)
    logger.warn({ societyId, total }, 'approvals inbox truncated at the evaluation limit');
  return { rows, truncated: total > LIMITS.inboxMax };
}

const cmp = (a: number | null, b: number | null, asc: boolean): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return asc ? a - b : b - a;
};

/** 8.1: FOR_ME and ALL_PENDING are evaluated in the service; DECIDED uses SQL for visibility. */
export async function listInbox(ctx: Ctx, q: ListQuery): Promise<Page<ReturnType<typeof listRow>>> {
  const { societyId, userId } = ctxIds(ctx);
  const viewer = await Viewer.load(societyId, userId);
  const bulkBelow = await bulkBelowOf(societyId);
  const asc = (q.sortOrder ?? 'desc') === 'asc';
  const filters = filterWhere(q, tzOf(ctx));
  if (q.view === 'DECIDED') return listDecided(viewer, q, filters, bulkBelow);

  const statuses = q.view === 'FOR_ME' ? ['PENDING'] : OPEN_STATUSES;
  const { rows, truncated } = await loadOpen(societyId, filters, statuses);
  const actions = await loadActions(rows.map(r => n(r.id)));
  const ev = await viewer.evaluate(rows, actions);
  const kept = rows.filter(r => {
    const e = ev.get(n(r.id))!;
    return q.view === 'FOR_ME' ? e.my.canAct : e.visible;
  });
  const key = (r: ApprovalRequest): number | null =>
    q.sortBy === 'amountPaise'
      ? n(r.amountPaise)
      : q.sortBy === 'dueAt'
        ? (r.dueAt?.getTime() ?? null)
        : r.createdAt.getTime();
  kept.sort((a, b) => cmp(key(a), key(b), asc) || (asc ? n(a.id) - n(b.id) : n(b.id) - n(a.id)));
  const slice = kept.slice((q.page - 1) * q.limit, q.page * q.limit);
  const names = await namesOf([
    ...slice.map(r => n(r.requesterUserId)),
    ...slice.flatMap(r => {
      const e = ev.get(n(r.id));
      return e?.my.onBehalfOf ? [e.my.onBehalfOf.userId] : [];
    }),
  ]);
  const data = slice.map(r => withOnBehalfName(listRow(r, ev.get(n(r.id)), names, bulkBelow), names));
  return pageOf(data, q.page, q.limit, kept.length, truncated);
}

/** `onBehalfOf` carries the delegator's name next to the id. */
function withOnBehalfName<T extends { myAction: { onBehalfOf: { userId: number } | null } }>(
  row: T,
  names: Map<number, string | null>,
): T {
  const o = row.myAction.onBehalfOf;
  if (!o) return row;
  return { ...row, myAction: { ...row.myAction, onBehalfOf: { ...o, name: names.get(o.userId) ?? null } } };
}

/** SQL visibility (BR-14-26) for closed requests: view or approve permission of the type, requester, or acted. */
export function closedVisibility(viewer: Viewer): WhereOptions {
  const types = APPROVAL_TYPES.filter(t => {
    const m = CATALOGUE[t]!;
    return viewer.has(m.viewPermission) || viewer.has(m.approvePermission);
  });
  const acted = sequelize.literal(
    `\`ApprovalRequest\`.\`id\` IN (SELECT requestId FROM approval_actions WHERE societyId = ${Number(viewer.societyId)} AND (actorUserId = ${Number(viewer.userId)} OR onBehalfOfUserId = ${Number(viewer.userId)}))`,
  );
  return {
    [Op.or]: [
      ...(types.length ? [{ type: types }] : []),
      { requesterUserId: viewer.userId },
      acted as unknown as WhereOptions,
    ],
  };
}

async function listDecided(
  viewer: Viewer,
  q: ListQuery,
  filters: WhereOptions[],
  bulkBelow: number,
): Promise<Page<ReturnType<typeof listRow>>> {
  const statuses = q.status ? [q.status] : ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'];
  const where: WhereOptions = {
    [Op.and]: [{ societyId: viewer.societyId, status: statuses }, closedVisibility(viewer), ...filters],
  };
  const total = await ApprovalRequest.count({ where });
  const rows = await ApprovalRequest.findAll({
    where,
    order: orderOf(q.sortBy, q.sortOrder) as never,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return rowsToPage(rows, total, q.page, q.limit, bulkBelow);
}

async function rowsToPage(
  rows: ApprovalRequest[],
  total: number,
  page: number,
  limit: number,
  bulkBelow: number,
) {
  const actions = await loadActions(rows.map(r => n(r.id)));
  const names = await namesOf(rows.map(r => n(r.requesterUserId)));
  const none: Evaluated = {
    visible: true,
    my: { canAct: false, onBehalfOf: null, options: [], reason: null },
    step: { currentStepName: null, approvalsNeeded: 0, approvalsGiven: 0 },
  };
  const data = rows.map(r => {
    return listRow(r, { ...none, step: stepInfo(r, actions.get(n(r.id)) ?? []) }, names, bulkBelow);
  });
  return pageOf(data, page, limit, total);
}

/** 8.3: the caller's own submissions, any status. */
export async function listSubmitted(ctx: Ctx, q: SubmittedQuery): Promise<Page<ReturnType<typeof listRow>>> {
  const { societyId, userId } = ctxIds(ctx);
  const where: WhereOptions = {
    [Op.and]: [
      { societyId, requesterUserId: userId, ...(q.status ? { status: q.status } : {}) },
      ...filterWhere(q, tzOf(ctx)),
    ],
  };
  const total = await ApprovalRequest.count({ where });
  const rows = await ApprovalRequest.findAll({
    where,
    order: orderOf(q.sortBy, q.sortOrder) as never,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return rowsToPage(rows, total, q.page, q.limit, await bulkBelowOf(societyId));
}

export interface Counts {
  forMe: number;
  forMeByType: Record<string, number>;
  overdueForMe: number;
  allPending: number;
  submittedOpen: number;
  stuck: number;
}

/** 8.2: cached per user for 60 seconds under the society's epoch (bumped by every request change). */
export async function inboxCounts(societyId: number, userId: number): Promise<Counts> {
  const store = kv();
  const epoch = await readEpoch(societyId);
  const key = countKey(societyId, userId, epoch);
  const hit = await store.cacheGet(key);
  if (hit) return JSON.parse(hit) as Counts;
  const counts = await computeCounts(societyId, userId);
  await store.cacheSet(key, JSON.stringify(counts), COUNT_TTL_SECONDS);
  return counts;
}

export async function computeCounts(societyId: number, userId: number): Promise<Counts> {
  const viewer = await Viewer.load(societyId, userId);
  const { rows } = await loadOpen(societyId, [], OPEN_STATUSES);
  const ev = await viewer.evaluate(rows, await loadActions(rows.map(r => n(r.id))));
  const forMeByType: Record<string, number> = {};
  let forMe = 0;
  let overdueForMe = 0;
  let allPending = 0;
  for (const r of rows) {
    const e = ev.get(n(r.id))!;
    if (e.visible) allPending += 1;
    if (!e.my.canAct) continue;
    forMe += 1;
    forMeByType[r.type] = (forMeByType[r.type] ?? 0) + 1;
    if (r.dueAt && r.dueAt.getTime() < nowMs()) overdueForMe += 1;
  }
  const submittedOpen = await ApprovalRequest.count({
    where: { societyId, requesterUserId: userId, status: [...OPEN_STATUSES] },
  });
  const sees = viewer.roleKey === 'chairman' || viewer.has(PERM.rulesEdit);
  const stuck = sees
    ? await ApprovalRequest.count({ where: { societyId, status: 'PENDING', hasEligibleApprover: false } })
    : 0;
  return { forMe, forMeByType, overdueForMe, allPending, submittedOpen, stuck };
}

const ICONS: Record<string, string> = {
  EXPENSE: 'receipt',
  PAYMENT_REFUND: 'undo',
  OFFLINE_PAYMENT: 'banknote',
  INVOICE_CANCEL: 'file-x',
  BILLING_RUN_PUBLISH: 'file-text',
  CREDIT_NOTE: 'file-minus',
  WRITE_OFF: 'eraser',
  COLLECTION_PUBLISH: 'hand-coins',
  JOIN_REQUEST: 'user-plus',
  MOVE_IN: 'log-in',
  MOVE_OUT: 'log-out',
  RENOVATION_PERMIT: 'hammer',
  OWNERSHIP_TRANSFER: 'key',
  PURCHASE_ORDER: 'shopping-cart',
  VENDOR_BILL: 'file-spreadsheet',
  NOTICE_PUBLISH: 'megaphone',
  BOOKING: 'calendar',
  SUBSCRIPTION_CANCEL: 'x-circle',
  DEPOSIT_REFUND: 'wallet',
  FINE_WAIVER: 'gavel',
  MANUAL_JOURNAL: 'book-open',
  FUND_TRANSFER: 'arrow-left-right',
  PERIOD_UNLOCK: 'lock-open',
  BILLING_RULE_CHANGE: 'sliders',
  LATE_FEE_POLICY_CHANGE: 'clock',
};

/** 8.4: the catalogue for the UI. */
export function listTypes() {
  return APPROVAL_TYPES.map(t => {
    const m = CATALOGUE[t]!;
    return {
      type: m.type,
      label: m.label,
      icon: ICONS[t] ?? 'check-circle',
      ownerModule: m.owner,
      entityType: m.entityType,
      isMoney: m.isMoney,
      residentVisible: m.residentVisible,
      allowBulk: m.allowBulk,
      allowsChanges: m.allowsChanges,
      approvePermission: m.approvePermission,
      cancellable: Boolean(getHandlers(t)?.onCancelled),
      alwaysStepUp: m.alwaysStepUp,
    };
  });
}
