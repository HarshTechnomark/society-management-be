import { Op, QueryTypes } from 'sequelize';
import { Notice, NoticeReceipt, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { AppError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ENT, ENTITY, ERR, PERM } from './communication.constants';
import { resolveAudience } from './communication.audience';
import { maskMobile } from './communication.crypto';
import { needFeature } from './communication.composer';
import {
  emitNoticeUpdated,
  findNotice,
  istDayEnd,
  istDayStart,
  n,
  notFound,
  societyIdOf,
} from './communication.notices.shared';
import { communicationPorts } from './communication.ports';
import { societyPorts } from '../societies/societies.ports';

/** Receipts of a notice: summary and list (8.15), CSV (8.16), attachment URL (8.17) and acknowledge (8.18). */
export interface ReceiptQuery {
  filter: 'ALL' | 'NOT_READ' | 'NOT_ACKED' | 'ACKED' | 'UNREACHED';
  buildingId?: number;
  q?: string;
  sortBy: 'unitLabel' | 'firstReadAt' | 'acknowledgedAt';
  sortOrder: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

async function assertHasReceipts(ctx: Ctx, id: number): Promise<Notice> {
  const notice = await findNotice(ctx, id);
  if (!['PUBLISHED', 'EXPIRED', 'RECALLED', 'ARCHIVED'].includes(notice.status))
    throw new AppError(409, ERR.invalidState, 'This notice has no receipts yet');
  return notice;
}

const FROM = `FROM notice_receipts r
  LEFT JOIN units u ON u.id = r.unitId
  LEFT JOIN buildings b ON b.id = u.buildingId
  LEFT JOIN users usr ON usr.id = r.userId
  LEFT JOIN residents res ON res.id = r.residentId`;

function where(
  noticeId: number,
  societyId: number,
  q: ReceiptQuery,
): { sql: string; rep: Record<string, unknown> } {
  const parts = ['r.noticeId = :noticeId', 'r.societyId = :societyId'];
  const rep: Record<string, unknown> = { noticeId, societyId };
  if (q.filter === 'NOT_READ') parts.push('r.firstReadAt IS NULL');
  if (q.filter === 'NOT_ACKED') parts.push('r.acknowledgedAt IS NULL');
  if (q.filter === 'ACKED') parts.push('r.acknowledgedAt IS NOT NULL');
  if (q.filter === 'UNREACHED') parts.push('(r.userId IS NULL OR r.reachedAt IS NULL)');
  if (q.buildingId) {
    parts.push('u.buildingId = :buildingId');
    rep.buildingId = q.buildingId;
  }
  if (q.q) {
    parts.push('(u.label LIKE :like OR COALESCE(res.name, usr.name) LIKE :like)');
    rep.like = `%${q.q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
  }
  return { sql: parts.join(' AND '), rep };
}

const ORDER: Record<ReceiptQuery['sortBy'], string> = {
  unitLabel: 'b.sortOrder, b.code, u.floor, u.positionOnFloor, u.label, r.id',
  firstReadAt: 'r.firstReadAt',
  acknowledgedAt: 'r.acknowledgedAt',
};
const orderSql = (q: ReceiptQuery): string => {
  const dir = q.sortOrder === 'desc' ? 'DESC' : 'ASC';
  if (q.sortBy === 'unitLabel')
    return ORDER.unitLabel
      .split(',')
      .map(c => `${c.trim()} ${dir}`)
      .join(', ');
  return `${ORDER[q.sortBy]} ${dir}, r.id ASC`;
};

interface Row {
  receiptId: number;
  unitId: number | null;
  unitLabel: string | null;
  buildingCode: string | null;
  name: string | null;
  relation: string | null;
  mobile: string | null;
  reachedVia: string | null;
  firstReadAt: Date | null;
  acknowledgedAt: Date | null;
  remindersSent: number;
}
const SELECT = `SELECT r.id AS receiptId, r.unitId, u.label AS unitLabel, b.code AS buildingCode,
  COALESCE(res.name, usr.name) AS name, r.relation, COALESCE(res.mobile, usr.mobile) AS mobile, r.reachedVia,
  r.firstReadAt, r.acknowledgedAt, r.remindersSent`;

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
const shape = (ctx: Ctx, r: Row) => ({
  receiptId: n(r.receiptId),
  unitId: r.unitId === null ? null : n(r.unitId),
  unitLabel: r.unitLabel,
  name: r.name,
  relation: r.relation,
  mobile: r.mobile ? (ctx.permissions?.has(PERM.contactsView) ? r.mobile : maskMobile(r.mobile)) : null,
  reachedVia: r.reachedVia,
  firstReadAt: iso(r.firstReadAt),
  acknowledgedAt: iso(r.acknowledgedAt),
  remindersSent: n(r.remindersSent),
});

async function summary(noticeId: number, societyId: number) {
  const rep = { noticeId, societyId };
  const [t] = await sequelize.query<Record<string, string | null>>(
    `SELECT COUNT(*) AS recipients, COUNT(DISTINCT unitId) AS units, SUM(reachedAt IS NOT NULL) AS reached,
       SUM(firstReadAt IS NOT NULL) AS readN, SUM(acknowledgedAt IS NOT NULL) AS acked,
       COUNT(DISTINCT CASE WHEN acknowledgedAt IS NOT NULL THEN unitId END) AS unitsAcked,
       SUM(userId IS NOT NULL AND reachedAt IS NOT NULL) AS inApp
     FROM notice_receipts WHERE noticeId = :noticeId AND societyId = :societyId`,
    { replacements: rep, type: QueryTypes.SELECT },
  );
  const byBuilding = await sequelize.query<Record<string, unknown>>(
    `SELECT b.id AS buildingId, b.code AS code, COUNT(DISTINCT r.unitId) AS units,
       COUNT(DISTINCT CASE WHEN r.firstReadAt IS NOT NULL THEN r.unitId END) AS unitsRead
     FROM notice_receipts r JOIN units u ON u.id = r.unitId JOIN buildings b ON b.id = u.buildingId
     WHERE r.noticeId = :noticeId AND r.societyId = :societyId GROUP BY b.id, b.code ORDER BY b.sortOrder, b.code`,
    { replacements: rep, type: QueryTypes.SELECT },
  );
  const channels = await sequelize.query<{ channel: string; c: string }>(
    `SELECT channel, COUNT(*) AS c FROM notifications
     WHERE societyId = :societyId AND sourceType = 'notice' AND sourceId = :noticeId
       AND status IN ('SENT','DELIVERED','READ') GROUP BY channel`,
    { replacements: rep, type: QueryTypes.SELECT },
  );
  const byChannel: Record<string, number> = { IN_APP: n(t?.inApp), PUSH: 0, SMS: 0, WHATSAPP: 0, EMAIL: 0 };
  for (const c of channels) byChannel[c.channel] = n(c.c);
  return {
    recipients: n(t?.recipients),
    units: n(t?.units),
    reached: n(t?.reached),
    read: n(t?.readN),
    acknowledged: n(t?.acked),
    unitsAcknowledged: n(t?.unitsAcked),
    byBuilding: byBuilding.map(b => ({
      buildingId: n(b.buildingId),
      code: String(b.code),
      units: n(b.units),
      unitsRead: n(b.unitsRead),
    })),
    byChannel,
  };
}

export async function listReceipts(ctx: Ctx, id: number, q: ReceiptQuery & { page: number; limit: number }) {
  const societyId = societyIdOf(ctx);
  const notice = await assertHasReceipts(ctx, id);
  if (q.filter === 'UNREACHED') await needFeature(ctx, ENT.unreachedFollowUp);
  const w = where(n(notice.id), societyId, q);
  const [{ c }] = await sequelize.query<{ c: string }>(`SELECT COUNT(*) AS c ${FROM} WHERE ${w.sql}`, {
    replacements: w.rep,
    type: QueryTypes.SELECT,
  });
  const rows = await sequelize.query<Row>(
    `${SELECT} ${FROM} WHERE ${w.sql} ORDER BY ${orderSql(q)} LIMIT :limit OFFSET :offset`,
    { replacements: { ...w.rep, limit: q.limit, offset: (q.page - 1) * q.limit }, type: QueryTypes.SELECT },
  );
  return {
    data: { summary: await summary(n(notice.id), societyId), items: rows.map(r => shape(ctx, r)) },
    pagination: pageMeta(q.page, q.limit, n(c)),
  };
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const EXPORT_MAX_ROWS = 20_000;

export async function exportReceipts(
  ctx: Ctx,
  id: number,
  q: ReceiptQuery,
): Promise<{ csv: string; filename: string; rows: number }> {
  const societyId = societyIdOf(ctx);
  const notice = await assertHasReceipts(ctx, id);
  if (q.filter === 'UNREACHED') await needFeature(ctx, ENT.unreachedFollowUp);
  const w = where(n(notice.id), societyId, q);
  const rows = await sequelize.query<Row>(
    `${SELECT} ${FROM} WHERE ${w.sql} ORDER BY ${orderSql(q)} LIMIT ${EXPORT_MAX_ROWS}`,
    { replacements: w.rep, type: QueryTypes.SELECT },
  );
  const lines = [
    [
      'Flat',
      'Building',
      'Name',
      'Relation',
      'Mobile',
      'Reached via',
      'Read at',
      'Acknowledged at',
      'Reminders',
    ]
      .map(csvCell)
      .join(','),
    ...rows.map(r => {
      const s = shape(ctx, r);
      return [
        s.unitLabel,
        r.buildingCode,
        s.name,
        s.relation,
        s.mobile,
        s.reachedVia,
        r.firstReadAt,
        r.acknowledgedAt,
        s.remindersSent,
      ]
        .map(csvCell)
        .join(',');
    }),
  ];
  await sequelize.transaction(t =>
    audit(
      ctx,
      {
        action: AUDIT.receiptsExported,
        entityType: ENTITY.notice,
        entityId: n(notice.id),
        societyId,
        after: { rows: rows.length, filter: q.filter },
      },
      t,
    ),
  );
  return {
    csv: `${lines.join('\r\n')}\r\n`,
    filename: `notice-${String(n(notice.id)).padStart(6, '0')}-receipts.csv`,
    rows: rows.length,
  };
}

// ------------------------------------------------------------------ attachment URL (8.17)
export async function noticeFileUrl(
  ctx: Ctx,
  id: number,
  fileId: number,
  disposition: 'inline' | 'attachment',
  visible?: (notice: Notice) => Promise<boolean>,
): Promise<{ url: string; expiresAt: string }> {
  const societyId = societyIdOf(ctx);
  const notice = await findNotice(ctx, id);
  if (visible && !(await visible(notice))) throw notFound();
  const ports = communicationPorts().files;
  if (!ports.list(n(notice.id)).includes(fileId)) throw new AppError(404, ERR.fileNotFound, 'File not found');
  const f = await ports.describe(societyId, fileId);
  if (!f) throw new AppError(404, ERR.fileNotFound, 'File not found');
  if (f.status === 'INFECTED')
    throw new UnprocessableError(ERR.fileInfected, 'This file failed the virus scan');
  if (f.status !== 'CLEAN') throw new AppError(409, ERR.fileNotReady, 'This file is not ready yet');
  const r = await societyPorts().files.downloadUrl(fileId, 5);
  const url =
    disposition === 'attachment' ? `${r.url}${r.url.includes('?') ? '&' : '?'}disposition=attachment` : r.url;
  return { url, expiresAt: r.expiresAt.toISOString() };
}

// ------------------------------------------------------------------ acknowledge (8.18)
const key = (userId: number, unitId: number | null): string => `u:${userId}:${unitId ?? 0}`;

/**
 * 8.18: the caller must see the notice (a receipt, or a live match: then receipts are created first, not counted in `recipientCount`).
 * Idempotent: an already acknowledged notice returns the existing time.
 */
export async function acknowledgeNotice(
  ctx: Ctx,
  id: number,
  _body: { appVersion?: string } = {},
): Promise<{ noticeId: number; acknowledgedAt: string; revisionNo: number }> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user?.id;
  if (!userId) throw notFound();
  const at = now();
  return sequelize.transaction(async t => {
    const notice = await Notice.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!notice) throw notFound();
    let mine = await NoticeReceipt.findAll({ where: { noticeId: id, userId }, transaction: t });
    if (!mine.length) {
      const resolved = await resolveAudience(societyId, {
        type: notice.audienceType,
        relation: notice.audienceRelation,
        ids: notice.audienceIds ?? undefined,
        roleKeys: notice.audienceRoleKeys ?? undefined,
      });
      const matches = resolved.people.filter(p => p.userId === userId);
      if (!matches.length || notice.status === 'DRAFT' || notice.status === 'PENDING_APPROVAL')
        throw notFound();
      for (const p of matches)
        await NoticeReceipt.findOrCreate({
          where: { noticeId: id, recipientKey: key(userId, p.unitId) },
          defaults: {
            societyId,
            noticeId: id,
            recipientKey: key(userId, p.unitId),
            userId,
            residentId: p.residentId,
            unitId: p.unitId,
            relation: p.relation,
            createdBy: userId,
          } as never,
          transaction: t,
        });
      mine = await NoticeReceipt.findAll({ where: { noticeId: id, userId }, transaction: t });
    }
    if (notice.status !== 'PUBLISHED')
      throw new AppError(409, ERR.invalidState, 'This notice is not published');
    if (!notice.requiresAck)
      throw new UnprocessableError(ERR.noticeAckNotRequired, 'This notice does not need acknowledgement');
    const done = mine.find(r => r.acknowledgedAt);
    if (done)
      return {
        noticeId: id,
        acknowledgedAt: done.acknowledgedAt!.toISOString(),
        revisionNo: n(done.ackRevisionNo ?? notice.revisionNo),
      };
    const [changed] = await NoticeReceipt.update(
      {
        acknowledgedAt: at,
        ackRevisionNo: n(notice.revisionNo),
        ackIp: ctx.ip ? ctx.ip.slice(0, 45) : null,
        ackUserAgent: ctx.userAgent ? ctx.userAgent.slice(0, 255) : null,
        updatedBy: userId,
      } as never,
      { where: { noticeId: id, userId, acknowledgedAt: { [Op.is]: null } }, transaction: t },
    );
    await notice.update({ ackCount: n(notice.ackCount) + changed } as never, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.noticeAcknowledged,
        entityType: ENTITY.notice,
        entityId: id,
        societyId,
        after: { revisionNo: n(notice.revisionNo) },
      },
      t,
    );
    t.afterCommit(() => emitNoticeUpdated(societyId, id, notice.status));
    return { noticeId: id, acknowledgedAt: at.toISOString(), revisionNo: n(notice.revisionNo) };
  });
}

export { istDayEnd, istDayStart };
