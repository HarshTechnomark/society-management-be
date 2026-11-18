import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Society, Ticket, TicketComment, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues, resetQueueState } from '../../../src/lib/queue';
import { assignTicket, unassignTicket } from '../../../src/modules/helpdesk/helpdesk.routing';
import { createTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.core';
import { transitionTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.transition';
import { systemActor, userActor } from '../../../src/modules/helpdesk/helpdesk.shared';
import {
  enqueueDigests,
  registerHelpdeskJobsPart4,
  runAutoClose,
  runDailyDigest,
  runSlaSweep,
  runUnassignedReminder,
  runWaitingFollowup,
} from '../../../src/modules/helpdesk/helpdesk.jobs.part4';
import type { CallerType } from '../../../src/modules/helpdesk/helpdesk.constants';
import {
  helpdeskWorld,
  resetHelpdesk,
  sentNotifications,
  ticketPhoto,
  type HelpdeskWorld,
} from '../../helpers/helpdesk';

afterAll(async () => {
  await closeDb();
});
beforeEach(async () => {
  await resetHelpdesk();
  resetQueueState();
  registerHelpdeskJobsPart4();
});

const run = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);
const types = (...t: CallerType[]) => new Set<CallerType>(t);
const DAY = 86_400_000;

async function building(w: HelpdeskWorld) {
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
      } as never,
      t,
    ),
  );
}
async function personal(w: HelpdeskWorld, category = 'Plumbing') {
  const cat = await w.cat(category);
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
async function inProgress(w: HelpdeskWorld, category = 'Plumbing') {
  const r = category === 'Lift' ? await building(w) : await personal(w, category);
  const admin = userActor(w.admin, types('ADMIN'));
  const cur = await Ticket.findByPk(r.id);
  if (cur!.status !== 'ASSIGNED')
    await run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.fm.id }, t));
  await run(t => transitionTicket(w.admin, r.id, admin, { action: 'START' }, t));
  return { r, admin };
}

describe('sla-sweep (6.4, T15-14, T15-36)', () => {
  it('T15-14: three escalations at 75, 100 and 200 percent, each sweep run twice, notified once each', async () => {
    const w = await helpdeskWorld();
    const r = await building(w);
    await Ticket.update({ firstResponseAt: new Date() }, { where: { id: r.id } });
    const start = (await Ticket.findByPk(r.id))!.slaStartAt.getTime();
    for (const min of [180, 240, 480]) {
      setNow(new Date(start + min * 60_000));
      const a = await runSlaSweep();
      const b = await runSlaSweep();
      expect(a.fired).toBe(1);
      expect(b.fired).toBe(0);
    }
    await drainQueues();
    const rows = await TicketComment.findAll({ where: { ticketId: r.id, kind: 'ESCALATION' } });
    expect(rows).toHaveLength(3);
    expect(await Ticket.findByPk(r.id)).toMatchObject({ escalationLevel: 3, resolutionBreached: true });
    const sent = sentNotifications('helpdesk.sla_escalated');
    expect(sent.map(s => s.data.level).sort()).toEqual([1, 2, 3]);
    expect(sent.find(s => s.data.level === 1)!.userIds).toContain(w.fm.id);
    for (const s of sent) expect(JSON.stringify(s)).not.toMatch(/description/);
    // the rows are marked, so a later event does not send them again
    expect(rows.length).toBe(3);
    await drainQueues();
    expect(sentNotifications('helpdesk.sla_escalated')).toHaveLength(3);
  });

  it('T15-36: a suspended society is skipped by the sweep and picked up after reactivation', async () => {
    const w = await helpdeskWorld();
    const r = await building(w);
    const start = (await Ticket.findByPk(r.id))!.slaStartAt.getTime();
    setNow(new Date(start + 300 * 60_000));
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.sid } },
    );
    expect(await runSlaSweep()).toMatchObject({ checked: 0, skipped: 1 });
    expect(await TicketComment.count({ where: { ticketId: r.id, kind: 'ESCALATION' } })).toBe(0);
    await Society.update({ status: 'ACTIVE', suspendedAt: null, suspensionCause: null } as never, {
      where: { id: w.sid },
    });
    expect((await runSlaSweep()).fired).toBeGreaterThan(0);
  });
});

describe('auto-close (BR-15-40, T15-16)', () => {
  it('closes 72 hours after the resolve, once, with close source AUTO and one audit row', async () => {
    const w = await helpdeskWorld();
    const { r, admin } = await inProgress(w, 'Lift');
    const photo = ticketPhoto(w.sid, w.adminId);
    await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        { action: 'RESOLVE', note: 'Replaced the part', fileIds: [photo] },
        t,
      ),
    );
    const at = (await Ticket.findByPk(r.id))!.resolvedAt!.getTime();
    setNow(new Date(at + 72 * 3_600_000 - 60_000));
    expect(await runAutoClose()).toBe(0);
    setNow(new Date(at + 72 * 3_600_000));
    expect(await runAutoClose()).toBe(1);
    expect(await runAutoClose()).toBe(0);
    expect(await Ticket.findByPk(r.id)).toMatchObject({ status: 'CLOSED', closeSource: 'AUTO' });
    expect(
      await AuditLog.count({ where: { action: 'helpdesk.ticket.closed', entityId: String(r.id) } }),
    ).toBe(1);
    await drainQueues();
    // the requester hears about the close (in-app only, never the actor of the system job)
    expect(sentNotifications('helpdesk.ticket_closed')).toHaveLength(1);
  });

  it('a reopened ticket is not closed', async () => {
    const w = await helpdeskWorld();
    const { r, admin } = await inProgress(w, 'Lift');
    const photo = ticketPhoto(w.sid, w.adminId);
    await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        { action: 'RESOLVE', note: 'Replaced the part', fileIds: [photo] },
        t,
      ),
    );
    await run(t => transitionTicket(w.admin, r.id, admin, { action: 'REOPEN', reason: 'Still broken' }, t));
    setNow(new Date(Date.now() + 10 * DAY));
    expect(await runAutoClose()).toBe(0);
  });
});

describe('waiting-followup (BR-15-44, T15-34)', () => {
  it('reminds once at 72 hours, then resolves automatically at 7 days; an estimate wait expires back to IN_PROGRESS', async () => {
    const w = await helpdeskWorld();
    const a = await inProgress(w);
    const b = await inProgress(w);
    const admin = userActor(w.admin, types('ADMIN'));
    await run(t =>
      transitionTicket(
        w.admin,
        a.r.id,
        admin,
        { action: 'WAIT_ON_RESIDENT', waitingReason: 'INFORMATION', note: 'Which day suits you?' },
        t,
      ),
    );
    await run(t =>
      transitionTicket(
        w.admin,
        b.r.id,
        systemActor(w.admin),
        {
          action: 'WAIT_ON_RESIDENT',
          waitingReason: 'ESTIMATE_APPROVAL',
          note: 'Estimate sent for approval',
        },
        t,
      ),
    );
    await Ticket.update({ chargeStatus: 'ESTIMATE_SENT' }, { where: { id: b.r.id } });
    const paused = (await Ticket.findByPk(a.r.id))!.slaPausedAt!.getTime();
    setNow(new Date(paused + 71 * 3_600_000));
    expect(await runWaitingFollowup()).toEqual({ reminded: 0, resolved: 0, expired: 0 });
    setNow(new Date(paused + 72 * 3_600_000));
    expect(await runWaitingFollowup()).toEqual({ reminded: 2, resolved: 0, expired: 0 });
    expect(await runWaitingFollowup()).toEqual({ reminded: 0, resolved: 0, expired: 0 });
    const reminders = sentNotifications('helpdesk.waiting_reminder');
    expect(reminders).toHaveLength(2);
    expect(reminders.every(m => m.userIds.length === 1 && m.userIds[0] === w.residentId)).toBe(true);
    setNow(new Date(paused + 7 * DAY));
    expect(await runWaitingFollowup()).toEqual({ reminded: 0, resolved: 1, expired: 1 });
    expect(await runWaitingFollowup()).toEqual({ reminded: 0, resolved: 0, expired: 0 });
    expect(await Ticket.findByPk(a.r.id)).toMatchObject({
      status: 'RESOLVED',
      resolutionNote: 'Resolved automatically: no response from the resident in 7 days',
    });
    expect(await Ticket.findByPk(b.r.id)).toMatchObject({ status: 'IN_PROGRESS', chargeStatus: 'REJECTED' });
    expect(sentNotifications('helpdesk.estimate_decided')).toHaveLength(1);
  });
});

describe('unassigned-reminder (9.1) and daily digest', () => {
  it('reminds the desk once per cycle after the configured minutes', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w, 'Other');
    const admin = userActor(w.admin, types('ADMIN'));
    if ((await Ticket.findByPk(r.id))!.status === 'ASSIGNED')
      await run(t => unassignTicket(w.admin, r.id, admin, {}, t));
    const start = (await Ticket.findByPk(r.id))!.slaStartAt.getTime();
    setNow(new Date(start + 29 * 60_000));
    expect(await runUnassignedReminder()).toBe(0);
    setNow(new Date(start + 31 * 60_000));
    expect(await runUnassignedReminder()).toBe(1);
    expect(await runUnassignedReminder()).toBe(0);
    const notes = await TicketComment.findAll({
      where: { ticketId: r.id, kind: 'SYSTEM', visibility: 'INTERNAL' },
    });
    expect(notes).toHaveLength(1);
    const sent = sentNotifications('helpdesk.unassigned_reminder');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.userIds).toContain(w.adminId);
    expect(sent[0]!.userIds).not.toContain(w.residentId);
  });

  it('the digest goes to the desk with counts, once per society and local date, and not when nothing is open', async () => {
    const w = await helpdeskWorld();
    expect(await runDailyDigest(w.sid, '2026-11-01')).toBe(false);
    await building(w);
    await personal(w);
    expect(await enqueueDigests()).toBeGreaterThanOrEqual(1);
    expect(await enqueueDigests()).toBeGreaterThanOrEqual(1);
    await drainQueues();
    const sent = sentNotifications('helpdesk.daily_digest');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({ open: 2, p1: 1 });
    expect(sent[0]!.userIds).toContain(w.adminId);
    expect(JSON.stringify(sent[0]!.data)).not.toContain('Water drips');
  });
});
