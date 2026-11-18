import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Society, Ticket, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues, resetQueueState } from '../../../src/lib/queue';
import { setRealtimeSink, type RealtimeEvent } from '../../../src/lib/realtime';
import { assignTicket, unassignTicket } from '../../../src/modules/helpdesk/helpdesk.routing';
import { addComment } from '../../../src/modules/helpdesk/helpdesk.tickets.comment';
import { createTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.core';
import { transitionTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.transition';
import { addUpvote } from '../../../src/modules/helpdesk/helpdesk.tickets.upvote';
import { fireResidentRequest } from '../../../src/modules/helpdesk/helpdesk.escalation';
import { registerHelpdeskJobsPart4 } from '../../../src/modules/helpdesk/helpdesk.jobs.part4';
import {
  clearCountTimers,
  COUNTS_DEBOUNCE_MS,
  computeCounts,
} from '../../../src/modules/helpdesk/helpdesk.realtime';
import { userActor } from '../../../src/modules/helpdesk/helpdesk.shared';
import { memberUser } from '../../helpers/access';
import { residentUser } from '../../helpers/residents';
import type { CallerType } from '../../../src/modules/helpdesk/helpdesk.constants';
import {
  helpdeskWorld,
  resetHelpdesk,
  sentNotifications,
  ticketPhoto,
  type HelpdeskWorld,
} from '../../helpers/helpdesk';

let events: RealtimeEvent[] = [];
afterAll(async () => {
  setRealtimeSink(undefined);
  await closeDb();
});
beforeEach(async () => {
  await resetHelpdesk();
  resetQueueState();
  clearCountTimers();
  events = [];
  setRealtimeSink({ emit: e => events.push(e), disconnectSession: () => undefined });
  registerHelpdeskJobsPart4();
});

const run = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);
const types = (...t: CallerType[]) => new Set<CallerType>(t);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function building(w: HelpdeskWorld, over: Record<string, unknown> = {}) {
  const lift = await w.cat('Lift');
  const stopped = await w.sub('Lift', 'Lift stopped');
  return run(t =>
    createTicket(
      w.admin,
      {
        kind: 'BUILDING',
        categoryId: lift.id,
        subCategoryId: stopped.id,
        locationNodeId: w.buildingA.locationNodeId,
        urgency: 'EMERGENCY',
        channel: 'GATE',
        reporterRole: 'GUARD',
        ...over,
      } as never,
      t,
    ),
  );
}
async function personal(w: HelpdeskWorld) {
  const cat = await w.cat('Plumbing');
  return run(t =>
    createTicket(
      w.resident,
      {
        kind: 'PERSONAL',
        categoryId: cat.id,
        unitId: w.a101,
        title: 'Kitchen tap is leaking',
        description: 'Water drips all day from the kitchen tap',
        urgency: 'NORMAL',
        channel: 'APP',
        reporterRole: 'RESIDENT',
      } as never,
      t,
    ),
  );
}

describe('notification content privacy (T15-21, section 10)', () => {
  it('internal notes and the complaint text never reach a resident or any template data', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    const admin = userActor(w.admin, types('ADMIN'), 'ADMIN');
    await run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.fm.id }, t));
    await run(t =>
      addComment(w.admin, r.id, admin, { body: 'SECRETNOTE tenant is difficult', visibility: 'INTERNAL' }, t),
    );
    await run(t =>
      addComment(w.admin, r.id, admin, { body: 'We will visit tomorrow', visibility: 'PUBLIC' }, t),
    );
    await run(t => transitionTicket(w.admin, r.id, admin, { action: 'START' }, t));
    await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        { action: 'RESOLVE', note: 'Replaced washer', fileIds: [ticketPhoto(w.sid, w.adminId)] },
        t,
      ),
    );
    await drainQueues();
    const all = sentNotifications();
    expect(all.length).toBeGreaterThan(3);
    const blob = JSON.stringify(all);
    expect(blob).not.toContain('SECRETNOTE');
    expect(blob).not.toContain('Water drips');
    // no internal comment message went to the requester, the public one did (with the excerpt)
    const comments = sentNotifications('helpdesk.ticket_comment');
    const internal = comments.filter(c => c.data.internal === true);
    expect(internal.every(c => !c.userIds.includes(w.residentId))).toBe(true);
    const pub = comments.filter(c => c.data.internal !== true);
    expect(pub).toHaveLength(2); // requester, assignee
    expect(
      pub.some(c => c.userIds.includes(w.residentId) && c.data.excerpt === 'We will visit tomorrow'),
    ).toBe(true);
    // the assignee got the assignment, the requester the status and resolved messages, the actor none
    expect(sentNotifications('helpdesk.ticket_assigned')[0]!.userIds).toEqual([w.fm.id]);
    expect(sentNotifications('helpdesk.ticket_assigned_resident')[0]!.userIds).toEqual([w.residentId]);
    expect(sentNotifications('helpdesk.ticket_status_changed')[0]!.userIds).toEqual([w.residentId]);
    expect(sentNotifications('helpdesk.ticket_resolved')[0]!.userIds).toEqual([w.residentId]);
    for (const n of all) expect(n.userIds).not.toContain(w.adminId);
  });
});

describe('fan-out (BR-15-46 to BR-15-48, T15-10, T15-40)', () => {
  it('Tower A residents get raised, assigned and resolved once each, Tower B none; the gate is alerted; a suspended society still fans out', async () => {
    const w = await helpdeskWorld();
    const ra = await residentUser(w.society, w.a101, { name: 'Anil A' });
    const rb = await residentUser(w.society, w.b101, { name: 'Bina B' });
    const guard = await memberUser(w.society, 'guard', { name: 'Gopal Guard' });
    const r = await building(w);
    await drainQueues();
    const raised = sentNotifications('helpdesk.building_issue_raised');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.userIds).toContain(ra.user.id);
    expect(raised[0]!.userIds).not.toContain(rb.user.id);
    expect(raised[0]!.data).toMatchObject({ urgent: true, priority: 'P1', ticketId: r.id });
    // BR-15-48: gate event and guard message
    const gate = events.filter(e => e.event === 'helpdesk.safety_issue.raised');
    expect(gate).toHaveLength(1);
    expect(gate[0]!.room).toBe(`society:${w.sid}:gate`);
    expect(gate[0]!.payload).toMatchObject({ ticketId: r.id, priority: 'P1' });
    expect(sentNotifications('helpdesk.building_issue_urgent_gate')[0]!.userIds).toContain(guard.id);
    // unit rooms of Tower A only
    const unitRooms = events.filter(e => e.event === 'helpdesk.building_issue.changed').map(e => e.room);
    expect(unitRooms).toContain(`unit:${w.a101}`);
    expect(unitRooms).toContain(`unit:${w.a201}`);
    expect(unitRooms).not.toContain(`unit:${w.b101}`);
    // assign (twice: reassignment) and resolve while the society is suspended
    const admin = userActor(w.admin, types('ADMIN'), 'ADMIN');
    const t0 = await Ticket.findByPk(r.id);
    if (t0!.assigneeUserId !== w.fm.id)
      await run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.fm.id }, t));
    await run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.adminId }, t));
    await run(t => transitionTicket(w.admin, r.id, admin, { action: 'START' }, t));
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.sid } },
    );
    await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        { action: 'RESOLVE', note: 'Lift motor replaced', fileIds: [ticketPhoto(w.sid, w.adminId)] },
        t,
      ),
    );
    await drainQueues();
    const toA = sentNotifications()
      .filter(
        n =>
          n.template.startsWith('helpdesk.building_issue_') &&
          n.template !== 'helpdesk.building_issue_urgent_gate',
      )
      .filter(n => n.userIds.includes(ra.user.id));
    expect(toA.map(n => n.template)).toEqual([
      'helpdesk.building_issue_raised',
      'helpdesk.building_issue_update',
      'helpdesk.building_issue_update',
    ]);
    expect(toA.map(n => n.data.update).filter(Boolean)).toEqual([
      'A technician has been assigned',
      'The issue has been resolved',
    ]);
    const toB = sentNotifications().filter(n => n.userIds.includes(rb.user.id));
    expect(toB).toHaveLength(0);
  });

  it('an admin broadcast comment reaches the affected flats with its text; a plain public comment does not', async () => {
    const w = await helpdeskWorld();
    const ra = await residentUser(w.society, w.a101, { name: 'Anil A' });
    const r = await building(w);
    await drainQueues();
    const admin = userActor(w.admin, types('ADMIN'), 'ADMIN');
    const c1 = await run(t =>
      addComment(w.admin, r.id, admin, { body: 'Technician arrives at 4 pm', notifyAffected: true }, t),
    );
    await run(t => addComment(w.admin, r.id, admin, { body: 'Quiet note for the requester' }, t));
    await drainQueues();
    const updates = sentNotifications('helpdesk.building_issue_update').filter(n =>
      n.userIds.includes(ra.user.id),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data.update).toBe('Technician arrives at 4 pm');
    expect(c1.id).toBeGreaterThan(0);
  });
});

describe('escalation notifications and realtime (9.4, BR-15-58)', () => {
  it('a resident escalation request notifies the rule targets once; the resident is not among them', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    const start = (await Ticket.findByPk(r.id))!.slaStartAt.getTime();
    setNow(new Date(start + 800 * 60_000));
    await run(t => fireResidentRequest(w.resident, r.id, t));
    await drainQueues();
    const sent = sentNotifications('helpdesk.escalation_requested');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.userIds.length).toBeGreaterThan(0);
    expect(sent[0]!.userIds).not.toContain(w.residentId);
    expect(JSON.stringify(sent[0])).not.toContain('Water drips');
  });

  it('counts are debounced to one event, assignment.changed tells the old assignee, upvoters hear of changes', async () => {
    const w = await helpdeskWorld();
    const up = await w.resident2([w.a201]);
    const admin = userActor(w.admin, types('ADMIN'), 'ADMIN');
    const r = await building(w);
    const p1 = await personal(w);
    await personal(w);
    await drainQueues();
    await run(t => addUpvote(up.ctx, r.id, {}, t));
    const cur = (await Ticket.findByPk(p1.id))!;
    const assignee = cur.assigneeUserId;
    if (assignee === null)
      await run(t => assignTicket(w.admin, p1.id, admin, { type: 'MEMBER', userId: w.fm.id }, t));
    const who = (await Ticket.findByPk(p1.id))!.assigneeUserId!;
    events = [];
    await run(t => unassignTicket(w.admin, p1.id, admin, {}, t));
    await drainQueues();
    expect(
      events.some(
        e =>
          e.room === `user:${who}` &&
          e.event === 'helpdesk.assignment.changed' &&
          e.payload.assigned === false,
      ),
    ).toBe(true);
    await sleep(COUNTS_DEBOUNCE_MS + 300);
    const counts = events.filter(e => e.event === 'helpdesk.counts.changed');
    expect(counts).toHaveLength(1);
    expect(counts[0]!.payload).toEqual(await computeCounts(w.sid));
    // upvoter room event on a change of the issue
    events = [];
    await run(t => addComment(w.admin, r.id, admin, { body: 'Update for everyone' }, t));
    await drainQueues();
    expect(events.some(e => e.room === `user:${up.id}` && e.event === 'helpdesk.ticket.changed')).toBe(true);
  });
});
