import { Op, type WhereOptions } from 'sequelize';
import { Ticket, TicketAssignment, TicketComment, TicketUpvote } from '../../models';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { units } from '../society-setup/society-setup.public';
import { ENT, LIMITS } from './helpdesk.constants';
import { helpdeskPorts } from './helpdesk.ports';
import { societyIdOf } from './helpdesk.shared';

/** Who may see which ticket and comment (BR-15-50, BR-15-51, BR-15-53). Enforced in the query layer, not only in the DTO mappers. */

const DAY = 86_400_000;

/**
 * BR-15-50 as a `where` for `Ticket.findAll`: a PERSONAL ticket only when its unit is one of the caller's units; a BUILDING ticket when the caller is
 * its requester or an upvoter, or it affects one of the caller's units (SOCIETY level; BUILDING level with the same building; FLOOR level with the same
 * building and floor), or the society has the public board (all building issues, resolved ones for 90 days).
 */
export async function residentVisibleWhere(ctx: Ctx): Promise<WhereOptions> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user?.id ?? 0;
  const unitIds = ctx.unitIds ?? [];
  const mine = unitIds.length ? await units.listActive(societyId, { unitIds }) : [];
  const buildingIds = [...new Set(mine.map(u => u.buildingId))];
  const upvoted = (
    await TicketUpvote.findAll({ where: { societyId, userId }, attributes: ['ticketId'] })
  ).map(r => r.ticketId);
  const board = await isFeatureOn(societyId, ENT.communityBoard);
  const or: WhereOptions[] = [];
  if (unitIds.length) or.push({ kind: 'PERSONAL', unitId: { [Op.in]: unitIds } });
  const building: WhereOptions[] = [{ requesterUserId: userId }, { affectedLevel: 'SOCIETY' }];
  if (upvoted.length) building.push({ id: { [Op.in]: upvoted } });
  if (buildingIds.length)
    building.push({ affectedLevel: 'BUILDING', affectedBuildingId: { [Op.in]: buildingIds } });
  for (const u of mine)
    building.push({ affectedLevel: 'FLOOR', affectedBuildingId: u.buildingId, affectedFloor: u.floor });
  or.push({ kind: 'BUILDING', [Op.or]: building });
  if (board)
    or.push({
      kind: 'BUILDING',
      [Op.or]: [{ resolvedAt: null }, { resolvedAt: { [Op.gte]: new Date(now().getTime() - 90 * DAY) } }],
    });
  return { societyId, [Op.or]: or };
}

/** True when the ticket passes `residentVisibleWhere` (other tickets are `404 TICKET_NOT_FOUND` to the caller). */
export async function residentCanSee(ctx: Ctx, ticketId: number): Promise<boolean> {
  const where = await residentVisibleWhere(ctx);
  return (await Ticket.count({ where: { [Op.and]: [where, { id: ticketId }] } })) > 0;
}

/**
 * BR-15-53 work visibility as a `where`: the ticket's CURRENT assignment is the caller's (member or staff user, or a vendor the user acts for),
 * not CANCELLED, and CLOSED only within 7 days of `closedAt`. Access ends the moment the assignment ends because the assignment must be current.
 */
export async function workVisibleWhere(ctx: Ctx): Promise<WhereOptions> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user?.id ?? 0;
  const vendorIds = userId ? await helpdeskPorts().vendors.vendorIdsForUser(societyId, userId) : [];
  const asg = await TicketAssignment.findAll({
    where: {
      societyId,
      endedAt: null,
      [Op.or]: [
        { assigneeUserId: userId },
        ...(vendorIds.length ? [{ vendorId: { [Op.in]: vendorIds } }] : []),
      ],
    },
    attributes: ['ticketId'],
  });
  const ids = asg.map(a => a.ticketId);
  return {
    societyId,
    id: { [Op.in]: ids.length ? ids : [0] },
    status: { [Op.ne]: 'CANCELLED' },
    [Op.or]: [
      { status: { [Op.ne]: 'CLOSED' } },
      { closedAt: { [Op.gte]: new Date(now().getTime() - LIMITS.workDoneVisibleDays * DAY) } },
    ],
  };
}

export type CommentAudience = 'ADMIN' | 'STAFF' | 'RESIDENT' | 'VENDOR';

/**
 * BR-15-51: the comment filter of an audience. Residents and vendors get `visibility = 'PUBLIC'` in the WHERE clause (never filtered afterwards), so
 * INTERNAL notes, ESCALATION entries and internal SYSTEM entries cannot leak; removed comments (`deletedAt`) are excluded for everyone but admins.
 */
export function commentWhere(audience: CommentAudience): WhereOptions {
  return audience === 'RESIDENT' || audience === 'VENDOR' ? { visibility: 'PUBLIC' } : {};
}

export async function visibleComments(ticketId: number, audience: CommentAudience): Promise<TicketComment[]> {
  return TicketComment.findAll({
    where: { ticketId, ...commentWhere(audience) },
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
    paranoid: audience !== 'ADMIN',
  });
}

/** Internal file download check (T15-20): a file of a comment is served to residents and vendors only when its comment is PUBLIC and not removed. */
export async function fileVisibleToAudience(commentId: number, audience: CommentAudience): Promise<boolean> {
  return (await TicketComment.count({ where: { id: commentId, ...commentWhere(audience) } })) > 0;
}
