import { Op, type Transaction } from 'sequelize';
import { Ticket, TicketUpvote } from '../../models';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY, ERR, NON_TERMINAL } from './helpdesk.constants';
import { addTimeline, emitTicketChanged, lockTicket, notFound, societyIdOf } from './helpdesk.shared';
import { transitionTicket } from './helpdesk.tickets.transition';
import type { Actor } from './helpdesk.types';

const OPEN = NON_TERMINAL as readonly string[];

/**
 * BR-15-21 and BR-15-22: merges the duplicate (`duplicateId`) into the primary. Both rows are locked in ascending id order. Upvotes of the duplicate move to
 * the primary unless the user already upvoted it or is its requester (deleted); the duplicate's requester becomes a MERGE upvoter of the primary (same
 * exceptions); the primary's `upvoteCount` is recomputed; the duplicate's assignment ends MERGED and it becomes CANCELLED with `mergedIntoTicketId`.
 */
export async function mergeTickets(
  ctx: Ctx,
  duplicateId: number,
  intoTicketId: number,
  actor: Actor,
  input: { note?: string; version?: number },
  t: Transaction,
): Promise<{ duplicate: Ticket; primary: Ticket; movedUserIds: number[] }> {
  const societyId = societyIdOf(ctx);
  if (duplicateId === intoTicketId)
    throw new UnprocessableError(ERR.mergeSelf, 'A ticket cannot be merged into itself');
  const [a, b] = duplicateId < intoTicketId ? [duplicateId, intoTicketId] : [intoTicketId, duplicateId];
  const first = await lockTicket(societyId, a, t);
  const second = await lockTicket(societyId, b, t);
  const dup = first.id === duplicateId ? first : second;
  const primary = first.id === duplicateId ? second : first;
  if (input.version !== undefined && dup.version !== input.version)
    throw new AppError(
      409,
      ERR.staleVersion,
      'The ticket was changed by someone else. Reload and try again.',
    );
  const invalid = () => new UnprocessableError(ERR.mergeTargetInvalid, 'These tickets cannot be merged');
  if (primary.kind !== 'BUILDING' || (!OPEN.includes(primary.status) && primary.status !== 'OPEN'))
    throw invalid();
  if (!OPEN.includes(dup.status) || dup.invoiceId || !['NONE', 'REJECTED'].includes(dup.chargeStatus))
    throw invalid();
  if (primary.status === 'RESOLVED' || primary.status === 'CLOSED' || primary.status === 'CANCELLED')
    throw invalid();

  const moved: number[] = [];
  const mine = await TicketUpvote.findAll({ where: { ticketId: dup.id }, transaction: t });
  const onPrimary = new Set(
    (
      await TicketUpvote.findAll({ where: { ticketId: primary.id }, attributes: ['userId'], transaction: t })
    ).map(r => r.userId),
  );
  for (const u of mine) {
    if (onPrimary.has(u.userId) || u.userId === primary.requesterUserId) await u.destroy({ transaction: t });
    else {
      await u.update({ ticketId: primary.id }, { transaction: t });
      onPrimary.add(u.userId);
      moved.push(u.userId);
    }
  }
  const dupRequester = dup.requesterUserId;
  if (dupRequester && !onPrimary.has(dupRequester) && dupRequester !== primary.requesterUserId) {
    await TicketUpvote.create(
      { societyId, ticketId: primary.id, userId: dupRequester, source: 'MERGE', createdBy: actor.userId },
      { transaction: t },
    );
    moved.push(dupRequester);
  }
  primary.upvoteCount = await TicketUpvote.count({ where: { ticketId: primary.id }, transaction: t });
  dup.upvoteCount = await TicketUpvote.count({
    where: { ticketId: dup.id, userId: { [Op.ne]: 0 } },
    transaction: t,
  });

  const cancelled = await transitionTicket(
    ctx,
    dup.id,
    { ...actor, types: new Set([...actor.types, 'ADMIN']) },
    { action: 'CANCEL', reason: `Merged into ${primary.ticketNo}` },
    t,
    { mergedIntoTicketId: primary.id, mergedIntoTicketNo: primary.ticketNo },
  );
  cancelled.upvoteCount = dup.upvoteCount;
  await cancelled.save({ transaction: t });
  primary.version += 1;
  await primary.save({ transaction: t });
  const note = input.note?.trim();
  await addTimeline(
    societyId,
    dup.id,
    actor,
    {
      kind: 'MERGE',
      body: `Merged into ${primary.ticketNo}${note ? `: ${note}` : ''}`,
      metadata: { mergedTicketNo: primary.ticketNo },
    },
    t,
  );
  await addTimeline(
    societyId,
    primary.id,
    actor,
    {
      kind: 'MERGE',
      body: `${dup.ticketNo} was merged into this issue`,
      metadata: { mergedTicketNo: dup.ticketNo },
    },
    t,
  );
  for (const x of [dup, primary])
    await audit(
      ctx,
      {
        action: AUDIT.merged,
        entityType: ENTITY.ticket,
        entityId: x.id,
        entityLabel: x.ticketNo,
        after: { duplicate: dup.ticketNo, primary: primary.ticketNo },
        societyId,
      },
      t,
    );
  emitTicketChanged(t, primary, {
    event: 'MERGED',
    actorUserId: actor.userId,
    data: { movedUserIds: moved },
  });
  if (!cancelled) throw notFound();
  return { duplicate: cancelled, primary, movedUserIds: moved };
}
