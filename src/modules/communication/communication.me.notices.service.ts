import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { InboxItem, Notice, NoticeReceipt, Resident, Unit, sequelize } from '../../models';
import { addDays, now } from '../../lib/clock';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { placeholderFiles, societyPorts } from '../societies/societies.ports';
import { AUDIT, utilityLabel, ENTITY, ERR, RT, roomAdmin } from './communication.constants';
import { communicationPorts } from './communication.ports';

/**
 * Resident notices (8.18, 8.19) and their attachment URLs (8.17 `/me` variant). A notice is visible to a resident when it is `PUBLISHED` (or `EXPIRED`
 * within 30 days) and the caller has a receipt or the audience matches the caller's current flats (BR-16-4). `ROLES` notices are never on the board.
 * Receipts are written by the fan-out job (16.1); a live match creates one here (`relation` from the caller's link, not counted in `recipientCount`).
 */
const EXPIRED_VISIBLE_DAYS = 30;
const CANDIDATE_CAP = 2000;

export interface NoticeActionView {
  type: string;
  label: string;
  state: 'OPEN' | 'PAID' | 'CLOSED';
  refId?: number;
  url?: string;
  amountPaise?: number;
  receiptNo?: string;
}
export interface MyNoticeItem {
  id: number;
  title: string;
  excerpt: string;
  category: string;
  priority: string;
  kind: string;
  status: string;
  isPinned: boolean;
  requiresAck: boolean;
  acknowledgedAt: string | null;
  readAt: string | null;
  publishedAt: string | null;
  actions: NoticeActionView[];
  attachmentCount: number;
}

interface Mine {
  unitIds: number[];
  buildingByUnit: Map<number, number>;
  relationByUnit: Map<number, 'OWNER' | 'TENANT' | 'FAMILY'>;
}
async function mineOf(ctx: Ctx): Promise<Mine> {
  const links = ctx.unitLinks ?? [];
  const unitIds = [...new Set(links.map(l => l.unitId))];
  const units = unitIds.length
    ? await Unit.findAll({
        where: { id: unitIds, societyId: ctx.society!.id },
        attributes: ['id', 'buildingId'],
      })
    : [];
  const relationByUnit = new Map<number, 'OWNER' | 'TENANT' | 'FAMILY'>();
  for (const l of links) if (!relationByUnit.has(l.unitId)) relationByUnit.set(l.unitId, l.relation);
  return { unitIds, buildingByUnit: new Map(units.map(u => [u.id!, u.buildingId])), relationByUnit };
}

/** BR-16-4 live match: the unit that makes `n` reach the caller today, or null. ROLES never match here. */
function liveUnit(
  n: Pick<Notice, 'audienceType' | 'audienceRelation' | 'audienceIds'>,
  m: Mine,
): number | null {
  if (n.audienceType === 'ROLES') return null;
  const ids = n.audienceIds ?? [];
  for (const unitId of m.unitIds) {
    if (!m.buildingByUnit.has(unitId)) continue; // not an active unit of this society
    const rel = m.relationByUnit.get(unitId)!;
    const relationOk =
      n.audienceRelation === 'ANY' || (n.audienceRelation === 'OWNERS' ? rel === 'OWNER' : rel === 'TENANT');
    if (!relationOk) continue;
    if (n.audienceType === 'ALL') return unitId;
    if (n.audienceType === 'UNITS' && ids.includes(unitId)) return unitId;
    if (n.audienceType === 'BUILDINGS' && ids.includes(m.buildingByUnit.get(unitId)!)) return unitId;
  }
  return null;
}

const visibleStatus = (): WhereOptions => ({
  [Op.or]: [
    { status: 'PUBLISHED' },
    {
      status: 'EXPIRED',
      [Op.or]: [{ expiredAt: { [Op.gte]: addDays(now(), -EXPIRED_VISIBLE_DAYS) } }, { expiredAt: null }],
    },
  ],
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);
const excerptOf = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
};

interface ReceiptState {
  readAt: Date | null;
  acknowledgedAt: Date | null;
  has: boolean;
}
const minDate = (a: Date | null, b: Date | null): Date | null => (a && b ? (a < b ? a : b) : (a ?? b));

async function receiptStates(ctx: Ctx, noticeIds?: number[]): Promise<Map<number, ReceiptState>> {
  const rows = await NoticeReceipt.findAll({
    where: {
      societyId: ctx.society!.id,
      userId: ctx.user!.id,
      ...(noticeIds ? { noticeId: noticeIds } : {}),
    },
    attributes: ['noticeId', 'firstReadAt', 'acknowledgedAt'],
  });
  const out = new Map<number, ReceiptState>();
  for (const r of rows) {
    const cur = out.get(r.noticeId) ?? { readAt: null, acknowledgedAt: null, has: true };
    cur.readAt = minDate(cur.readAt, r.firstReadAt);
    cur.acknowledgedAt = minDate(cur.acknowledgedAt, r.acknowledgedAt);
    out.set(r.noticeId, cur);
  }
  return out;
}

/** BR-16-13 state of one action for the caller. A target that is no longer open shows "No longer open" (`CLOSED`). */
async function actionViews(ctx: Ctx, n: Notice, detail: boolean): Promise<NoticeActionView[]> {
  const out: NoticeActionView[] = [];
  const ports = communicationPorts();
  for (const a of n.actions ?? []) {
    const v: NoticeActionView = { type: a.type, label: a.label ?? defaultLabel(a.type), state: 'OPEN' };
    if (detail && a.refId !== undefined) v.refId = a.refId;
    if (detail && a.type === 'LINK' && a.url) v.url = a.url;
    if (a.type === 'PAY_COLLECTION' && a.refId !== undefined) {
      const c = await ports.collections.get(ctx.society!.id, a.refId).catch(() => null);
      v.state = c && c.status === 'PUBLISHED' ? 'OPEN' : 'CLOSED';
    } else if ((a.type === 'VOTE' || a.type === 'RSVP') && a.refId !== undefined) {
      v.state = (await ports.targets.isOpen(a.type, ctx.society!.id, a.refId).catch(() => false))
        ? 'OPEN'
        : 'CLOSED';
    }
    out.push(v);
  }
  return out;
}
const defaultLabel = (type: string): string =>
  ({ PAY_COLLECTION: 'Pay now', PAY_DUES: 'Pay dues', RSVP: 'RSVP', VOTE: 'Vote', LINK: 'Open link' })[
    type
  ] ?? 'Open';

async function itemOf(ctx: Ctx, n: Notice, st: ReceiptState | undefined): Promise<MyNoticeItem> {
  return {
    id: n.id,
    title: n.title,
    excerpt: excerptOf(n.bodyText ?? ''),
    category: n.category,
    priority: n.priority,
    kind: n.kind,
    status: n.status,
    isPinned: n.isPinned,
    requiresAck: n.requiresAck,
    acknowledgedAt: st?.acknowledgedAt ? st.acknowledgedAt.toISOString() : null,
    readAt: st?.readAt ? st.readAt.toISOString() : null,
    publishedAt: n.publishedAt ? n.publishedAt.toISOString() : null,
    actions: await actionViews(ctx, n, false),
    attachmentCount: n.attachmentCount,
  };
}

export interface ListQuery {
  category?: string;
  unread?: boolean;
  q?: string;
  page: number;
  limit: number;
}
export async function listMyNotices(ctx: Ctx, query: ListQuery) {
  const societyId = ctx.society!.id;
  const m = await mineOf(ctx);
  const states = await receiptStates(ctx);
  const where: WhereOptions = {
    [Op.and]: [
      { societyId, audienceType: { [Op.ne]: 'ROLES' } },
      visibleStatus(),
      query.category ? { category: query.category } : {},
      query.q
        ? {
            [Op.or]: [
              { title: { [Op.like]: `%${escapeLike(query.q)}%` } },
              { bodyText: { [Op.like]: `%${escapeLike(query.q)}%` } },
            ],
          }
        : {},
    ],
  };
  const candidates = await Notice.findAll({
    where,
    attributes: { exclude: ['body'] },
    order: [
      ['publishedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: CANDIDATE_CAP,
  });
  const seen = candidates.filter(n => states.has(n.id) || liveUnit(n, m) !== null);
  const shown = query.unread ? seen.filter(n => !states.get(n.id)?.readAt) : seen;
  const pending = (n: Notice) =>
    n.requiresAck && n.status === 'PUBLISHED' && !states.get(n.id)?.acknowledgedAt ? 1 : 0;
  const sorted = [...shown].sort(
    (a, b) =>
      Number(b.isPinned) - Number(a.isPinned) ||
      (b.pinnedAt?.getTime() ?? 0) - (a.pinnedAt?.getTime() ?? 0) ||
      pending(b) - pending(a) ||
      (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) ||
      b.id - a.id,
  );
  const total = sorted.length;
  const page = sorted.slice((query.page - 1) * query.limit, query.page * query.limit);
  const items = await Promise.all(page.map(n => itemOf(ctx, n, states.get(n.id))));
  return {
    items,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}

/** The notice as the caller may see it, plus the unit of a live match when there is no receipt. */
async function loadVisible(
  ctx: Ctx,
  id: number,
  o: { anyStatus?: boolean; t?: Transaction } = {},
): Promise<{ notice: Notice; liveUnitId: number | null; hasReceipt: boolean }> {
  const societyId = ctx.society!.id;
  const notice = await Notice.findOne({
    where: { id, societyId },
    transaction: o.t,
    lock: o.t ? o.t.LOCK.UPDATE : undefined,
  });
  const notFound = () => new NotFoundError(ERR.noticeNotFound, 'Notice not found');
  if (!notice) throw notFound();
  const hasReceipt =
    (await NoticeReceipt.count({
      where: { societyId, noticeId: id, userId: ctx.user!.id },
      transaction: o.t,
    })) > 0;
  if (!o.anyStatus) {
    const okStatus =
      notice.status === 'PUBLISHED' ||
      (notice.status === 'EXPIRED' &&
        (!notice.expiredAt || notice.expiredAt >= addDays(now(), -EXPIRED_VISIBLE_DAYS)));
    if (!okStatus) throw notFound();
  } else if (!['PUBLISHED', 'EXPIRED', 'RECALLED', 'ARCHIVED'].includes(notice.status)) throw notFound();
  if (notice.audienceType === 'ROLES' && !hasReceipt) throw notFound();
  const liveUnitId = hasReceipt ? null : liveUnit(notice, await mineOf(ctx));
  if (!hasReceipt && liveUnitId === null) throw notFound();
  return { notice, liveUnitId, hasReceipt };
}

async function ensureLiveReceipt(ctx: Ctx, n: Notice, unitId: number, t: Transaction): Promise<void> {
  const resident = await Resident.findOne({
    where: { societyId: ctx.society!.id, userId: ctx.user!.id },
    attributes: ['id'],
    transaction: t,
  });
  const rel = (ctx.unitLinks ?? []).find(l => l.unitId === unitId)?.relation ?? 'FAMILY';
  await NoticeReceipt.findOrCreate({
    where: { noticeId: n.id, recipientKey: `u:${ctx.user!.id}:${unitId}` },
    defaults: {
      societyId: ctx.society!.id,
      noticeId: n.id,
      recipientKey: `u:${ctx.user!.id}:${unitId}`,
      userId: ctx.user!.id,
      residentId: resident?.id ?? null,
      unitId,
      relation: rel,
    } as never,
    transaction: t,
  });
}

function attachmentsOf(n: Notice) {
  return communicationPorts()
    .files.list(n.id)
    .map(fileId => placeholderFiles.get(fileId))
    .filter(f => f && f.status === 'CLEAN' && f.societyId === n.societyId)
    .map(f => ({ fileId: f!.fileId, name: f!.name, sizeBytes: f!.content.length }));
}

/** 8.19 detail. Opening it records the read (receipts, notice counter, matching inbox item). */
export async function getMyNotice(ctx: Ctx, id: number) {
  const societyId = ctx.society!.id;
  const { notice: probe } = await loadVisible(ctx, id);
  let firstRead = false;
  await sequelize.transaction(async t => {
    const { notice, liveUnitId } = await loadVisible(ctx, id, { t });
    if (liveUnitId !== null) await ensureLiveReceipt(ctx, notice, liveUnitId, t);
    const receipts = await NoticeReceipt.findAll({
      where: { societyId, noticeId: id, userId: ctx.user!.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const at = now();
    firstRead = receipts.some(r => r.firstReadAt === null);
    for (const r of receipts) {
      r.firstReadAt = r.firstReadAt ?? at;
      r.readCount = Math.min(65_535, r.readCount + 1);
      await r.save({ transaction: t });
    }
    if (firstRead) await Notice.increment('readCount', { by: 1, where: { id }, transaction: t });
  });
  await markInboxRead(ctx, id);
  const notice = (await Notice.findByPk(probe.id))!;
  const st = (await receiptStates(ctx, [id])).get(id);
  const item = await itemOf(ctx, notice, st);
  return {
    ...item,
    body: notice.body,
    locale: notice.locale,
    revisionNo: notice.revisionNo,
    attachments: attachmentsOf(notice),
    utility: notice.utilityType
      ? {
          type: notice.utilityType,
          label: utilityLabel(notice.utilityType),
          startsAt: notice.outageStartsAt ? notice.outageStartsAt.toISOString() : null,
          endsAt: notice.outageEndsAt ? notice.outageEndsAt.toISOString() : null,
          restoredAt: notice.restoredAt ? notice.restoredAt.toISOString() : null,
        }
      : null,
    actions: await actionViews(ctx, notice, true),
  };
}

/** Marks the caller's inbox item of this notice read (deep link `/notices/<id>`) and tells the open tabs. */
async function markInboxRead(ctx: Ctx, noticeId: number): Promise<void> {
  const where = {
    userId: ctx.user!.id,
    readAt: null,
    [Op.or]: [{ sourceType: ENTITY.notice, sourceId: noticeId }, { deepLink: `/notices/${noticeId}` }],
  };
  const rows = await InboxItem.findAll({ where, attributes: ['id'] });
  if (!rows.length) return;
  await InboxItem.update({ readAt: now() }, { where: { id: rows.map(r => r.id), readAt: null } });
  const unread = await InboxItem.count({
    where: {
      userId: ctx.user!.id,
      readAt: null,
      [Op.or]: [{ scope: 'USER' }, { scope: 'SOCIETY', societyId: ctx.society!.id }],
    },
  });
  emitToUser(ctx.user!.id, RT.notificationRead, { ids: rows.map(r => r.id), unreadCount: unread });
}

/**
 * 8.18: acknowledges for the caller (BR-16-11, immutable). Used by `POST /me/notices/:id/acknowledge`; part 16.1 mounts the admin-app route
 * `POST /notices/:id/acknowledge` (role recipients) on the same function.
 */
export async function acknowledgeNotice(ctx: Ctx, id: number, body: { appVersion?: string } = {}) {
  void body;
  const userId = ctx.user!.id;
  const societyId = ctx.society!.id;
  const out = await sequelize.transaction(async t => {
    const { notice, liveUnitId } = await loadVisible(ctx, id, { anyStatus: true, t });
    if (notice.status !== 'PUBLISHED')
      throw new ConflictError(ERR.invalidState, 'This notice can no longer be acknowledged');
    if (!notice.requiresAck)
      throw new UnprocessableError(ERR.noticeAckNotRequired, 'This notice does not need an acknowledgement');
    if (liveUnitId !== null) await ensureLiveReceipt(ctx, notice, liveUnitId, t);
    const receipts = await NoticeReceipt.findAll({
      where: { societyId, noticeId: id, userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const open = receipts.filter(r => r.acknowledgedAt === null);
    const at = now();
    if (open.length) {
      const ip = ctx.ip ? ctx.ip.slice(0, 45) : null;
      const ua = ctx.userAgent ? ctx.userAgent.slice(0, 255) : null;
      for (const r of open) {
        r.acknowledgedAt = at;
        r.ackRevisionNo = notice.revisionNo;
        r.ackIp = ip;
        r.ackUserAgent = ua;
        r.firstReadAt = r.firstReadAt ?? at;
        await r.save({ transaction: t });
      }
      await Notice.increment('ackCount', { by: open.length, where: { id }, transaction: t });
      await audit(
        ctx,
        {
          action: AUDIT.noticeAcknowledged,
          entityType: ENTITY.notice,
          entityId: id,
          societyId,
          after: { revisionNo: notice.revisionNo, receipts: open.length },
        },
        t,
      );
    }
    const first = receipts
      .map(r => r.acknowledgedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0]!;
    return { notice, acknowledgedAt: first, changed: open.length };
  });
  if (out.changed) {
    const fresh = await Notice.findByPk(id, { attributes: ['id', 'ackCount', 'readCount'] });
    emitToRoom(roomAdmin(societyId), RT.noticeUpdated, {
      id,
      ackCount: fresh?.ackCount ?? 0,
      readCount: fresh?.readCount ?? 0,
    });
  }
  return {
    noticeId: id,
    acknowledgedAt: out.acknowledgedAt.toISOString(),
    revisionNo: out.notice.revisionNo,
  };
}

/** 8.17 `/me` variant: the notice must be visible to the caller and the file linked to it. */
export async function myNoticeFileUrl(
  ctx: Ctx,
  id: number,
  fileId: number,
  disposition: 'inline' | 'attachment',
) {
  const { notice } = await loadVisible(ctx, id);
  const linked = communicationPorts().files.list(notice.id).includes(fileId);
  const f = placeholderFiles.get(fileId);
  if (!linked || !f || f.societyId !== notice.societyId)
    throw new NotFoundError(ERR.fileNotFound, 'File not found');
  if (f.status === 'DELETED') throw new AppError(410, 'FILE_DELETED', 'This file was removed');
  if (f.status !== 'CLEAN') throw new AppError(409, ERR.fileNotReady, 'This file is not ready yet');
  const link = await societyPorts().files.downloadUrl(fileId, 5);
  return { url: link.url, expiresAt: link.expiresAt.toISOString(), disposition };
}
