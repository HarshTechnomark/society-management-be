import { Op, type Transaction } from 'sequelize';
import { Ticket, TicketUpvote, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ForbiddenError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { assertFeature } from '../subscriptions/entitlements.service';
import { residents } from '../residents/residents.public';
import { AUDIT, ENT, ENTITY, ERR, SETTING, type CallerType } from './helpdesk.constants';
import { fireLowCsat, fireResidentRequest } from './helpdesk.escalation';
import { denied, loadVisibleTicket, residentActor, typesFor } from './helpdesk.resident.access';
import { loadLookups, publicTimeline, residentTicketDto } from './helpdesk.resident.dto';
import {
  addTimeline,
  emitTicketChanged,
  lockTicket,
  setting,
  societyIdOf,
  systemActor,
} from './helpdesk.shared';
import { transitionTicket } from './helpdesk.tickets.transition';
import type { CallerTypes } from './helpdesk.types';

/** The six resident actions of 8.27: confirm, rating, reopen, cancel, escalate and estimate decision. */

const DAY = 86_400_000;
const anyOf = (types: CallerTypes, ...want: CallerType[]): boolean => want.some(w => types.has(w));

/** The ticket as the resident sees it after an action: the DTO plus `recentComments`. */
async function fresh(ctx: Ctx, id: number) {
  const t = (await Ticket.findByPk(id))!;
  const k = await loadLookups(ctx, [t]);
  return { ...residentTicketDto(ctx, t, k), recentComments: await publicTimeline(ctx, t, { limit: 20 }) };
}

// ------------------------------------------------------------------ rating (BR-15-56)
/**
 * Stores the caller's rating (requester on the ticket, an upvoter on the upvote row), recomputes `csatAvgTenths` and `csatCount` over every rating and fires
 * the LOW_CSAT rules. Runs in the caller's transaction.
 */
async function applyRating(
  ctx: Ctx,
  id: number,
  types: CallerTypes,
  score: number,
  comment: string | undefined,
  t: Transaction,
): Promise<{ score: number; csatAvg: number; csatCount: number }> {
  const societyId = societyIdOf(ctx);
  await assertFeature(ctx, ENT.csat);
  const ticket = await lockTicket(societyId, id, t);
  if (ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED')
    throw new AppError(409, ERR.invalidState, 'A request can be rated after it is resolved');
  const days = await setting<number>(societyId, SETTING.reopenWindowDays);
  if (!ticket.resolvedAt || now().getTime() > ticket.resolvedAt.getTime() + days * DAY)
    throw new UnprocessableError(
      ERR.ratingWindowExpired,
      `A request can be rated for ${days} days after it is resolved`,
    );
  const userId = ctx.user!.id;
  const at = now();
  const text = comment?.trim() || null;
  if (types.has('REQUESTER')) {
    ticket.csatScore = score;
    ticket.csatComment = text;
    ticket.csatAt = at;
  } else if (ticket.kind === 'BUILDING' && types.has('UPVOTER')) {
    const up = await TicketUpvote.findOne({
      where: { ticketId: id, userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!up) throw new UnprocessableError(ERR.ratingNotAllowed, 'You cannot rate this request');
    up.csatScore = score;
    up.csatComment = text;
    up.csatAt = at;
    await up.save({ transaction: t });
  } else
    throw new UnprocessableError(ERR.ratingNotAllowed, 'Only the person who raised this request can rate it');
  const scores: number[] = [];
  if (ticket.csatScore !== null) scores.push(ticket.csatScore);
  const ups = await TicketUpvote.findAll({
    where: { ticketId: id, csatScore: { [Op.ne]: null } },
    attributes: ['csatScore'],
    transaction: t,
  });
  for (const u of ups) if (u.csatScore !== null) scores.push(u.csatScore);
  ticket.csatCount = scores.length;
  ticket.csatAvgTenths = scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10)
    : null;
  ticket.version += 1;
  ticket.lastActivityAt = at;
  await ticket.save({ transaction: t });
  await addTimeline(
    societyId,
    id,
    residentActor(ctx, types),
    { kind: 'RATING', visibility: 'INTERNAL', body: `Rated ${score} of 5`, metadata: { score } },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.rated,
      entityType: ENTITY.ticket,
      entityId: id,
      entityLabel: ticket.ticketNo,
      after: { score, commentLength: text?.length ?? 0 },
      societyId,
    },
    t,
  );
  await fireLowCsat(ctx, id, score, t);
  emitTicketChanged(t, ticket, { event: 'RATED', actorUserId: userId, data: { score } });
  return { score, csatAvg: (ticket.csatAvgTenths ?? 0) / 10, csatCount: ticket.csatCount };
}

export async function rateMine(ctx: Ctx, id: number, b: { score: number; comment?: string }) {
  const visible = await loadVisibleTicket(ctx, id);
  return sequelize.transaction(async t =>
    applyRating(ctx, id, await typesFor(ctx, visible, t), b.score, b.comment, t),
  );
}

// ------------------------------------------------------------------ confirm (BR-15-40, BR-15-57)
export async function confirmMine(
  ctx: Ctx,
  id: number,
  b: { version: number; score?: number; comment?: string },
) {
  const visible = await loadVisibleTicket(ctx, id);
  await sequelize.transaction(async t => {
    const types = await typesFor(ctx, visible, t);
    if (!anyOf(types, 'REQUESTER', 'UNIT_RESIDENT')) throw denied();
    await transitionTicket(ctx, id, residentActor(ctx, types), { action: 'CLOSE', version: b.version }, t);
    if (b.score !== undefined) await applyRating(ctx, id, types, b.score, b.comment, t);
  });
  return fresh(ctx, id);
}

// ------------------------------------------------------------------ reopen and cancel (BR-15-41, BR-15-42)
export async function reopenMine(ctx: Ctx, id: number, b: { reason: string; version: number }) {
  const visible = await loadVisibleTicket(ctx, id);
  await sequelize.transaction(async t => {
    const types = await typesFor(ctx, visible, t);
    if (!anyOf(types, 'REQUESTER', 'UNIT_RESIDENT', 'UPVOTER')) throw denied();
    await transitionTicket(
      ctx,
      id,
      residentActor(ctx, types),
      { action: 'REOPEN', reason: b.reason, version: b.version },
      t,
    );
  });
  return fresh(ctx, id);
}

export async function cancelMine(ctx: Ctx, id: number, b: { reason: string; version: number }) {
  const visible = await loadVisibleTicket(ctx, id);
  await sequelize.transaction(async t => {
    const types = await typesFor(ctx, visible, t);
    if (!types.has('REQUESTER')) throw denied();
    await transitionTicket(
      ctx,
      id,
      residentActor(ctx, types),
      { action: 'CANCEL', reason: b.reason, version: b.version },
      t,
    );
  });
  return fresh(ctx, id);
}

// ------------------------------------------------------------------ escalate (BR-15-58)
export async function escalateMine(ctx: Ctx, id: number, b: { reason: string }) {
  const visible = await loadVisibleTicket(ctx, id);
  const societyId = societyIdOf(ctx);
  const at = await sequelize.transaction(async t => {
    const types = await typesFor(ctx, visible, t);
    if (!anyOf(types, 'REQUESTER', 'UNIT_RESIDENT', 'UPVOTER')) throw denied();
    await fireResidentRequest(ctx, id, t);
    const row = (await Ticket.findOne({ where: { id, societyId }, transaction: t }))!;
    await addTimeline(
      societyId,
      id,
      residentActor(ctx, types),
      { kind: 'SYSTEM', visibility: 'INTERNAL', body: `Resident asked for escalation: ${b.reason.trim()}` },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT.escalated,
        entityType: ENTITY.ticket,
        entityId: id,
        entityLabel: row.ticketNo,
        after: { source: 'RESIDENT_REQUEST' },
        reason: b.reason.trim(),
        societyId,
      },
      t,
    );
    return row.lastResidentEscalationAt!;
  });
  return { escalationRequestedAt: at.toISOString() };
}

// ------------------------------------------------------------------ estimate decision (BR-15-55)
export async function decideEstimateMine(
  ctx: Ctx,
  id: number,
  b: { decision: 'APPROVE' | 'REJECT'; comment?: string; version: number },
) {
  const visible = await loadVisibleTicket(ctx, id);
  const societyId = societyIdOf(ctx);
  const userId = ctx.user!.id;
  await sequelize.transaction(async t => {
    const types = await typesFor(ctx, visible, t);
    const ticket = await lockTicket(societyId, id, t, b.version);
    if (
      ticket.kind !== 'PERSONAL' ||
      ticket.status !== 'WAITING_ON_RESIDENT' ||
      ticket.waitingReason !== 'ESTIMATE_APPROVAL' ||
      ticket.chargeStatus !== 'ESTIMATE_SENT'
    )
      throw new AppError(409, ERR.invalidState, 'There is no estimate waiting for a decision');
    const links = await residents.getActiveUnitLinks(societyId, userId);
    const rel = links.find(l => l.unitId === ticket.unitId)?.relation;
    if (rel !== 'OWNER' && rel !== 'TENANT')
      throw new ForbiddenError(
        ERR.estimateApproverNotAllowed,
        'Only an owner or tenant of the flat can decide an estimate',
      );
    const approve = b.decision === 'APPROVE';
    const at = now();
    ticket.chargeStatus = approve ? 'APPROVED' : 'REJECTED';
    ticket.chargeDecidedByUserId = userId;
    ticket.chargeDecidedAt = at;
    await ticket.save({ transaction: t });
    await addTimeline(
      societyId,
      id,
      residentActor(ctx, types),
      {
        kind: 'ESTIMATE',
        body: `Estimate ${approve ? 'approved' : 'rejected'}${b.comment?.trim() ? `: ${b.comment.trim()}` : ''}`,
        metadata: { decision: b.decision, estimatePaise: Number(ticket.chargeEstimatePaise) },
      },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT.estimateDecided,
        entityType: ENTITY.ticket,
        entityId: id,
        entityLabel: ticket.ticketNo,
        after: { decision: b.decision, estimatePaise: Number(ticket.chargeEstimatePaise) },
        societyId,
      },
      t,
    );
    // both decisions resume the work (the decision, not a comment, ends ESTIMATE_APPROVAL; 6.5)
    await transitionTicket(
      ctx,
      id,
      systemActor(ctx),
      { action: 'RESUME', note: `Estimate ${approve ? 'approved' : 'rejected'}` },
      t,
    );
    const done = (await Ticket.findOne({ where: { id, societyId }, transaction: t }))!;
    emitTicketChanged(t, done, { event: 'ESTIMATE', actorUserId: userId, data: { decision: b.decision } });
  });
  return fresh(ctx, id);
}
