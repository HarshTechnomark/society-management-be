import type { Transaction } from 'sequelize';
import { Ticket } from '../../models';
import { now } from '../../lib/clock';
import { AppError, UnprocessableError } from '../../utils/errors';
import type { Ctx, SystemCtx } from '../../types/context';
import { usersWithPermission } from '../access-control/access-control.public';
import { locations, units } from '../society-setup/society-setup.public';
import { ERR, NON_TERMINAL, PERM, type Priority, type TicketKind } from './helpdesk.constants';
import { recomputeNextCheck } from './helpdesk.escalation';
import { assignTicket } from './helpdesk.routing';
import { userActor } from './helpdesk.shared';
import { createTicket } from './helpdesk.tickets.core';

/** Module 17 and 30 entry points of `tickets` (8.31): `createInternal` and `getFacts`. */

/**
 * BUILDING ticket with channel SYSTEM for module 30 automation. Without a signed-in user the ticket is raised in the name of the first holder of
 * `helpdesk.tickets.create` (raisedBy is required) with the requester name "System". Without `locationNodeId` the first root location is used. The assignee is
 * best effort (a failed eligibility check keeps the automatic assignment); `dueInDays` moves the resolution due time.
 */
export async function createInternal(
  ctx: Ctx | SystemCtx,
  input: {
    title: string;
    description: string;
    categoryId: number;
    priority: Priority;
    locationNodeId?: number;
    assigneeUserId?: number;
    dueInDays?: number;
  },
  t: Transaction,
): Promise<{ ticketId: number; ticketNo: string }> {
  const societyId = (ctx as Ctx).society?.id;
  if (!societyId) throw new Error('tickets.createInternal needs a society in the context');
  let c = ctx as Ctx;
  if (!c.user) {
    const [raiser] = await usersWithPermission(societyId, PERM.ticketsCreate);
    if (!raiser) throw new UnprocessableError(ERR.internal, 'No one can raise tickets in this society');
    c = {
      ...c,
      user: { id: raiser, name: 'System', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
      actorRoleKey: 'system',
    };
  }
  let nodeId = input.locationNodeId;
  if (!nodeId) {
    const tree = await locations.listTree(societyId, { rootOnly: true });
    nodeId = (tree.find(n => !n.buildingId) ?? tree[0])?.id;
    if (!nodeId) throw new AppError(404, ERR.locationNotFound, 'Location not found');
  }
  const created = await createTicket(
    c,
    {
      kind: 'BUILDING' as TicketKind,
      categoryId: input.categoryId,
      locationNodeId: nodeId,
      title: input.title,
      description: input.description,
      priority: input.priority,
      channel: 'SYSTEM',
      reporterRole: 'OFFICE',
      requesterUserId: null,
      requesterName: 'System',
      duplicateReason: 'Created by an automation rule',
    },
    t,
  );
  if (input.assigneeUserId)
    try {
      await assignTicket(
        c,
        created.id,
        userActor(c, new Set(['ADMIN']), 'ADMIN'),
        { type: 'MEMBER', userId: input.assigneeUserId },
        t,
      );
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  if (input.dueInDays) {
    const tk = await Ticket.findByPk(created.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (tk) {
      tk.resolutionDueAt = new Date(
        Math.max(now().getTime() + 60_000, now().getTime() + input.dueInDays * 86_400_000),
      );
      await recomputeNextCheck(tk, t);
      await tk.save({ transaction: t });
    }
  }
  return { ticketId: created.id, ticketNo: created.ticketNo };
}

export async function getFacts(societyId: number, ticketId: number) {
  const t = await Ticket.findOne({ where: { id: ticketId, societyId } });
  if (!t) return null;
  const open = (NON_TERMINAL as readonly string[]).includes(t.status);
  let label: string | null = null;
  if (t.kind === 'PERSONAL' && t.unitId) label = (await units.get(societyId, t.unitId))?.label ?? null;
  else if (t.locationNodeId) label = (await locations.get(societyId, t.locationNodeId))?.pathLabel ?? null;
  return {
    ticketNo: t.ticketNo,
    title: t.title,
    priority: t.priority,
    kind: t.kind,
    categoryId: t.categoryId,
    channel: t.channel,
    isAssigned: t.currentAssignmentId !== null,
    unitId: t.unitId,
    locationNodeId: t.locationNodeId,
    locationLabel: label,
    hoursOverdue: open
      ? Math.max(0, Math.floor((now().getTime() - t.resolutionDueAt.getTime()) / 3_600_000))
      : 0,
  };
}
