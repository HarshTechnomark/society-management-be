import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { Ticket, TicketComment, TicketUpvote, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { AppError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { assertFeature } from '../subscriptions/entitlements.service';
import { placeholderFiles, societyPorts } from '../societies/societies.ports';
import { ENT, ERR, LIMITS, NON_TERMINAL } from './helpdesk.constants';
import { assertDailyLimit, lockUserForLimit } from './helpdesk.building.service';
import { helpdeskPorts } from './helpdesk.ports';
import {
  assertWritableWhenSuspended,
  loadVisibleTicket,
  nearMeWhere,
  residentActor,
  typesFor,
} from './helpdesk.resident.access';
import {
  loadLookups,
  publicTimeline,
  residentCommentDto,
  residentTicketDto,
  residentTicketDtos,
} from './helpdesk.resident.dto';
import { societyIdOf } from './helpdesk.shared';
import { addComment } from './helpdesk.tickets.comment';
import { createTicket } from './helpdesk.tickets.core';
import { addUpvote, removeUpvote } from './helpdesk.tickets.upvote';
import { residentVisibleWhere } from './helpdesk.visibility';
import type { Urgency } from './helpdesk.constants';

/** Resident reads and writes of 8.17, 8.18, 8.22 to 8.24 and 8.26 (the six actions of 8.27 are in `helpdesk.me.actions.ts`). */

const NOT_YET_CLOSED = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_RESIDENT', 'REOPENED', 'RESOLVED'];
const CLOSED_TAB = ['CLOSED', 'CANCELLED'];
const DAY = 86_400_000;

export interface Page {
  page: number;
  limit: number;
}
const pagination = (p: Page, total: number) => ({
  page: p.page,
  limit: p.limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / p.limit)),
});

// ------------------------------------------------------------------ 8.22 list and detail
export async function listMyTickets(
  ctx: Ctx,
  q: {
    tab: 'OPEN' | 'CLOSED' | 'ALL';
    kind?: 'PERSONAL' | 'BUILDING';
    unitId?: number;
    sortBy: 'lastActivityAt' | 'createdAt';
    sortOrder: 'asc' | 'desc';
  } & Page,
) {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user!.id;
  const unitIds = ctx.unitIds ?? [];
  if (q.unitId !== undefined && !unitIds.includes(q.unitId))
    throw new NotFoundError(ERR.unitNotFound, 'Flat not found');
  const upvoted = (
    await TicketUpvote.findAll({ where: { societyId, userId }, attributes: ['ticketId'] })
  ).map(r => r.ticketId);
  const or: WhereOptions[] = [];
  const personalUnits = q.unitId !== undefined ? [q.unitId] : unitIds;
  if (personalUnits.length) or.push({ kind: 'PERSONAL', unitId: { [Op.in]: personalUnits } });
  or.push({ kind: 'BUILDING', requesterUserId: userId });
  if (upvoted.length) or.push({ kind: 'BUILDING', id: { [Op.in]: upvoted } });
  const and: WhereOptions[] = [{ societyId }, { [Op.or]: or }];
  if (q.kind) and.push({ kind: q.kind });
  if (q.tab === 'OPEN') and.push({ status: { [Op.in]: NOT_YET_CLOSED } });
  else if (q.tab === 'CLOSED') and.push({ status: { [Op.in]: CLOSED_TAB } });
  const where = { [Op.and]: and };
  const total = await Ticket.count({ where });
  const rows = await Ticket.findAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { items: await residentTicketDtos(ctx, rows), pagination: pagination(q, total) };
}

/** 8.22 detail: the DTO plus `recentComments` (PUBLIC, the last 20). */
export async function getMyTicket(ctx: Ctx, id: number) {
  const t = await loadVisibleTicket(ctx, id);
  const k = await loadLookups(ctx, [t]);
  const dto = residentTicketDto(ctx, t, k);
  return { ...dto, recentComments: await publicTimeline(ctx, t, { limit: 20 }) };
}

// ------------------------------------------------------------------ 8.23 personal complaint
export interface PersonalBody {
  unitId: number;
  categoryId: number;
  subCategoryId?: number;
  title: string;
  description: string;
  urgency?: Urgency;
  preferredSlotFrom?: Date;
  preferredSlotTo?: Date;
  invoiceId?: number;
  fileIds?: number[];
}

export async function createMyComplaint(ctx: Ctx, b: PersonalBody) {
  const societyId = societyIdOf(ctx);
  const created = await sequelize.transaction(async t => {
    await assertDailyLimit(ctx, t);
    return createTicket(
      ctx,
      {
        kind: 'PERSONAL',
        categoryId: b.categoryId,
        subCategoryId: b.subCategoryId ?? null,
        unitId: b.unitId,
        title: b.title,
        description: b.description,
        urgency: b.urgency,
        channel: 'APP',
        reporterRole: 'RESIDENT',
        invoiceId: b.invoiceId ?? null,
        fileIds: b.fileIds,
        preferredSlotFrom: b.preferredSlotFrom ?? null,
        preferredSlotTo: b.preferredSlotTo ?? null,
      },
      t,
    );
  });
  const row = (await Ticket.findOne({ where: { id: created.id, societyId } }))!;
  const [dto] = await residentTicketDtos(ctx, [row]);
  return { ...dto!, similarOpenTicketIds: created.similarOpenTicketIds };
}

// ------------------------------------------------------------------ 8.24 building issue list
export async function listBuildingIssues(
  ctx: Ctx,
  q: { scope: 'NEAR_ME' | 'ALL'; status: 'OPEN' | 'RESOLVED'; buildingId?: number } & Page,
) {
  const societyId = societyIdOf(ctx);
  let base: WhereOptions;
  if (q.scope === 'ALL') {
    await assertFeature(ctx, ENT.communityBoard, 'read');
    base = { [Op.and]: [await residentVisibleWhere(ctx), { kind: 'BUILDING' }] };
  } else base = await nearMeWhere(ctx);
  const and: WhereOptions[] = [base, { societyId }];
  if (q.status === 'OPEN') and.push({ status: { [Op.in]: [...NON_TERMINAL] } });
  else
    and.push({
      status: { [Op.in]: ['RESOLVED', 'CLOSED'] },
      resolvedAt: { [Op.gte]: new Date(now().getTime() - 90 * DAY) },
    });
  if (q.buildingId) and.push({ affectedBuildingId: q.buildingId });
  const where = { [Op.and]: and };
  const total = await Ticket.count({ where });
  const rows = await Ticket.findAll({
    where,
    order: [
      ['priority', 'ASC'],
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const k = await loadLookups(ctx, rows);
  const items = rows.map(t => {
    const d = residentTicketDto(ctx, t, k);
    return {
      id: t.id,
      ticketNo: t.ticketNo,
      title: t.title,
      status: t.status,
      priority: t.priority,
      locationLabel: t.locationNodeId ? (k.nodeLabels.get(t.locationNodeId) ?? null) : null,
      affectedLevel: t.affectedLevel,
      affectedUnitCount: t.affectedUnitCount,
      upvoteCount: t.upvoteCount,
      iUpvoted: d.iUpvoted,
      isRequester: ctx.user ? t.requesterUserId === ctx.user.id : false,
      assigneeLabel: t.assigneeLabel,
      slaState: (d.sla as { slaState: string }).slaState,
      resolutionDueAt: t.resolutionDueAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
    };
  });
  return { items, pagination: pagination(q, total) };
}

// ------------------------------------------------------------------ 8.17 comments
export async function listMyComments(ctx: Ctx, id: number, q: { before?: number; limit: number }) {
  const t = await loadVisibleTicket(ctx, id);
  return publicTimeline(ctx, t, q);
}

/** BR-15-14: 60 comments per user per hour (removed ones still count). */
async function assertCommentRate(ctx: Ctx, t: Transaction): Promise<void> {
  await lockUserForLimit(ctx.user!.id, t);
  const used = await TicketComment.count({
    where: {
      societyId: societyIdOf(ctx),
      authorUserId: ctx.user!.id,
      kind: 'COMMENT',
      createdAt: { [Op.gte]: new Date(now().getTime() - 3_600_000) },
    },
    paranoid: false,
    transaction: t,
  });
  if (used >= LIMITS.commentsPerHour)
    throw new AppError(429, ERR.rateLimited, 'Too many comments. Try again later.', undefined, {
      'Retry-After': '600',
    });
}

export async function addMyComment(ctx: Ctx, id: number, b: { body: string; fileIds?: number[] }) {
  const visible = await loadVisibleTicket(ctx, id);
  assertWritableWhenSuspended(ctx, visible);
  const row = await sequelize.transaction(async t => {
    await assertCommentRate(ctx, t);
    const types = await typesFor(ctx, visible, t);
    return addComment(
      ctx,
      id,
      residentActor(ctx, types),
      { body: b.body, fileIds: b.fileIds, visibility: 'PUBLIC' },
      t,
    );
  });
  const ticket = (await Ticket.findByPk(id))!;
  const k = await loadLookups(ctx, [ticket]);
  return residentCommentDto(ctx, row, ticket, k, helpdeskPorts().files.list('ticket_comment', row.id));
}

// ------------------------------------------------------------------ 8.18 file download
export async function myFileUrl(ctx: Ctx, id: number, fileId: number, disposition: 'inline' | 'attachment') {
  const t = await loadVisibleTicket(ctx, id);
  const files = helpdeskPorts().files;
  let linked = files.list('ticket', t.id).includes(fileId);
  if (!linked) {
    // files of PUBLIC, non-removed comments only (BR-15-51); the WHERE clause fixes the visibility
    const comments = await TicketComment.findAll({
      where: { ticketId: t.id, societyId: t.societyId, visibility: 'PUBLIC' },
      attributes: ['id'],
    });
    linked = comments.some(c => files.list('ticket_comment', c.id).includes(fileId));
  }
  const f = placeholderFiles.get(fileId);
  if (!linked || !f || f.societyId !== t.societyId)
    throw new NotFoundError(ERR.fileNotFound, 'File not found');
  if (f.status === 'DELETED') throw new AppError(410, 'FILE_DELETED', 'This file was removed');
  if (f.status !== 'CLEAN') throw new AppError(409, 'FILE_NOT_READY', 'This file is not ready yet');
  const link = await societyPorts().files.downloadUrl(fileId, 5);
  return { url: link.url, expiresAt: link.expiresAt.toISOString(), disposition };
}

// ------------------------------------------------------------------ 8.26 Me too
export async function upvoteMine(ctx: Ctx, id: number, note?: string) {
  const visible = await loadVisibleTicket(ctx, id);
  assertWritableWhenSuspended(ctx, visible);
  const count = await sequelize.transaction(async t => {
    const r = await addUpvote(ctx, id, { note }, t);
    if (note?.trim()) {
      const types = await typesFor(ctx, visible, t);
      await addComment(ctx, id, residentActor(ctx, types), { body: note.trim(), visibility: 'PUBLIC' }, t);
    }
    return r.upvoteCount;
  });
  return { ticketId: id, upvoteCount: count, iUpvoted: true };
}

export async function removeUpvoteMine(ctx: Ctx, id: number) {
  const visible = await loadVisibleTicket(ctx, id).catch(async e => {
    // a former upvoter may lose visibility; the upvote row still belongs to them
    if (await TicketUpvote.count({ where: { ticketId: id, userId: ctx.user!.id } })) return null;
    throw e;
  });
  if (visible) assertWritableWhenSuspended(ctx, visible);
  const r = await sequelize.transaction(t => removeUpvote(ctx, id, t));
  return { ticketId: id, upvoteCount: r.upvoteCount, iUpvoted: false };
}
