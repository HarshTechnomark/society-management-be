import { type Transaction } from 'sequelize';
import { TicketComment, TicketUpvote } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { assertFeature, isFeatureOn } from '../subscriptions/entitlements.service';
import { AUDIT, ENT, ENTITY, ERR, LIMITS, type Visibility } from './helpdesk.constants';
import { settleBreach } from './helpdesk.escalation';
import { helpdeskPorts } from './helpdesk.ports';
import { emitTicketChanged, factsOf, lockTicket, societyIdOf, systemActor } from './helpdesk.shared';
import { markFirstResponse, transitionTicket } from './helpdesk.tickets.transition';
import { resolveTransition } from './helpdesk.state';
import type { Actor } from './helpdesk.types';

export interface CommentInput {
  body: string;
  visibility?: Visibility;
  fileIds?: number[];
  notifyAffected?: boolean;
}

/**
 * BR-15-52 to BR-15-54 and BR-15-43: adds a COMMENT. Body 1 to 2000 characters, up to 6 files, INTERNAL needs the plan feature and a non-resident,
 * non-vendor author. Residents on a building issue must be the requester or an upvoter (`422 COMMENT_NOT_ALLOWED`). Closed and cancelled tickets refuse
 * comments (`409 INVALID_STATE`). A public comment of the requester or a unit resident on a ticket waiting for a resident moves it back to IN_PROGRESS
 * (not while waiting for an estimate decision). A public staff comment is the first response (BR-15-27).
 */
export async function addComment(
  ctx: Ctx,
  ticketId: number,
  actor: Actor,
  input: CommentInput,
  t: Transaction,
): Promise<TicketComment> {
  const societyId = societyIdOf(ctx);
  const ticket = await lockTicket(societyId, ticketId, t);
  const body = (input.body ?? '').trim();
  if (body.length < 1 || body.length > LIMITS.commentMax)
    throw new ValidationError([{ field: 'body', message: '1 to 2000 characters' }]);
  const fileIds = [...new Set(input.fileIds ?? [])];
  if (fileIds.length > LIMITS.maxFiles)
    throw new ValidationError([{ field: 'fileIds', message: 'At most 6 files' }]);
  if (fileIds.length) await assertFeature(ctx, ENT.attachments);
  if (ticket.status === 'CLOSED' || ticket.status === 'CANCELLED')
    throw new AppError(409, ERR.invalidState, 'This ticket no longer takes comments');
  const visibility: Visibility = input.visibility ?? 'PUBLIC';
  const resident = actor.role === 'RESIDENT';
  if (visibility === 'INTERNAL') {
    if (resident || actor.role === 'VENDOR' || actor.role === 'GUARD')
      throw new ForbiddenError(ERR.permissionDenied);
    if (!(await isFeatureOn(societyId, ENT.internalNotes))) await assertFeature(ctx, ENT.internalNotes);
  }
  const isRequester = Boolean(actor.userId) && ticket.requesterUserId === actor.userId;
  const isUnitResident =
    resident &&
    ticket.kind === 'PERSONAL' &&
    ticket.unitId !== null &&
    (ctx.unitIds ?? []).includes(ticket.unitId);
  if (resident && ticket.kind === 'BUILDING' && !isRequester) {
    const up = await TicketUpvote.count({ where: { ticketId, userId: actor.userId ?? 0 }, transaction: t });
    if (!up)
      throw new UnprocessableError(ERR.commentNotAllowed, 'Tap Me too on this issue before commenting');
  }
  const at = now();
  const row = await TicketComment.create(
    {
      societyId,
      ticketId,
      kind: 'COMMENT',
      visibility,
      authorUserId: actor.userId,
      authorRole: actor.userId ? actor.role : 'SYSTEM',
      authorName: actor.userId ? actor.name : 'System',
      authorUnitId: resident ? (isUnitResident ? ticket.unitId : ((ctx.unitIds ?? [])[0] ?? null)) : null,
      body,
      notifyAffected: Boolean(input.notifyAffected) && !resident && visibility === 'PUBLIC',
      createdBy: actor.userId,
    },
    { transaction: t },
  );
  if (fileIds.length) await helpdeskPorts().files.link(ctx, fileIds, 'ticket_comment', row.id, t);

  let changed = false;
  if (
    visibility === 'PUBLIC' &&
    !resident &&
    !isRequester &&
    ['ADMIN', 'STAFF', 'VENDOR', 'GUARD'].includes(actor.role) &&
    !ticket.firstResponseAt
  ) {
    markFirstResponse(ticket, at);
    changed = true;
  }
  ticket.lastActivityAt = at;
  ticket.version += 1;
  await ticket.save({ transaction: t });
  settleBreach(ticket, at, false);
  await audit(
    ctx,
    {
      action: AUDIT.commentAdded,
      entityType: ENTITY.ticket,
      entityId: ticketId,
      entityLabel: ticket.ticketNo,
      after: { commentId: row.id, visibility, length: body.length },
      societyId,
    },
    t,
  );
  emitTicketChanged(t, ticket, {
    event: 'COMMENT',
    actorUserId: actor.userId,
    data: { commentId: row.id, visibility, notifyAffected: row.notifyAffected },
  });
  if (changed) await ticket.save({ transaction: t });

  // BR-15-43: a resident's public reply resumes the ticket (except while an estimate decision is awaited)
  if (
    visibility === 'PUBLIC' &&
    ticket.status === 'WAITING_ON_RESIDENT' &&
    ticket.waitingReason !== 'ESTIMATE_APPROVAL' &&
    (isRequester || isUnitResident)
  ) {
    const sys = systemActor(ctx);
    if (resolveTransition(factsOf(ticket), 'RESUME', sys.types))
      await transitionTicket(ctx, ticketId, sys, { action: 'RESUME', note: 'Resident replied' }, t);
  }
  return row;
}

/**
 * BR-15-54 removal (soft delete, kind COMMENT only): the author within 15 minutes, or `moderator` (holders of `helpdesk.tickets.delete`, decided by the
 * route) at any time with a reason. Files stay linked but are no longer served.
 */
export async function removeComment(
  ctx: Ctx,
  ticketId: number,
  commentId: number,
  actor: Actor,
  opts: { moderator: boolean; reason?: string },
  t: Transaction,
): Promise<void> {
  const societyId = societyIdOf(ctx);
  await lockTicket(societyId, ticketId, t);
  const c = await TicketComment.findOne({
    where: { id: commentId, ticketId, societyId, kind: 'COMMENT' },
    transaction: t,
  });
  if (!c) throw new NotFoundError(ERR.commentNotFound, 'Comment not found');
  const own = Boolean(actor.userId) && c.authorUserId === actor.userId;
  if (!opts.moderator) {
    if (!own) throw new ForbiddenError(ERR.permissionDenied);
    if (now().getTime() - c.createdAt.getTime() > LIMITS.commentDeleteWindowMinutes * 60_000)
      throw new UnprocessableError(
        ERR.commentDeleteWindowExpired,
        'A comment can be removed within 15 minutes',
      );
  } else if (!own && !(opts.reason ?? '').trim())
    throw new ValidationError([{ field: 'reason', message: 'A reason is needed to remove a comment' }]);
  await c.update(
    { deletedByUserId: actor.userId, deleteReason: opts.reason?.slice(0, 300) ?? null },
    { transaction: t },
  );
  await c.destroy({ transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT.commentRemoved,
      entityType: ENTITY.ticket,
      entityId: ticketId,
      after: { commentId },
      reason: opts.reason ?? null,
      societyId,
    },
    t,
  );
}
