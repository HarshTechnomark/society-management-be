import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { Ticket, TicketUpvote } from '../../models';
import { AppError, ForbiddenError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { units } from '../society-setup/society-setup.public';
import { ERR, type CallerType } from './helpdesk.constants';
import { residentVisibleWhere } from './helpdesk.visibility';
import { notFound, societyIdOf, userActor } from './helpdesk.shared';
import type { Actor, CallerTypes } from './helpdesk.types';

/** Resident side of BR-15-50: who the caller is for a ticket, which tickets they can open, and the suspended-society rule (BR-15-66). */

/** The caller types of a resident for this ticket (6.2): REQUESTER, UNIT_RESIDENT (personal), UPVOTER (building). */
export function residentTypes(ctx: Ctx, t: Ticket, upvoted: boolean): CallerTypes {
  const s = new Set<CallerType>();
  if (ctx.user && t.requesterUserId === ctx.user.id) s.add('REQUESTER');
  if (t.kind === 'PERSONAL' && t.unitId !== null && (ctx.unitIds ?? []).includes(t.unitId))
    s.add('UNIT_RESIDENT');
  if (t.kind === 'BUILDING' && upvoted) s.add('UPVOTER');
  return s;
}

export const hasUpvoted = async (ticketId: number, userId: number, tx?: Transaction): Promise<boolean> =>
  (await TicketUpvote.count({ where: { ticketId, userId }, transaction: tx })) > 0;

export const residentActor = (ctx: Ctx, types: CallerTypes): Actor => userActor(ctx, types, 'RESIDENT');

/** Opens a ticket the resident may see (BR-15-50), else `404 TICKET_NOT_FOUND`. Plain read, no lock. */
export async function loadVisibleTicket(ctx: Ctx, ticketId: number, tx?: Transaction): Promise<Ticket> {
  const where = await residentVisibleWhere(ctx);
  const row = await Ticket.findOne({ where: { [Op.and]: [where, { id: ticketId }] }, transaction: tx });
  if (!row) throw notFound();
  return row;
}

/** The caller's types for a visible ticket (loads the upvote row). */
export async function typesFor(ctx: Ctx, t: Ticket, tx?: Transaction): Promise<CallerTypes> {
  return residentTypes(ctx, t, ctx.user ? await hasUpvoted(t.id, ctx.user.id, tx) : false);
}

export const denied = (): AppError => new ForbiddenError(ERR.permissionDenied);

/** BR-15-66: while the society is SUSPENDED the shared comment and upvote routes serve building issues only. */
export function assertWritableWhenSuspended(ctx: Ctx, t: Ticket): void {
  if (ctx.society?.status === 'SUSPENDED' && t.kind !== 'BUILDING')
    throw new AppError(423, ERR.societySuspended, 'This society is suspended. You can only view it.');
}

/**
 * Building issues that concern the caller without the public board (8.24 `scope = NEAR_ME`, BR-15-50): raised or upvoted by the caller, or affecting
 * one of the caller's units (SOCIETY level, same building, or same building and floor).
 */
export async function nearMeWhere(ctx: Ctx): Promise<WhereOptions> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user?.id ?? 0;
  const unitIds = ctx.unitIds ?? [];
  const mine = unitIds.length ? await units.listActive(societyId, { unitIds }) : [];
  const buildingIds = [...new Set(mine.map(u => u.buildingId))];
  const upvoted = (
    await TicketUpvote.findAll({ where: { societyId, userId }, attributes: ['ticketId'] })
  ).map(r => r.ticketId);
  const or: WhereOptions[] = [{ requesterUserId: userId }, { affectedLevel: 'SOCIETY' }];
  if (upvoted.length) or.push({ id: { [Op.in]: upvoted } });
  if (buildingIds.length)
    or.push({ affectedLevel: 'BUILDING', affectedBuildingId: { [Op.in]: buildingIds } });
  for (const u of mine)
    or.push({ affectedLevel: 'FLOOR', affectedBuildingId: u.buildingId, affectedFloor: u.floor });
  return { societyId, kind: 'BUILDING', [Op.or]: or };
}
