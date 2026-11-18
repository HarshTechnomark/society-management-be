import { Op } from 'sequelize';
import { EscalationRule, Ticket, TicketAssignment, TicketComment, TicketUpvote } from '../../models';
import { now } from '../../lib/clock';
import { enqueue } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { residents } from '../residents/residents.public';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { ENT, HELPDESK_QUEUE, JOBS, NOTIFY } from './helpdesk.constants';
import { enqueueFanout } from './helpdesk.fanout';
import {
  adminLink,
  editorIds,
  excerptOf,
  residentLink,
  sendTo,
  sendToMobile,
  staffLink,
  ticketData,
} from './helpdesk.notify';
import { alertGate, onTicketEventRealtime } from './helpdesk.realtime';
import { onTicketEvent, type TicketEvent } from './helpdesk.shared';

/** The after-commit listener of the core (`onTicketEvent`): notifications, fan-out jobs, gate alert and the realtime extras. Never throws into the write. */

const STATUS_LABEL: Record<string, string> = {
  IN_PROGRESS: 'in progress',
  WAITING_ON_RESIDENT: 'waiting for your reply',
};

async function unitResidents(ticket: Ticket): Promise<number[]> {
  return ticket.unitId
    ? residents.audienceUserIds(ticket.societyId, { type: 'UNITS', unitIds: [ticket.unitId] })
    : [];
}
async function upvoterIds(ticket: Ticket): Promise<number[]> {
  return (await TicketUpvote.findAll({ where: { ticketId: ticket.id }, attributes: ['userId'] })).map(
    u => u.userId,
  );
}

/** Notifies the current assignee (MEMBER or STAFF with login by user id; EXTERNAL by mobile only). */
async function notifyAssignee(
  ticket: Ticket,
  template: string,
  data: Record<string, unknown>,
  exclude: number[],
): Promise<void> {
  if (!ticket.currentAssignmentId && !ticket.assigneeUserId) return;
  const a = ticket.currentAssignmentId ? await TicketAssignment.findByPk(ticket.currentAssignmentId) : null;
  if (a && a.assigneeType === 'EXTERNAL' && a.externalMobile && template === NOTIFY.assigned) {
    await sendToMobile(template, a.externalMobile, { ...data, link: '' });
    return;
  }
  if (ticket.assigneeUserId) {
    const staff = a && (a.assigneeType === 'STAFF' || a.assigneeType === 'VENDOR');
    await sendTo(
      template,
      [ticket.assigneeUserId],
      { ...data, link: staff ? staffLink(ticket.id) : adminLink(ticket.id) },
      { exclude },
    );
  }
}

async function onCreated(e: TicketEvent, ticket: Ticket, base: Record<string, unknown>): Promise<void> {
  const actor = e.actorUserId;
  if (ticket.kind === 'PERSONAL') {
    if (ticket.requesterUserId && ticket.requesterUserId !== actor)
      await sendTo(NOTIFY.created, [ticket.requesterUserId], { ...base, link: residentLink(ticket.id) });
    if (ticket.priority === 'P1' || ticket.priority === 'P2')
      await sendTo(
        NOTIFY.created,
        await editorIds(ticket.societyId),
        { ...base, link: adminLink(ticket.id) },
        {
          exclude: [actor, ticket.requesterUserId],
        },
      );
  } else {
    await enqueueFanout(ticket, 'RAISED', actor);
    if (e.data?.safety === true) await alertGate(ticket);
  }
  if (ticket.assigneeUserId && ticket.status === 'ASSIGNED') {
    await notifyAssignee(ticket, NOTIFY.assigned, base, [actor ?? -1]);
    if (ticket.kind === 'BUILDING') await enqueueFanout(ticket, 'ASSIGNED', actor);
    else if (ticket.requesterUserId && ticket.requesterUserId !== actor)
      await sendTo(NOTIFY.assignedResident, [ticket.requesterUserId], {
        ...base,
        assigneeLabel: ticket.assigneeLabel,
        link: residentLink(ticket.id),
      });
  }
  if (ticket.isRecurring && (await isFeatureOn(ticket.societyId, ENT.recurring)))
    await sendTo(
      NOTIFY.recurring,
      await editorIds(ticket.societyId),
      { ...base, link: adminLink(ticket.id) },
      { exclude: [actor] },
    );
}

async function onStatus(e: TicketEvent, ticket: Ticket, base: Record<string, unknown>): Promise<void> {
  const actor = e.actorUserId;
  const action = String(e.data?.action ?? '');
  const requester = ticket.requesterUserId;
  const rlink = { ...base, link: residentLink(ticket.id) };
  const personal = ticket.kind === 'PERSONAL';
  switch (action) {
    case 'START':
    case 'RESUME':
      if (personal && requester)
        await sendTo(
          NOTIFY.statusChanged,
          [requester],
          { ...rlink, statusLabel: STATUS_LABEL[ticket.status] ?? ticket.status },
          { exclude: [actor] },
        );
      break;
    case 'WAIT_ON_RESIDENT': {
      const last = await TicketComment.findOne({
        where: { ticketId: ticket.id, kind: 'STATUS_CHANGE', toStatus: 'WAITING_ON_RESIDENT' },
        order: [['id', 'DESC']],
      });
      // the question is the staff note to the resident (BR-15-43), never the complaint text
      const who = personal
        ? [...(requester ? [requester] : []), ...(await unitResidents(ticket))]
        : requester
          ? [requester]
          : [];
      await sendTo(
        NOTIFY.waiting,
        who,
        { ...rlink, question: excerptOf(last?.body, 300) },
        { exclude: [actor] },
      );
      break;
    }
    case 'RESOLVE':
      if (requester) await sendTo(NOTIFY.resolved, [requester], rlink, { exclude: [actor] });
      if (!personal) await enqueueFanout(ticket, 'RESOLVED', actor);
      break;
    case 'CLOSE':
      if (requester) await sendTo(NOTIFY.closed, [requester], rlink, { exclude: [actor] });
      break;
    case 'REOPEN': {
      const editors = await editorIds(ticket.societyId);
      await sendTo(NOTIFY.reopened, editors, { ...base, link: adminLink(ticket.id) }, { exclude: [actor] });
      await notifyAssignee(ticket, NOTIFY.reopened, base, [actor ?? -1, ...editors]);
      if (!personal) await enqueueFanout(ticket, 'REOPENED', actor);
      if (e.data?.assigneeKept) await notifyAssignee(ticket, NOTIFY.assigned, base, [actor ?? -1]);
      break;
    }
    case 'CANCEL': {
      if (e.data?.merged === true) {
        const into = ticket.mergedIntoTicketId
          ? await Ticket.findByPk(ticket.mergedIntoTicketId, { attributes: ['ticketNo'] })
          : null;
        if (requester)
          await sendTo(
            NOTIFY.merged,
            [requester],
            { ...rlink, mergedIntoTicketNo: into?.ticketNo },
            { exclude: [actor] },
          );
        break;
      }
      if (requester) await sendTo(NOTIFY.cancelled, [requester], rlink, { exclude: [actor] });
      const a = await TicketAssignment.findOne({
        where: { ticketId: ticket.id, assigneeUserId: { [Op.ne]: null } },
        order: [['id', 'DESC']],
      });
      if (a?.assigneeUserId)
        await sendTo(
          NOTIFY.cancelled,
          [a.assigneeUserId],
          { ...base, link: adminLink(ticket.id) },
          { exclude: [actor, requester] },
        );
      if (!personal) await enqueueFanout(ticket, 'CANCELLED', actor);
      break;
    }
  }
}

async function onAssigned(e: TicketEvent, ticket: Ticket, base: Record<string, unknown>): Promise<void> {
  const actor = e.actorUserId;
  await notifyAssignee(ticket, NOTIFY.assigned, base, [actor ?? -1]);
  if (ticket.kind === 'PERSONAL') {
    if (ticket.requesterUserId)
      await sendTo(
        NOTIFY.assignedResident,
        [ticket.requesterUserId],
        { ...base, assigneeLabel: ticket.assigneeLabel, link: residentLink(ticket.id) },
        { exclude: [actor] },
      );
  } else await enqueueFanout(ticket, 'ASSIGNED', actor);
}

async function onComment(e: TicketEvent, ticket: Ticket, base: Record<string, unknown>): Promise<void> {
  const commentId = Number(e.data?.commentId);
  const c = commentId ? await TicketComment.findByPk(commentId) : null;
  if (!c) return;
  const actor = e.actorUserId;
  if (c.visibility === 'INTERNAL') {
    // never to residents: the assignee and the admins who commented before
    const prior = await TicketComment.findAll({
      where: { ticketId: ticket.id, kind: 'COMMENT', authorRole: 'ADMIN', authorUserId: { [Op.ne]: null } },
      attributes: ['authorUserId'],
    });
    await sendTo(
      NOTIFY.comment,
      prior.map(p => p.authorUserId!),
      { ...base, internal: true, link: adminLink(ticket.id) },
      { exclude: [actor, ticket.assigneeUserId] },
    );
    await notifyAssignee(ticket, NOTIFY.comment, { ...base, internal: true }, [actor ?? -1]);
    return;
  }
  const personal = ticket.kind === 'PERSONAL';
  const data = { ...base, excerpt: excerptOf(c.body), link: residentLink(ticket.id) };
  const audience = personal
    ? [...(ticket.requesterUserId ? [ticket.requesterUserId] : []), ...(await unitResidents(ticket))]
    : [...(ticket.requesterUserId ? [ticket.requesterUserId] : []), ...(await upvoterIds(ticket))];
  await sendTo(NOTIFY.comment, audience, data, { exclude: [actor] });
  await notifyAssignee(ticket, NOTIFY.comment, { ...base, excerpt: excerptOf(c.body) }, [actor ?? -1]);
  if (!personal && e.data?.notifyAffected === true) await enqueueFanout(ticket, `COMMENT_${c.id}`, actor);
}

/** Enqueues `helpdesk:escalation-notify` for every ESCALATION row of the ticket that was not notified yet (jobId `esc:<commentId>`). */
export async function enqueueEscalationNotify(ticketId: number, societyId: number): Promise<number> {
  const rows = await TicketComment.findAll({
    where: { ticketId, kind: 'ESCALATION' },
    order: [['id', 'DESC']],
    limit: 20,
  });
  let n = 0;
  for (const r of rows) {
    if ((r.metadata as Record<string, unknown> | null)?.notifiedAt) continue;
    await enqueue(
      HELPDESK_QUEUE,
      JOBS.escalationNotify,
      { societyId, ticketId, commentId: r.id },
      { jobId: `esc:${r.id}` },
    );
    n += 1;
  }
  return n;
}

/** Processor of `helpdesk:escalation-notify`: targets of BR-15-61 (stored on the row), the assignee when the rule says so; marks the row as notified. */
export async function runEscalationNotify(p: { ticketId: number; commentId: number }): Promise<boolean> {
  const row = await TicketComment.findOne({
    where: { id: p.commentId, ticketId: p.ticketId, kind: 'ESCALATION' },
  });
  if (!row) return false;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (meta.notifiedAt) return false;
  const ticket = await Ticket.findByPk(p.ticketId);
  if (!ticket) return false;
  const rule = row.escalationRuleId
    ? await EscalationRule.findByPk(row.escalationRuleId, { paranoid: false })
    : null;
  const trigger = String(meta.trigger ?? rule?.triggerType ?? '');
  const level = Number(meta.level ?? rule?.level ?? 1);
  const recipients = Array.isArray(meta.recipients) ? (meta.recipients as number[]) : [];
  const base = {
    ...(await ticketData(ticket)),
    level,
    ruleName: rule?.name ?? '',
    link: adminLink(ticket.id),
  };
  if (trigger === 'LOW_CSAT') {
    if (await isFeatureOn(ticket.societyId, ENT.csat))
      await sendTo(NOTIFY.lowCsat, recipients, { ...base, score: ticket.csatScore ?? undefined });
  } else if (trigger === 'RESIDENT_REQUEST') await sendTo(NOTIFY.escalationRequested, recipients, base);
  else await sendTo(NOTIFY.slaEscalated, recipients, base);
  if (rule?.notifyAssignee && ticket.assigneeUserId && !recipients.includes(ticket.assigneeUserId))
    await sendTo(
      trigger === 'RESIDENT_REQUEST'
        ? NOTIFY.escalationRequested
        : trigger === 'LOW_CSAT'
          ? NOTIFY.lowCsat
          : NOTIFY.slaEscalated,
      [ticket.assigneeUserId],
      base,
    );
  await row.update({ metadata: { ...meta, notifiedAt: now().toISOString() } });
  return true;
}

/** The listener registered with the core. */
export async function onHelpdeskTicketEvent(e: TicketEvent): Promise<void> {
  try {
    const ticket = await Ticket.findOne({ where: { id: e.ticketId, societyId: e.societyId } });
    if (!ticket) return;
    const base = await ticketData(ticket);
    switch (e.event) {
      case 'CREATED':
        await onCreated(e, ticket, base);
        break;
      case 'STATUS_CHANGED':
        await onStatus(e, ticket, base);
        break;
      case 'ASSIGNED':
        await onAssigned(e, ticket, base);
        break;
      case 'COMMENT':
        await onComment(e, ticket, base);
        break;
      case 'MERGED': {
        const moved = Array.isArray(e.data?.movedUserIds) ? (e.data!.movedUserIds as number[]) : [];
        await sendTo(
          NOTIFY.merged,
          moved,
          { ...base, mergedIntoTicketNo: ticket.ticketNo, link: residentLink(ticket.id) },
          { exclude: [e.actorUserId] },
        );
        break;
      }
      case 'ESCALATED':
        await enqueueEscalationNotify(ticket.id, ticket.societyId);
        break;
      default:
        break;
    }
    await onTicketEventRealtime(e, ticket);
  } catch (err) {
    logger.error({ err, event: e.event, ticketId: e.ticketId }, 'helpdesk ticket listener failed');
  }
}

export function registerHelpdeskNotifications(): void {
  onTicketEvent(onHelpdeskTicketEvent);
}
