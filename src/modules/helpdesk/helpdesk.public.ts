/**
 * The module 15 functions other modules may import (sections 8.29, 8.30, 8.31) and the start-up hook `registerHelpdesk()`. The creation, transition,
 * assignment, merge, upvote and comment core is real; functions marked "part" throw `501 NOT_IMPLEMENTED_IN_FOUNDATION` until their part fills the body
 * (see README). Other modules reach tickets only through this file.
 */
import { Op } from 'sequelize';
import { Ticket, TicketAssignment, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { registerQueue } from '../../lib/queue';
import type { Ctx, SystemCtx } from '../../types/context';
import { registerExportProvider, registerPurgeHandler } from '../societies/societies.public';
import { units } from '../society-setup/society-setup.public';
import {
  AUDIT,
  ENTITY,
  HELPDESK_QUEUE,
  NON_TERMINAL,
  type AssigneeType,
  type Priority,
  type TicketKind,
  type TicketStatus,
} from './helpdesk.constants';
import { helpdeskExportProvider } from './helpdesk.exports';
import { registerHelpdeskJobs } from './helpdesk.jobs';
import { assertHelpdeskPortsReady } from './helpdesk.ports';
import { PURGE_TABLES, purgeHelpdesk } from './helpdesk.purge';
import { endCurrentAssignment } from './helpdesk.routing';
import { backfillHelpdesk, ensureSeeded } from './helpdesk.seed';
import { addTimeline, lockTicket, systemActor } from './helpdesk.shared';
import { createInternal, getFacts } from './helpdesk.admin.internal';
import { reportFunctions } from './helpdesk.admin.reports';
import { workFunctions } from './helpdesk.admin.work';
import { transitionTicket } from './helpdesk.tickets.transition';
import { recomputeNextCheck } from './helpdesk.escalation';
import { calendarFor, endPause } from './helpdesk.sla';

export { setHelpdeskPorts } from './helpdesk.ports';
export type { HelpdeskPorts } from './helpdesk.ports';
export { onTicketEvent } from './helpdesk.shared';
export type { TicketEvent } from './helpdesk.shared';
export { createTicket } from './helpdesk.tickets.core';
export { transitionTicket } from './helpdesk.tickets.transition';
export { assignTicket, unassignTicket } from './helpdesk.routing';
export { mergeTickets } from './helpdesk.tickets.merge';
export { addUpvote, removeUpvote } from './helpdesk.tickets.upvote';
export { addComment, removeComment } from './helpdesk.tickets.comment';
export { evaluateTicketSla, fireResidentRequest, fireLowCsat } from './helpdesk.escalation';
export type { CreateTicketInput, CreatedTicket, TransitionInput } from './helpdesk.types';

/** `helpdesk.ensureSeeded(societyId, t)` (BR-15-65), also called by module 08's go-live. */
export const helpdesk = { ensureSeeded, backfill: backfillHelpdesk };

/**
 * 8.29 hooks called by module 21 (work orders). Both are idempotent: they do nothing unless the ticket's CURRENT assignment has that `workOrderId`.
 * Completed: RESOLVE as system (the after-photo rule is skipped; module 21 holds the photos) from ASSIGNED, IN_PROGRESS or WAITING_ON_RESIDENT (an
 * ASSIGNED ticket is started first); otherwise only a SYSTEM entry. Cancelled: the assignment ends WORK_ORDER_CANCELLED and the ticket returns to OPEN.
 */
export const helpdeskHooks = {
  async onWorkOrderCompleted(
    ctx: Ctx | SystemCtx,
    input: { ticketId: number; workOrderId: number; note: string },
    t: import('sequelize').Transaction,
  ): Promise<void> {
    const societyId =
      (ctx as Ctx).society?.id ??
      (await Ticket.findByPk(input.ticketId, { attributes: ['societyId'], transaction: t }))?.societyId;
    if (!societyId) return;
    const c: Ctx = {
      ...ctx,
      society: (ctx as Ctx).society ?? {
        id: societyId,
        name: '',
        status: 'ACTIVE',
        timezone: 'Asia/Kolkata',
        planKey: '',
      },
    };
    const ticket = await lockTicket(societyId, input.ticketId, t);
    const asg = await TicketAssignment.findOne({
      where: { ticketId: ticket.id, endedAt: null, workOrderId: input.workOrderId },
      transaction: t,
    });
    const actor = systemActor(c);
    if (!asg || !['ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_RESIDENT'].includes(ticket.status)) {
      await addTimeline(
        societyId,
        ticket.id,
        actor,
        {
          kind: 'SYSTEM',
          visibility: 'INTERNAL',
          body: `Work order ${input.workOrderId} completed: ${input.note}`,
        },
        t,
      );
      return;
    }
    if (ticket.status === 'ASSIGNED') await transitionTicket(c, ticket.id, actor, { action: 'START' }, t);
    await transitionTicket(
      c,
      ticket.id,
      actor,
      { action: 'RESOLVE', note: `Work order completed: ${input.note}`.slice(0, 2000) },
      t,
    );
  },
  async onWorkOrderCancelled(
    ctx: Ctx | SystemCtx,
    input: { ticketId: number; workOrderId: number; reason: string },
    t: import('sequelize').Transaction,
  ): Promise<void> {
    const societyId =
      (ctx as Ctx).society?.id ??
      (await Ticket.findByPk(input.ticketId, { attributes: ['societyId'], transaction: t }))?.societyId;
    if (!societyId) return;
    const c: Ctx = {
      ...ctx,
      society: (ctx as Ctx).society ?? {
        id: societyId,
        name: '',
        status: 'ACTIVE',
        timezone: 'Asia/Kolkata',
        planKey: '',
      },
    };
    const ticket = await lockTicket(societyId, input.ticketId, t);
    const asg = await TicketAssignment.findOne({
      where: { ticketId: ticket.id, endedAt: null, workOrderId: input.workOrderId },
      transaction: t,
    });
    if (!asg || !['ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_RESIDENT'].includes(ticket.status)) return;
    if (ticket.status === 'WAITING_ON_RESIDENT' && ticket.slaPausedAt) {
      const r = await endPause(
        { ...ticket.get(), slaPausedAt: ticket.slaPausedAt } as never,
        new Date(),
        await calendarFor(societyId, ticket.slaCalendar),
      );
      ticket.slaPausedMinutes = r.slaPausedMinutes;
      ticket.resolutionDueAt = r.resolutionDueAt;
      ticket.slaPausedAt = null;
      ticket.waitingReason = null;
      ticket.waitingReminderSentAt = null;
    }
    const from = ticket.status;
    await endCurrentAssignment(c, ticket, 'WORK_ORDER_CANCELLED', t);
    ticket.status = 'OPEN';
    ticket.version += 1;
    await recomputeNextCheck(ticket, t);
    await ticket.save({ transaction: t });
    const actor = systemActor(c);
    await addTimeline(
      societyId,
      ticket.id,
      actor,
      {
        kind: 'STATUS_CHANGE',
        fromStatus: from,
        toStatus: 'OPEN',
        body: `Work order cancelled: ${input.reason}`.slice(0, 2000),
      },
      t,
    );
    await audit(
      c,
      {
        action: AUDIT.statusChanged,
        entityType: ENTITY.ticket,
        entityId: ticket.id,
        entityLabel: ticket.ticketNo,
        before: { status: from },
        after: { status: 'OPEN' },
        societyId,
      },
      t,
    );
  },
};

// ------------------------------------------------------------------ 8.30 staff app, 8.31 readers (part 15.2)
export const helpdeskWork = workFunctions;

export const helpdeskReports = {
  summary: reportFunctions.summary,
  openCounts: async (
    societyId: number,
  ): Promise<{ open: number; p1: number; unassigned: number; breached: number; buildingOpen: number }> => {
    const open = { societyId, status: { [Op.in]: [...NON_TERMINAL] } };
    const [o, p1, unassigned, breached, buildingOpen] = await Promise.all([
      Ticket.count({ where: open }),
      Ticket.count({ where: { ...open, priority: 'P1' } }),
      Ticket.count({ where: { societyId, status: { [Op.in]: ['OPEN', 'REOPENED'] } } }),
      Ticket.count({
        where: { ...open, [Op.or]: [{ responseBreached: true }, { resolutionBreached: true }] },
      }),
      Ticket.count({ where: { ...open, kind: 'BUILDING' } }),
    ]);
    return { open: o, p1, unassigned, breached, buildingOpen };
  },
  monthly: reportFunctions.monthly,
  recurring: reportFunctions.recurring,
  assigneeProductivity: reportFunctions.assigneeProductivity,
  openBuildingIssuesForUnits: reportFunctions.openBuildingIssuesForUnits,
};

/** Module 17 and 30 readers (8.31): `get` is real (no description, no personal data); `createInternal` and `getFacts` are filled by 15.2. */
export const tickets = {
  async get(
    societyId: number,
    ticketId: number,
  ): Promise<{
    id: number;
    ticketNo: string;
    kind: TicketKind;
    title: string;
    status: TicketStatus;
    priority: Priority;
  } | null> {
    const t = await Ticket.findOne({
      where: { id: ticketId, societyId },
      attributes: ['id', 'ticketNo', 'kind', 'title', 'status', 'priority'],
    });
    return t
      ? {
          id: t.id,
          ticketNo: t.ticketNo,
          kind: t.kind,
          title: t.title,
          status: t.status,
          priority: t.priority,
        }
      : null;
  },
  createInternal,
  getFacts,
};

/** The module 08 unit guard (9.2): archiving or deleting a unit with non-terminal PERSONAL tickets returns `HELPDESK_OPEN_TICKETS`. */
export async function unitHasOpenTickets(
  societyId: number,
  unitId: number,
  t?: import('sequelize').Transaction,
): Promise<string | null> {
  const n = await Ticket.count({
    where: { societyId, unitId, kind: 'PERSONAL', status: { [Op.in]: [...NON_TERMINAL, 'RESOLVED'] } },
    transaction: t,
  });
  return n ? 'HELPDESK_OPEN_TICKETS' : null;
}

export type { AssigneeType };
void sequelize;

/**
 * Start-up hook (call after `registerSocieties()`, `registerSocietySetup()`, `registerResidents()` and `registerAccounts()`; done in `server.ts`, `worker.ts`
 * and `npm run seed`): the production check of the placeholder ports, module 05 export provider and purge handler (order 150), the unit guard of module 08,
 * the `helpdesk` queue and its jobs.
 */
export function registerHelpdesk(): void {
  assertHelpdeskPortsReady();
  registerExportProvider(helpdeskExportProvider);
  registerPurgeHandler({ module: 'helpdesk', order: 150, tables: PURGE_TABLES, purge: purgeHelpdesk });
  units.registerUnitGuard({
    module: 'helpdesk',
    check: (societyId, unitId, _action, t) => unitHasOpenTickets(societyId, unitId, t),
  });
  registerQueue(HELPDESK_QUEUE, 'Helpdesk: SLA sweep, escalation, auto-close, reminders, fan-out, digest', 5);
  registerHelpdeskJobs();
}
