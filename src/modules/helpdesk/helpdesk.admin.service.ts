import { Op, type Transaction } from 'sequelize';
import { Ticket, TicketComment, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import {
  AppError,
  NotFoundError,
  RateLimitedError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { hasPermission } from '../access-control/access-control.public';
import { societyToday } from '../billing/billing.runs.shared';
import { committee } from '../committee/committee.public';
import { residents } from '../residents/residents.public';
import { societyPorts } from '../societies/societies.ports';
import { assertFeature } from '../subscriptions/entitlements.service';
import { locations, units } from '../society-setup/society-setup.public';
import {
  AUDIT,
  ENT,
  ENTITY,
  ERR,
  LIMITS,
  type Channel,
  type Priority,
  type TicketKind,
  type Visibility,
} from './helpdesk.constants';
import { toTicketDto } from './helpdesk.admin.dto';
import { dayStart, similarBuildingIssues, type SimilarItem } from './helpdesk.admin.list';
import type { BuildingIssueBody } from './helpdesk.admin.validation';
import { recomputeNextCheck } from './helpdesk.escalation';
import { helpdeskPorts } from './helpdesk.ports';
import { reporterRoleFor, resolveAffected, scopeFits, validTitle } from './helpdesk.rules';
import { assignTicket, unassignTicket } from './helpdesk.routing';
import {
  addTimeline,
  emitTicketChanged,
  lockTicket,
  notFound,
  societyIdOf,
  userActor,
} from './helpdesk.shared';
import { commentWhere, type CommentAudience } from './helpdesk.visibility';
import { addComment, removeComment } from './helpdesk.tickets.comment';
import { createTicket, loadEffectiveCategory } from './helpdesk.tickets.core';
import { mergeTickets } from './helpdesk.tickets.merge';
import { markFirstResponse, recomputeSla, transitionTicket } from './helpdesk.tickets.transition';
import type { Actor, TransitionInput } from './helpdesk.types';
import type { z } from 'zod';
import type { adminSchemas } from './helpdesk.admin.validation';

type Body<K extends keyof typeof adminSchemas> = z.infer<(typeof adminSchemas)[K]>;

const bad = (field: string, message: string) => new ValidationError([{ field, message }]);
const run = <T>(fn: (t: Transaction) => Promise<T>): Promise<T> => sequelize.transaction(fn);
const adminActor = (ctx: Ctx): Actor => userActor(ctx, new Set(['ADMIN']), 'ADMIN');

/** The ticket of this society or `404 TICKET_NOT_FOUND` (another society's id looks the same). */
export async function findTicket(ctx: Ctx, id: number): Promise<Ticket> {
  const t = await Ticket.findOne({ where: { id, societyId: societyIdOf(ctx) } });
  if (!t) throw notFound();
  return t;
}

// ------------------------------------------------------------------ comments (timeline)
export interface CommentItem {
  id: number;
  kind: string;
  visibility: string;
  authorRole: string;
  authorLabel: string;
  body: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown> | null;
  fileIds: number[];
  notifyAffected: boolean;
  createdAt: string;
  canDelete: boolean;
}

export function toCommentItem(ctx: Ctx, c: TicketComment): CommentItem {
  const own = Boolean(ctx.user) && c.authorUserId === ctx.user!.id;
  const fresh = now().getTime() - c.createdAt.getTime() <= LIMITS.commentDeleteWindowMinutes * 60_000;
  return {
    id: c.id,
    kind: c.kind,
    visibility: c.visibility,
    authorRole: c.authorRole,
    authorLabel: c.authorName,
    body: c.body,
    fromStatus: c.fromStatus,
    toStatus: c.toStatus,
    metadata: c.metadata,
    fileIds: helpdeskPorts().files.list('ticket_comment', c.id),
    notifyAffected: c.notifyAffected,
    createdAt: c.createdAt.toISOString(),
    canDelete: c.kind === 'COMMENT' && (hasPermission(ctx, 'helpdesk.tickets.delete') || (own && fresh)),
  };
}

/** Newest first; `before` is a comment id cursor (8.17). Internal notes included (admin audience). */
export async function listComments(ctx: Ctx, ticketId: number, q: { before?: number; limit: number }) {
  const t = await findTicket(ctx, ticketId);
  const rows = await TicketComment.findAll({
    where: { ticketId: t.id, societyId: t.societyId, ...(q.before ? { id: { [Op.lt]: q.before } } : {}) },
    order: [['id', 'DESC']],
    limit: q.limit,
  });
  return rows.map(r => toCommentItem(ctx, r));
}

async function guardCommentRates(ctx: Ctx, ticket: Ticket, notify: boolean): Promise<void> {
  const since = new Date(now().getTime() - 3_600_000);
  const hourly = await TicketComment.count({
    where: {
      societyId: ticket.societyId,
      authorUserId: ctx.user!.id,
      kind: 'COMMENT',
      createdAt: { [Op.gte]: since },
    },
    paranoid: false,
  });
  if (hourly >= LIMITS.commentsPerHour) throw new RateLimitedError(600);
  if (!notify) return;
  const start = dayStart(await societyToday(ticket.societyId));
  const broadcasts = await TicketComment.count({
    where: { ticketId: ticket.id, notifyAffected: true, createdAt: { [Op.gte]: start } },
    paranoid: false,
  });
  if (broadcasts >= LIMITS.broadcastsPerDay) throw new RateLimitedError(3600);
}

export async function postComment(
  ctx: Ctx,
  ticketId: number,
  body: Body<'commentPost'>,
): Promise<CommentItem> {
  const societyId = societyIdOf(ctx);
  const row = await run(async t => {
    const ticket = await lockTicket(societyId, ticketId, t);
    const visibility: Visibility = body.visibility ?? 'PUBLIC';
    if (body.notifyAffected && (ticket.kind !== 'BUILDING' || visibility !== 'PUBLIC'))
      throw bad('notifyAffected', 'Only a public comment on a building issue can notify the affected flats');
    await guardCommentRates(ctx, ticket, Boolean(body.notifyAffected));
    return addComment(
      ctx,
      ticketId,
      adminActor(ctx),
      { body: body.body, visibility, fileIds: body.fileIds, notifyAffected: body.notifyAffected },
      t,
    );
  });
  return toCommentItem(ctx, row);
}

export async function deleteComment(
  ctx: Ctx,
  ticketId: number,
  commentId: number,
  reason: string | undefined,
): Promise<void> {
  const societyId = societyIdOf(ctx);
  await run(async t => {
    await lockTicket(societyId, ticketId, t);
    const c = await TicketComment.findOne({ where: { id: commentId, ticketId, societyId }, transaction: t });
    if (!c) throw new NotFoundError(ERR.commentNotFound, 'Comment not found');
    if (c.kind !== 'COMMENT') throw new AppError(409, ERR.invalidState, 'System entries cannot be removed');
    await removeComment(
      ctx,
      ticketId,
      commentId,
      adminActor(ctx),
      { moderator: hasPermission(ctx, 'helpdesk.tickets.delete'), reason },
      t,
    );
  });
}

// ------------------------------------------------------------------ detail (8.8)
export async function getDetail(ctx: Ctx, id: number): Promise<Record<string, unknown>> {
  const t = await findTicket(ctx, id);
  const [dto, recent, similarOpen] = await Promise.all([
    toTicketDto(ctx, t),
    TicketComment.findAll({ where: { ticketId: t.id }, order: [['id', 'DESC']], limit: 20 }),
    similarFor(ctx, t),
  ]);
  return { ...dto, recentComments: recent.map(c => toCommentItem(ctx, c)), similarOpen };
}

async function similarFor(ctx: Ctx, t: Ticket): Promise<SimilarItem[]> {
  if (t.kind !== 'BUILDING' || !t.locationNodeId) return [];
  const all = await similarBuildingIssues(ctx, {
    locationNodeId: t.locationNodeId,
    categoryId: t.categoryId,
  });
  return all.items.filter(i => i.id !== t.id);
}

// ------------------------------------------------------------------ create (8.9, 8.10)
export async function createOnBehalf(ctx: Ctx, b: Body<'onBehalf'>): Promise<Record<string, unknown>> {
  const societyId = societyIdOf(ctx);
  const { id, similar } = await run(async t => {
    const unit = await units.get(societyId, b.unitId);
    if (!unit || unit.status !== 'ACTIVE') throw new NotFoundError(ERR.unitNotFound, 'Flat not found');
    let requesterUserId: number | null | undefined;
    let requesterName: string | undefined;
    if (b.requesterResidentId) {
      const link = (await residents.listForUnit(societyId, b.unitId)).find(
        l => l.residentId === b.requesterResidentId,
      );
      if (!link) throw new NotFoundError(ERR.residentNotFound, 'Resident not found for this flat');
      requesterUserId = link.userId;
      requesterName = link.name;
    }
    const seated = (await committee.isSeated(societyId, ctx.user!.id)).seated;
    const c = await createTicket(
      ctx,
      {
        kind: 'PERSONAL',
        unitId: b.unitId,
        categoryId: b.categoryId,
        subCategoryId: b.subCategoryId,
        title: b.title,
        description: b.description,
        priority: b.priority as Priority | undefined,
        channel: b.channel as Channel,
        reporterRole: reporterRoleFor('ADMIN', seated),
        requesterUserId,
        requesterName,
        invoiceId: b.invoiceId,
        fileIds: b.fileIds,
        preferredSlotFrom: b.preferredSlotFrom,
        preferredSlotTo: b.preferredSlotTo,
      },
      t,
    );
    return { id: c.id, similar: c.similarOpenTicketIds };
  });
  return { ...(await toTicketDto(ctx, await findTicket(ctx, id))), similarOpenTicketIds: similar };
}

/** A building issue reported by the office (admin route) or by staff (module 28): one code path, the audience sets role and channel. */
export async function reportBuildingIssue(
  ctx: Ctx,
  b: BuildingIssueBody,
  audience: 'ADMIN' | 'WORK',
): Promise<Ticket> {
  const societyId = societyIdOf(ctx);
  const id = await run(async t => {
    let nodeId = b.locationNodeId;
    let channel: Channel = audience === 'ADMIN' ? 'APP' : 'STAFF_APP';
    if (b.qrToken) {
      await assertFeature(ctx, ENT.qr);
      const n = await locations.getByQrToken(societyId, b.qrToken);
      if (!n) throw new NotFoundError(ERR.qrNotFound, 'QR code not found');
      if (nodeId && nodeId !== n.id) throw bad('locationNodeId', 'The location does not match the QR code');
      nodeId = n.id;
      channel = 'QR';
    }
    const role =
      audience === 'WORK'
        ? 'STAFF'
        : reporterRoleFor('ADMIN', (await committee.isSeated(societyId, ctx.user!.id)).seated);
    const c = await createTicket(
      ctx,
      {
        kind: 'BUILDING' as TicketKind,
        locationNodeId: nodeId,
        affectedLevel: b.affectedLevel,
        categoryId: b.categoryId,
        subCategoryId: b.subCategoryId,
        urgency: b.urgency,
        priority: audience === 'ADMIN' ? (b.priority as Priority | undefined) : undefined,
        title: b.title,
        description: b.description,
        assetId: b.assetId,
        duplicateReason: b.duplicateReason,
        fileIds: b.fileIds,
        channel,
        reporterRole: role,
      },
      t,
    );
    return c.id;
  });
  return findTicket(ctx, id);
}

// ------------------------------------------------------------------ patch (8.12)
function checkSlot(from: Date, to: Date): void {
  const mins = (to.getTime() - from.getTime()) / 60_000;
  if (mins < 30 || mins > 720) throw bad('preferredSlotTo', 'The slot must be 30 minutes to 12 hours');
  const at = now().getTime();
  if (from.getTime() < at - 5 * 60_000) throw bad('preferredSlotFrom', 'The slot cannot start in the past');
  if (from.getTime() > at + 30 * 86_400_000) throw bad('preferredSlotFrom', 'Within the next 30 days');
}

export async function patchTicket(ctx: Ctx, id: number, b: Body<'patch'>): Promise<Record<string, unknown>> {
  const societyId = societyIdOf(ctx);
  await run(async t => {
    const tk = await lockTicket(societyId, id, t, b.version);
    if (tk.status === 'CLOSED' || tk.status === 'CANCELLED')
      throw new AppError(409, ERR.invalidState, 'This ticket can no longer be edited');
    const textOnly = ['title', 'description', 'version'];
    if (tk.status === 'RESOLVED' && Object.keys(b).some(k => !textOnly.includes(k)))
      throw new AppError(409, ERR.invalidState, 'Only the title and description can change once resolved');
    const actor = adminActor(ctx);
    const changed: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const personal = tk.kind === 'PERSONAL';
    let recompute = false;
    let priorityNote: string | null = null;

    if (b.title !== undefined && b.title !== tk.title) {
      if (!validTitle(b.title)) throw bad('title', '5 to 150 characters');
      tk.title = b.title;
      changed.push('title');
    }
    if (b.description !== undefined && b.description !== tk.description) {
      if (personal && b.description.length < LIMITS.personalDescMin)
        throw bad('description', 'At least 10 characters');
      tk.description = b.description;
      changed.push('description');
    }
    if (b.categoryId !== undefined || b.subCategoryId !== undefined) {
      const categoryId = b.categoryId ?? tk.categoryId;
      const subId =
        b.subCategoryId !== undefined
          ? b.subCategoryId
          : b.categoryId && b.categoryId !== tk.categoryId
            ? null
            : tk.subCategoryId;
      if (categoryId !== tk.categoryId || subId !== tk.subCategoryId) {
        const cat = await loadEffectiveCategory(societyId, categoryId, subId, t);
        if (!scopeFits(cat.scope, tk.kind))
          throw new UnprocessableError(
            ERR.categoryScopeMismatch,
            'This category is not for this kind of issue',
          );
        before.categoryId = tk.categoryId;
        before.subCategoryId = tk.subCategoryId;
        tk.categoryId = cat.categoryId;
        tk.subCategoryId = cat.subCategoryId;
        if (personal && tk.chargeStatus === 'NONE' && b.isChargeable === undefined)
          tk.isChargeable = cat.isChargeable;
        after.categoryId = tk.categoryId;
        after.subCategoryId = tk.subCategoryId;
        changed.push('category');
        recompute = true;
      }
    }
    if (b.priority !== undefined && b.priority !== tk.priority) {
      if (!b.priorityReason) throw bad('priorityReason', 'Give a reason for the new priority');
      priorityNote = `Priority changed from ${tk.priority} to ${b.priority}: ${b.priorityReason}`;
      before.priority = tk.priority;
      tk.priority = b.priority;
      tk.prioritySource = 'ADMIN';
      after.priority = tk.priority;
      changed.push('priority');
      recompute = true;
    }
    if (b.affectedLevel !== undefined && b.affectedLevel !== tk.affectedLevel) {
      if (personal || !tk.locationNodeId)
        throw bad('affectedLevel', 'Only a building issue has an affected level');
      const node = await locations.get(societyId, tk.locationNodeId);
      if (!node) throw new NotFoundError(ERR.locationNotFound, 'Location not found');
      const a = resolveAffected(b.affectedLevel, node);
      const filter =
        a.level === 'SOCIETY'
          ? {}
          : a.level === 'BUILDING'
            ? { buildingId: a.buildingId! }
            : { buildingId: a.buildingId!, floor: a.floor! };
      before.affectedLevel = tk.affectedLevel;
      tk.affectedLevel = a.level;
      tk.affectedBuildingId = a.buildingId;
      tk.affectedFloor = a.floor;
      tk.affectedUnitCount = (await units.listActive(societyId, filter)).length;
      after.affectedLevel = a.level;
      after.affectedUnitCount = tk.affectedUnitCount;
      changed.push('affectedLevel');
    }
    if (b.preferredSlotFrom !== undefined || b.preferredSlotTo !== undefined) {
      if (!personal) throw bad('preferredSlotFrom', 'A visit slot is for personal complaints');
      const from = b.preferredSlotFrom ?? null;
      const to = b.preferredSlotTo ?? null;
      if (!from !== !to) throw bad('preferredSlotFrom', 'Send both ends of the slot or neither');
      if (from && to) {
        await assertFeature(ctx, ENT.preferredSlot);
        checkSlot(from, to);
      }
      tk.preferredSlotFrom = from;
      tk.preferredSlotTo = to;
      changed.push('preferredSlot');
    }
    if (b.isChargeable !== undefined && b.isChargeable !== tk.isChargeable) {
      if (!personal) throw bad('isChargeable', 'Only a personal complaint can be chargeable');
      if (tk.chargeStatus !== 'NONE')
        throw new UnprocessableError(
          ERR.chargeStateLocked,
          'The charge can no longer be changed after an estimate',
        );
      before.isChargeable = tk.isChargeable;
      tk.isChargeable = b.isChargeable;
      after.isChargeable = b.isChargeable;
      changed.push('isChargeable');
    }
    if (!changed.length) return;
    if (recompute) await recomputeSla(tk, t);
    else await recomputeNextCheck(tk, t);
    tk.lastActivityAt = now();
    tk.updatedBy = actor.userId;
    tk.version += 1;
    await tk.save({ transaction: t });
    if (priorityNote)
      await addTimeline(
        societyId,
        tk.id,
        actor,
        {
          kind: 'PRIORITY_CHANGE',
          visibility: 'INTERNAL',
          body: priorityNote,
          metadata: { from: before.priority, to: after.priority },
        },
        t,
      );
    await audit(
      ctx,
      {
        action: AUDIT.ticketUpdated,
        entityType: ENTITY.ticket,
        entityId: tk.id,
        entityLabel: tk.ticketNo,
        // a personal complaint's text never goes into the audit log (section 13): only the names of the changed fields
        before,
        after,
        reason: null,
        societyId,
      },
      t,
    );
    if (priorityNote)
      await audit(
        ctx,
        {
          action: AUDIT.priorityChanged,
          entityType: ENTITY.ticket,
          entityId: tk.id,
          entityLabel: tk.ticketNo,
          before: { priority: before.priority },
          after: { priority: after.priority },
          reason: b.priorityReason ?? null,
          societyId,
        },
        t,
      );
    emitTicketChanged(t, tk, {
      event: priorityNote ? 'PRIORITY_CHANGED' : 'UPDATED',
      actorUserId: actor.userId,
      data: { changed },
    });
  });
  return toTicketDto(ctx, await findTicket(ctx, id));
}

// ------------------------------------------------------------------ assign, unassign, transition, merge (8.13 to 8.15)
export async function assign(ctx: Ctx, id: number, b: Body<'assign'>): Promise<Record<string, unknown>> {
  const societyId = societyIdOf(ctx);
  await run(async t => {
    const actor = adminActor(ctx);
    await assignTicket(
      ctx,
      id,
      actor,
      {
        type: b.assigneeType,
        userId: b.userId,
        staffId: b.staffId,
        vendorId: b.vendorId,
        externalName: b.externalName,
        externalMobile: b.externalMobile,
        createWorkOrder: b.createWorkOrder,
        note: b.note,
        version: b.version,
      },
      t,
    );
    if (b.note)
      await addTimeline(
        societyId,
        id,
        actor,
        { kind: 'ASSIGNMENT', visibility: b.noteInternal ? 'INTERNAL' : 'PUBLIC', body: b.note },
        t,
      );
  });
  return toTicketDto(ctx, await findTicket(ctx, id));
}

export async function unassign(ctx: Ctx, id: number, b: Body<'unassign'>): Promise<Record<string, unknown>> {
  const societyId = societyIdOf(ctx);
  await run(async t => {
    const actor = adminActor(ctx);
    await unassignTicket(ctx, id, actor, { version: b.version }, t);
    await addTimeline(
      societyId,
      id,
      actor,
      { kind: 'ASSIGNMENT', visibility: 'INTERNAL', body: `Reason: ${b.reason}` },
      t,
    );
  });
  return toTicketDto(ctx, await findTicket(ctx, id));
}

export async function transition(
  ctx: Ctx,
  id: number,
  b: Body<'transition'>,
): Promise<Record<string, unknown>> {
  const input: TransitionInput = { ...b };
  await run(t => transitionTicket(ctx, id, adminActor(ctx), input, t));
  return toTicketDto(ctx, await findTicket(ctx, id));
}

export async function merge(ctx: Ctx, id: number, b: Body<'merge'>) {
  await run(t =>
    mergeTickets(ctx, id, b.intoTicketId, adminActor(ctx), { note: b.note, version: b.version }, t),
  );
  return {
    duplicate: await toTicketDto(ctx, await findTicket(ctx, id)),
    primary: await toTicketDto(ctx, await findTicket(ctx, b.intoTicketId)),
  };
}

// ------------------------------------------------------------------ estimate (8.16, BR-15-55)
export async function sendEstimate(
  ctx: Ctx,
  id: number,
  b: Body<'estimate'>,
): Promise<Record<string, unknown>> {
  const societyId = societyIdOf(ctx);
  await run(async t => {
    const tk = await lockTicket(societyId, id, t, b.version);
    if (tk.kind !== 'PERSONAL' || !tk.isChargeable)
      throw new UnprocessableError(
        ERR.estimateNotAllowed,
        'An estimate can only be sent for a chargeable personal complaint',
      );
    if (tk.status !== 'IN_PROGRESS')
      throw new AppError(
        409,
        ERR.invalidTransition,
        `An estimate cannot be sent while the ticket is ${tk.status}`,
        [{ field: 'action', message: 'START the work first' }],
      );
    if (tk.chargeStatus !== 'NONE' && tk.chargeStatus !== 'REJECTED')
      throw new AppError(409, ERR.invalidState, 'An estimate was already sent');
    const at = now();
    const actor = adminActor(ctx);
    tk.chargeStatus = 'ESTIMATE_SENT';
    tk.chargeEstimatePaise = b.estimatePaise;
    tk.chargeEstimateNote = b.note;
    tk.chargeEstimateSentAt = at;
    tk.chargeDecidedAt = null;
    tk.chargeDecidedByUserId = null;
    markFirstResponse(tk, at);
    // BR-15-28: waiting for the resident pauses the resolution clock
    tk.status = 'WAITING_ON_RESIDENT';
    tk.waitingReason = 'ESTIMATE_APPROVAL';
    tk.slaPausedAt = at;
    tk.waitingReminderSentAt = null;
    tk.lastActivityAt = at;
    tk.updatedBy = actor.userId;
    tk.version += 1;
    await recomputeNextCheck(tk, t);
    await tk.save({ transaction: t });
    await addTimeline(
      societyId,
      tk.id,
      actor,
      {
        kind: 'ESTIMATE',
        visibility: 'PUBLIC',
        body: `Estimate of Rs ${(b.estimatePaise / 100).toFixed(2)}: ${b.note}`,
        fromStatus: 'IN_PROGRESS',
        toStatus: 'WAITING_ON_RESIDENT',
        metadata: { estimatePaise: b.estimatePaise },
      },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT.estimateSent,
        entityType: ENTITY.ticket,
        entityId: tk.id,
        entityLabel: tk.ticketNo,
        after: { estimatePaise: b.estimatePaise },
        societyId,
      },
      t,
    );
    emitTicketChanged(t, tk, {
      event: 'ESTIMATE',
      fromStatus: 'IN_PROGRESS',
      actorUserId: actor.userId,
      data: { estimatePaise: b.estimatePaise },
    });
    t.afterCommit(() => helpdeskPorts().reportsCache.touch(societyId, 'helpdesk'));
  });
  return toTicketDto(ctx, await findTicket(ctx, id));
}

// ------------------------------------------------------------------ file download URLs (8.18)
/**
 * The file must be linked to the ticket or to a non-removed comment of the ticket the audience may see (INTERNAL comments only for admins and staff).
 * Then module 01 issues the short-lived URL; module 15 did the access check.
 */
export async function ticketFileUrl(
  ctx: Ctx,
  ticket: Ticket,
  fileId: number,
  audience: CommentAudience,
  disposition: 'inline' | 'attachment',
): Promise<{ url: string; expiresAt: string }> {
  const ports = helpdeskPorts().files;
  let linked = ports.list('ticket', ticket.id).includes(fileId);
  if (!linked) {
    const comments = await TicketComment.findAll({
      where: { ticketId: ticket.id, societyId: ticket.societyId, ...commentWhere(audience) },
      attributes: ['id'],
    });
    linked = comments.some(c => ports.list('ticket_comment', c.id).includes(fileId));
  }
  if (!linked) throw new NotFoundError(ERR.fileNotFound, 'File not found');
  const r = await societyPorts().files.downloadUrl(fileId, 5);
  const url =
    disposition === 'attachment' ? `${r.url}${r.url.includes('?') ? '&' : '?'}disposition=attachment` : r.url;
  return { url, expiresAt: r.expiresAt.toISOString() };
}

export async function adminFileUrl(
  ctx: Ctx,
  id: number,
  fileId: number,
  disposition: 'inline' | 'attachment',
) {
  return ticketFileUrl(ctx, await findTicket(ctx, id), fileId, 'ADMIN', disposition);
}
