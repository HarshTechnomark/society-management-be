import { Op } from 'sequelize';
import { Ticket, TicketAssignment, TicketUpvote } from '../../models';
import { now } from '../../lib/clock';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { members } from '../access-control/access-control.public';
import { NON_TERMINAL, NOTIFY, RT, roomAdmin, roomGate } from './helpdesk.constants';
import { helpdeskPorts } from './helpdesk.ports';
import type { TicketEvent } from './helpdesk.shared';
import { sendTo, ticketData } from './helpdesk.notify';

/** Section 9.4 events that the foundation does not emit (the admin, unit and requester events are sent by `emitTicketChanged`). */

export const COUNTS_DEBOUNCE_MS = 2000;
const timers = new Map<number, NodeJS.Timeout>();

export interface HelpdeskCounts {
  open: number;
  p1: number;
  unassigned: number;
  breached: number;
}

export async function computeCounts(societyId: number): Promise<HelpdeskCounts> {
  const live = { societyId, status: { [Op.in]: [...NON_TERMINAL] } };
  const [open, p1, unassigned, breached] = await Promise.all([
    Ticket.count({ where: live }),
    Ticket.count({ where: { ...live, priority: 'P1' } }),
    Ticket.count({ where: { societyId, status: { [Op.in]: ['OPEN', 'REOPENED'] }, assigneeUserId: null } }),
    Ticket.count({
      where: { ...live, [Op.or]: [{ responseBreached: true }, { resolutionBreached: true }] },
    }),
  ]);
  return { open, p1, unassigned, breached };
}

export async function emitCounts(societyId: number): Promise<HelpdeskCounts> {
  const counts = await computeCounts(societyId);
  emitToRoom(roomAdmin(societyId), RT.countsChanged, { ...counts });
  return counts;
}

/** `helpdesk.counts.changed`, debounced to one event per society per 2 seconds (trailing). */
export function scheduleCounts(societyId: number): void {
  if (timers.has(societyId)) return;
  const h = setTimeout(() => {
    timers.delete(societyId);
    emitCounts(societyId).catch(err => logger.warn({ err, societyId }, 'helpdesk counts emit failed'));
  }, COUNTS_DEBOUNCE_MS);
  h.unref();
  timers.set(societyId, h);
}

/** Test helper: cancel pending debounce timers. */
export function clearCountTimers(): void {
  for (const h of timers.values()) clearTimeout(h);
  timers.clear();
}

/** The user stops being the assignee (unassign, reassign, cancel, merge): `helpdesk.assignment.changed` with `assigned: false`. */
export async function emitAssignmentEnded(ticket: Ticket): Promise<void> {
  const since = new Date(now().getTime() - 60_000);
  const rows = await TicketAssignment.findAll({
    where: { ticketId: ticket.id, endedAt: { [Op.gte]: since } },
    attributes: ['assigneeUserId'],
  });
  const ids = new Set(rows.map(r => r.assigneeUserId).filter((x): x is number => !!x));
  ids.delete(ticket.assigneeUserId ?? -1);
  for (const userId of ids)
    emitToUser(userId, RT.assignmentChanged, { ticketId: ticket.id, status: ticket.status, assigned: false });
}

/** `user:<id>` `helpdesk.ticket.changed` for the upvoters of a building issue (the requester is covered by the foundation). */
export async function emitToUpvoters(ticket: Ticket): Promise<void> {
  if (ticket.kind !== 'BUILDING') return;
  const ups = await TicketUpvote.findAll({ where: { ticketId: ticket.id }, attributes: ['userId'] });
  for (const u of ups)
    if (u.userId !== ticket.requesterUserId)
      emitToUser(u.userId, RT.ticketChanged, {
        ticketId: ticket.id,
        status: ticket.status,
        version: ticket.version,
      });
}

/** BR-15-48: the gate event and `helpdesk.building_issue_urgent_gate` to the guards on duty (every active guard until module 17 knows "on duty"). */
export async function alertGate(ticket: Ticket): Promise<void> {
  const societyId = ticket.societyId;
  const info = await ticketData(ticket);
  emitToRoom(roomGate(societyId), RT.safetyRaised, {
    ticketId: ticket.id,
    ticketNo: ticket.ticketNo,
    title: ticket.title,
    locationLabel: info.locationLabel ?? null,
    priority: ticket.priority,
  });
  let guards = await helpdeskPorts().gateConsole.onDutyGuardUserIds(societyId);
  if (!guards.length)
    guards = (await members.listForSociety(societyId, { roleKeys: ['guard'], statuses: ['ACTIVE'] })).map(
      m => m.userId,
    );
  await sendTo(NOTIFY.urgentGate, guards, { ...info, urgent: true, link: `/gate/issues/${ticket.id}` });
}

/** Realtime part of the listener. */
export async function onTicketEventRealtime(e: TicketEvent, ticket: Ticket): Promise<void> {
  if (e.event !== 'COMMENT' && e.event !== 'UPVOTE') scheduleCounts(e.societyId);
  if (['ASSIGNED', 'UNASSIGNED', 'STATUS_CHANGED', 'MERGED'].includes(e.event))
    await emitAssignmentEnded(ticket);
  if (['ASSIGNED', 'STATUS_CHANGED', 'MERGED', 'COMMENT'].includes(e.event)) await emitToUpvoters(ticket);
}
