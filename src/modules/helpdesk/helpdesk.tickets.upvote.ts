import { type Transaction } from 'sequelize';
import { TicketUpvote } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { AUDIT, ENT, ENTITY, ERR, NON_TERMINAL, SETTING } from './helpdesk.constants';
import { recomputeSla } from './helpdesk.tickets.transition';
import { upvoteRaise } from './helpdesk.rules';
import {
  addTimeline,
  emitTicketChanged,
  lockTicket,
  setting,
  societyIdOf,
  systemActor,
} from './helpdesk.shared';
import { residentCanSee } from './helpdesk.visibility';

const OPEN = NON_TERMINAL as readonly string[];

/**
 * BR-15-20 Me too: BUILDING tickets only, open statuses, visible to the caller (BR-15-50), not the requester, one per user. The ticket row is locked and
 * `upvoteCount` incremented in the same transaction; BR-15-38 may raise the priority once (`helpdesk.me_too_upvotes`, Standard).
 */
export async function addUpvote(
  ctx: Ctx,
  ticketId: number,
  input: { note?: string },
  t: Transaction,
): Promise<{ upvoteCount: number; priorityRaised: boolean }> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user?.id;
  if (!userId) throw new Error('addUpvote needs a signed-in user');
  const ticket = await lockTicket(societyId, ticketId, t);
  if (!(await residentCanSee(ctx, ticketId))) throw new NotFoundError(ERR.ticketNotFound, 'Ticket not found');
  if (ticket.kind !== 'BUILDING')
    throw new UnprocessableError(ERR.upvoteNotBuildingIssue, 'Only building issues can be upvoted');
  if (!OPEN.includes(ticket.status))
    throw new AppError(409, ERR.invalidState, 'This issue is no longer open');
  if (ticket.requesterUserId === userId)
    throw new UnprocessableError(ERR.upvoteOwnTicket, 'You reported this issue yourself');
  if (await TicketUpvote.count({ where: { ticketId, userId }, transaction: t }))
    throw new AppError(409, ERR.alreadyUpvoted, 'You already agreed with this issue');
  await TicketUpvote.create(
    {
      societyId,
      ticketId,
      userId,
      unitId: (ctx.unitIds ?? [])[0] ?? null,
      source: 'ME_TOO',
      note: input.note?.trim() || null,
      createdBy: userId,
    },
    { transaction: t },
  );
  ticket.upvoteCount = await TicketUpvote.count({ where: { ticketId }, transaction: t });
  const at = now();
  let raised = false;
  const next = upvoteRaise({
    upvoteCount: ticket.upvoteCount,
    priority: ticket.priority,
    priorityAutoRaisedAt: ticket.priorityAutoRaisedAt,
    threshold: await setting<number>(societyId, SETTING.upvoteRaiseThreshold),
    featureOn: await isFeatureOn(societyId, ENT.meTooUpvotes),
  });
  if (next) {
    const was = ticket.priority;
    ticket.priority = next;
    ticket.prioritySource = 'AUTO_UPVOTES';
    ticket.priorityAutoRaisedAt = at;
    await recomputeSla(ticket, t);
    await addTimeline(
      societyId,
      ticketId,
      systemActor(ctx),
      {
        kind: 'PRIORITY_CHANGE',
        body: `Priority raised from ${was} to ${next} by upvotes`,
        metadata: { from: was, to: next },
      },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT.priorityChanged,
        entityType: ENTITY.ticket,
        entityId: ticketId,
        entityLabel: ticket.ticketNo,
        before: { priority: was },
        after: { priority: next, source: 'AUTO_UPVOTES' },
        societyId,
      },
      t,
    );
    raised = true;
  }
  ticket.lastActivityAt = at;
  ticket.version += 1;
  await ticket.save({ transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT.upvoteAdded,
      entityType: ENTITY.ticket,
      entityId: ticketId,
      entityLabel: ticket.ticketNo,
      societyId,
    },
    t,
  );
  emitTicketChanged(t, ticket, { event: 'UPVOTE', actorUserId: userId });
  return { upvoteCount: ticket.upvoteCount, priorityRaised: raised };
}

/** Removing a Me too is allowed in the same statuses (hard delete; the count is recomputed with COUNT(*)). */
export async function removeUpvote(
  ctx: Ctx,
  ticketId: number,
  t: Transaction,
): Promise<{ upvoteCount: number }> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user?.id;
  if (!userId) throw new Error('removeUpvote needs a signed-in user');
  const ticket = await lockTicket(societyId, ticketId, t);
  if (ticket.kind !== 'BUILDING')
    throw new UnprocessableError(ERR.upvoteNotBuildingIssue, 'Only building issues can be upvoted');
  if (!OPEN.includes(ticket.status))
    throw new AppError(409, ERR.invalidState, 'This issue is no longer open');
  const row = await TicketUpvote.findOne({ where: { ticketId, userId, source: 'ME_TOO' }, transaction: t });
  if (!row) throw new NotFoundError(ERR.upvoteNotFound, 'You have not agreed with this issue');
  await row.destroy({ transaction: t });
  ticket.upvoteCount = await TicketUpvote.count({ where: { ticketId }, transaction: t });
  ticket.version += 1;
  await ticket.save({ transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT.upvoteRemoved,
      entityType: ENTITY.ticket,
      entityId: ticketId,
      entityLabel: ticket.ticketNo,
      societyId,
    },
    t,
  );
  emitTicketChanged(t, ticket, { event: 'UPVOTE', actorUserId: userId });
  return { upvoteCount: ticket.upvoteCount };
}
