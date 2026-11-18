import { Ticket, TicketComment, TicketUpvote } from '../../models';
import { enqueue } from '../../lib/queue';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { HELPDESK_QUEUE, JOBS, NOTIFY, RT, roomUnit } from './helpdesk.constants';
import { sendTo, ticketData, residentLink, excerptOf } from './helpdesk.notify';
import { loadEffectiveCategory } from './helpdesk.tickets.core';

/** BR-15-46, BR-15-47, BR-15-48: the affected audience of a building issue and the `helpdesk:fanout` job (tag `safety`, runs for suspended societies). */

export type FanoutKey = 'RAISED' | 'ASSIGNED' | 'RESOLVED' | 'REOPENED' | 'CANCELLED' | `COMMENT_${number}`;

export interface FanoutPayload {
  societyId: number;
  ticketId: number;
  eventKey: string;
  slaCycle: number;
  actorUserId: number | null;
  requestId?: string;
  [k: string]: unknown;
}

export interface Audience {
  userIds: number[];
  unitIds: number[];
}

/** BR-15-46: SOCIETY to everybody, BUILDING to the tower, FLOOR to the flats of that floor; the requester and upvoters are added; the actor is removed. */
export async function affectedAudience(ticket: Ticket, actorUserId: number | null): Promise<Audience> {
  const societyId = ticket.societyId;
  let userIds: number[];
  let unitIds: number[];
  if (ticket.affectedLevel === 'SOCIETY' || !ticket.affectedBuildingId) {
    userIds = await residents.audienceUserIds(societyId, { type: 'ALL' });
    unitIds = (await units.listActive(societyId, {})).map(u => u.id);
  } else if (ticket.affectedLevel === 'BUILDING') {
    userIds = await residents.audienceUserIds(societyId, {
      type: 'BUILDING',
      buildingId: ticket.affectedBuildingId,
    });
    unitIds = (await units.listActive(societyId, { buildingId: ticket.affectedBuildingId })).map(u => u.id);
  } else {
    unitIds = (
      await units.listActive(societyId, {
        buildingId: ticket.affectedBuildingId,
        floor: ticket.affectedFloor ?? undefined,
      })
    ).map(u => u.id);
    userIds = await residents.audienceUserIds(societyId, { type: 'UNITS', unitIds });
  }
  const ups = await TicketUpvote.findAll({ where: { ticketId: ticket.id }, attributes: ['userId'] });
  const set = new Set([...userIds, ...ups.map(u => u.userId)]);
  if (ticket.requesterUserId) set.add(ticket.requesterUserId);
  if (actorUserId) set.delete(actorUserId);
  return { userIds: [...set], unitIds };
}

const UPDATE_TEXT: Record<string, string> = {
  ASSIGNED: 'A technician has been assigned',
  RESOLVED: 'The issue has been resolved',
  REOPENED: 'The issue was reopened',
  CANCELLED: 'The issue was cancelled',
};

/** Enqueues the fan-out of one event; the job id makes it once per ticket, event and SLA cycle. */
export async function enqueueFanout(
  ticket: Pick<Ticket, 'id' | 'societyId' | 'slaCycle'>,
  eventKey: string,
  actorUserId: number | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const payload: FanoutPayload = {
    societyId: ticket.societyId,
    ticketId: ticket.id,
    eventKey,
    slaCycle: ticket.slaCycle,
    actorUserId,
    ...extra,
  };
  await enqueue(HELPDESK_QUEUE, JOBS.fanout, payload, {
    jobId: `fanout:${ticket.id}:${eventKey}:${ticket.slaCycle}`,
  });
}

const tick = () => new Promise<void>(r => setImmediate(r));

/** The job: resolves the audience, notifies in pages of 500 and emits `unit:<id>` events in batches of 200. */
export async function runFanout(p: FanoutPayload): Promise<{ users: number; units: number }> {
  const ticket = await Ticket.findOne({ where: { id: p.ticketId, societyId: p.societyId } });
  if (!ticket || ticket.kind !== 'BUILDING') return { users: 0, units: 0 };
  const audience = await affectedAudience(ticket, p.actorUserId ?? null);
  const info = await ticketData(ticket);
  const key = p.eventKey;
  let template: string = NOTIFY.buildingUpdate;
  const data: Record<string, unknown> = { ...info, link: residentLink(ticket.id) };
  if (key === 'RAISED') {
    template = NOTIFY.buildingRaised;
    let safety = false;
    try {
      safety = (
        await loadEffectiveCategory(ticket.societyId, ticket.categoryId, ticket.subCategoryId, undefined, {
          allowArchived: true,
        })
      ).isSafety;
    } catch (err) {
      logger.warn({ err }, 'fanout: category not found');
    }
    // BR-15-48: urgent messages ignore quiet hours
    if (ticket.priority === 'P1' && safety) data.urgent = true;
  } else if (key.startsWith('COMMENT_')) {
    const c = await TicketComment.findOne({
      where: { id: Number(key.slice(8)), ticketId: ticket.id, visibility: 'PUBLIC', kind: 'COMMENT' },
    });
    if (!c) return { users: 0, units: 0 };
    data.update = excerptOf(c.body);
  } else data.update = UPDATE_TEXT[key] ?? 'The issue was updated';
  await sendTo(template, audience.userIds, data);
  for (let i = 0; i < audience.unitIds.length; i += 200) {
    for (const unitId of audience.unitIds.slice(i, i + 200))
      emitToRoom(roomUnit(unitId), RT.buildingIssueChanged, {
        ticketId: ticket.id,
        status: ticket.status,
        priority: ticket.priority,
        upvoteCount: ticket.upvoteCount,
      });
    await tick();
  }
  return { users: audience.userIds.length, units: audience.unitIds.length };
}
