import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, CommitteeTerm, closeDb } from '../../../src/models';
import { enqueue, drainQueues, tickScheduler } from '../../../src/lib/queue';
import { setNow } from '../../../src/lib/clock';
import { setRealtimeSink } from '../../../src/lib/realtime';
import { JOBS } from '../../../src/modules/committee/committee.constants';
import { setCommitteePorts } from '../../../src/modules/committee/committee.ports';
import {
  autoExpireFor,
  reconcileSeatsFor,
  sendRemindersFor,
} from '../../../src/modules/committee/committee.jobs';
import type { HandoverItemJson } from '../../../src/modules/committee/committee.schemas';
import { DEFAULT_HANDOVER_TEMPLATE } from '../../../src/modules/committee/committee.constants';
import {
  committeeWorld,
  holder,
  rawTerm,
  resetCommittee,
  seatedFor,
  setMemberStatus,
  setRole,
  setSetting,
  suspend,
} from '../../helpers/committee';

interface Sent {
  template: string;
  userIds: number[];
  data: Record<string, unknown>;
}
const sent: Sent[] = [];
const events: unknown[] = [];
afterAll(async () => {
  setRealtimeSink(undefined);
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetCommittee();
  sent.length = 0;
  events.length = 0;
  setCommitteePorts({
    notifications: {
      send: async (template, userIds, data) => {
        sent.push({ template, userIds, data });
      },
    },
  });
  setRealtimeSink({ emit: e => events.push(e), disconnectSession: () => undefined });
});

const run = async (job: string) => {
  await enqueue('members', job, {});
  await drainQueues();
};
const of = (template: string) => sent.filter(s => s.template === template);
const day = (ymd: string) => setNow(`${ymd}T04:30:00Z`); // 10:00 IST

const pendingList = (): HandoverItemJson[] =>
  DEFAULT_HANDOVER_TEMPLATE.map((it, i) => ({
    itemId: `H${i + 1}`,
    title: it.title,
    ownerDesignation: it.ownerDesignation,
    status: 'PENDING' as const,
    note: null,
    evidenceFileIds: [],
    updatedByUserId: null,
    updatedAt: null,
  }));

/** A current term whose end date is `endDate`; the seated chairman and secretary are officers. */
async function termWorld(o: Record<string, unknown> = {}, opts: Parameters<typeof committeeWorld>[0] = {}) {
  const w = await committeeWorld(opts);
  const rajesh = await holder(w, 1, 'Rajesh Kulkarni');
  const arjun = await holder(w, 2, 'Arjun Shah');
  await setRole(w.society.id!, rajesh.user.id, 'chairman');
  await setRole(w.society.id!, arjun.user.id, 'secretary');
  const term = await rawTerm(w.society.id!, {
    members: [await seatedFor(w, rajesh, 'S1', 'CHAIRMAN'), await seatedFor(w, arjun, 'S2', 'SECRETARY')],
    ...o,
  });
  return { w, term, rajesh, arjun };
}
const reload = async (id: number) => (await CommitteeTerm.findByPk(id))!;

describe('term reminders at 90, 30 and 7 days (F10, BR-10-24, T10-24)', () => {
  it('sends each threshold exactly once to the officers and not again on a second run the same day', async () => {
    const x = await termWorld({ endDate: '2027-01-30' }); // 90 days after 2026-11-01
    day('2026-11-01');
    await run(JOBS.termReminders);
    expect(of('committee.term_expiring')).toHaveLength(1);
    const first = of('committee.term_expiring')[0]!;
    expect(first.data).toMatchObject({ daysLeft: 90, endDate: '30 Jan 2027', termName: x.term.name });
    // officers: seated chairman and secretary, and whoever holds settings.members.edit (the signed-in chairman)
    expect(new Set(first.userIds)).toEqual(new Set([x.rajesh.user.id, x.arjun.user.id, x.w.user.id]));
    expect((await reload(x.term.id!)).lastReminderDays).toBe(90);
    await run(JOBS.termReminders);
    expect(of('committee.term_expiring')).toHaveLength(1);

    day('2026-12-15'); // 46 days left: nothing new
    await run(JOBS.termReminders);
    expect(of('committee.term_expiring')).toHaveLength(1);
    day('2026-12-31'); // 30 days left
    await run(JOBS.termReminders);
    await run(JOBS.termReminders);
    expect(of('committee.term_expiring').map(s => s.data.daysLeft)).toEqual([90, 30]);
    day('2027-01-23'); // 7 days left
    await run(JOBS.termReminders);
    expect(of('committee.term_expiring').map(s => s.data.daysLeft)).toEqual([90, 30, 7]);
    expect((await reload(x.term.id!)).lastReminderDays).toBe(7);
    day('2027-01-29');
    await run(JOBS.termReminders);
    expect(of('committee.term_expiring')).toHaveLength(3);
    expect(of('committee.term_expired')).toHaveLength(0);
  });

  it('only the smallest qualifying threshold goes out after a late start (no burst)', async () => {
    const x = await termWorld({ endDate: '2026-11-21' }); // 20 days left: 30 qualifies, 7 does not
    day('2026-11-01');
    await run(JOBS.termReminders);
    expect(of('committee.term_expiring').map(s => s.data.daysLeft)).toEqual([20]);
    expect((await reload(x.term.id!)).lastReminderDays).toBe(30);
    day('2026-11-14'); // 7 days left
    await run(JOBS.termReminders);
    expect((await reload(x.term.id!)).lastReminderDays).toBe(7);
    expect(of('committee.term_expiring')).toHaveLength(2);
  });

  it('uses committee.reminderDays of the society and an extension of the end date starts the sequence again', async () => {
    const x = await termWorld({ endDate: '2026-12-01', lastReminderDays: 7 });
    await setSetting(x.w.society.id!, 'committee.reminderDays', [45, 10]);
    day('2026-11-01'); // 30 days left; lastReminderDays 7 blocks it
    await run(JOBS.termReminders);
    expect(sent).toHaveLength(0);
    await CommitteeTerm.update({ lastReminderDays: null }, { where: { id: x.term.id! } }); // what an extension does (10.1)
    await run(JOBS.termReminders);
    expect(of('committee.term_expiring').map(s => s.data.daysLeft)).toEqual([30]);
    expect((await reload(x.term.id!)).lastReminderDays).toBe(45);
  });

  it('T10-23: an ended term sends committee.term_expired once on Starter (stays ACTIVE, overdue) and on Standard (EXPIRED)', async () => {
    const std = await termWorld({ endDate: '2026-10-31' }, { plan: 'STANDARD' });
    const sta = await termWorld({ endDate: '2026-10-31' }, { plan: 'STARTER' });
    day('2026-11-01');
    await run(JOBS.termAutoExpiry);
    await run(JOBS.termReminders);
    await run(JOBS.termReminders);
    await run(JOBS.termAutoExpiry);
    expect((await reload(std.term.id!)).status).toBe('EXPIRED');
    expect((await reload(std.term.id!)).expiredAt).not.toBeNull();
    expect((await reload(sta.term.id!)).status).toBe('ACTIVE');
    const expired = of('committee.term_expired');
    expect(expired).toHaveLength(2);
    expect(expired.every(s => s.data.endDate === '31 Oct 2026')).toBe(true);
    expect((await reload(std.term.id!)).lastReminderDays).toBe(0);
    // Starter: the banner and isOverdue come from the dates
    const o = await sta.w.c('get', '/committee');
    expect(o.body.data.current).toMatchObject({ status: 'ACTIVE', isOverdue: true, daysLeft: -1 });
    expect(o.body.data.banner).toEqual({ code: 'CARETAKER', endedOn: '2026-10-31' });
    const e = await std.w.c('get', '/committee');
    expect(e.body.data.current).toMatchObject({ status: 'EXPIRED', isOverdue: true });
  });

  it('does nothing without a current term, for a draft, or for a suspended society', async () => {
    const none = await committeeWorld();
    const x = await termWorld({ endDate: '2026-10-31' });
    await rawTerm(none.society.id!, { status: 'DRAFT', endDate: '2026-10-31', tookChargeOn: null });
    await suspend(x.w.society.id!);
    day('2026-11-01');
    await run(JOBS.termReminders);
    await run(JOBS.termAutoExpiry);
    expect(sent).toHaveLength(0);
    expect((await reload(x.term.id!)).status).toBe('ACTIVE');
  });
});

describe('automatic expiry (F11, BR-10-23)', () => {
  it('moves an ACTIVE term past its end date to EXPIRED once, audits as system and emits committee.changed', async () => {
    const x = await termWorld({ endDate: '2026-10-31' });
    day('2026-11-01');
    const baseline = (await AuditLog.max<number, AuditLog>('id')) ?? 0;
    expect(await autoExpireFor(x.w.society.id!)).toEqual([x.term.id]);
    expect(await autoExpireFor(x.w.society.id!)).toEqual([]);
    const rows = (await AuditLog.findAll({ where: { societyId: x.w.society.id! } })).filter(
      l => l.id! > baseline && l.action === 'committee.term.expired',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: null, actorRole: 'system', entityId: String(x.term.id) });
    await new Promise(r => setTimeout(r, 30));
    expect(JSON.stringify(events)).toContain('"reason":"EXPIRED"');
    const t = await reload(x.term.id!);
    expect([t.status, t.version]).toEqual(['EXPIRED', 2]);
    expect(t.members).toHaveLength(2); // roles and seats stay (caretaker committee)
  });

  it('keeps a term that ends today, and Starter has no auto-expiry feature', async () => {
    const today = await termWorld({ endDate: '2026-11-01' });
    const starter = await termWorld({ endDate: '2026-10-01' }, { plan: 'STARTER' });
    day('2026-11-01');
    expect(await autoExpireFor(today.w.society.id!)).toEqual([]);
    expect(await autoExpireFor(starter.w.society.id!)).toEqual([]);
  });

  it('an extension (EXPIRED to ACTIVE) is taken back by the next run only after the new end date passes', async () => {
    const x = await termWorld({ endDate: '2026-10-31' });
    day('2026-11-01');
    await run(JOBS.termAutoExpiry);
    const patch = await x.w.c('patch', `/committee/terms/${x.term.id}`, {
      version: 2,
      endDate: '2026-12-31',
      reason: 'Elections postponed by the general body',
    });
    expect([patch.status, patch.body.data?.status]).toEqual([200, 'ACTIVE']);
    await run(JOBS.termAutoExpiry);
    expect((await reload(x.term.id!)).status).toBe('ACTIVE');
  });
});

describe('hand-over reminders (day 15 and 30 after taking charge)', () => {
  it('sends committee.handover_pending once per milestone to the owners of pending items and the officers', async () => {
    const x = await termWorld({
      endDate: '2031-10-31',
      tookChargeOn: '2026-10-17',
      handoverChecklist: pendingList(),
    });
    day('2026-10-31'); // day 14
    await run(JOBS.termReminders);
    expect(of('committee.handover_pending')).toHaveLength(0);
    day('2026-11-01'); // day 15
    await run(JOBS.termReminders);
    await run(JOBS.termReminders);
    expect(of('committee.handover_pending')).toHaveLength(1);
    expect(new Set(of('committee.handover_pending')[0]!.userIds)).toEqual(
      new Set([x.rajesh.user.id, x.arjun.user.id, x.w.user.id]),
    );
    expect((await reload(x.term.id!)).lastHandoverReminderDay).toBe(15);
    day('2026-11-16'); // day 30
    await run(JOBS.termReminders);
    await run(JOBS.termReminders);
    expect(of('committee.handover_pending')).toHaveLength(2);
    expect((await reload(x.term.id!)).lastHandoverReminderDay).toBe(30);
    day('2026-12-30');
    await run(JOBS.termReminders);
    expect(of('committee.handover_pending')).toHaveLength(2);
  });

  it('sends nothing once the checklist is complete or has no pending item', async () => {
    const done = pendingList().map(i => ({ ...i, status: 'DONE' as const }));
    await termWorld({
      endDate: '2031-10-31',
      tookChargeOn: '2026-09-01',
      handoverChecklist: done,
      handoverCompletedAt: new Date(),
    });
    await termWorld({ endDate: '2031-10-31', tookChargeOn: '2026-09-01', handoverChecklist: [] });
    day('2026-11-01');
    await run(JOBS.termReminders);
    expect(of('committee.handover_pending')).toHaveLength(0);
  });
});

describe('seat reconciliation (F14, BR-10-25, T10-25)', () => {
  async function seatedWorld() {
    const w = await committeeWorld();
    const [a, b, c, d] = [
      await holder(w, 1, 'Rajesh Kulkarni'),
      await holder(w, 2, 'Arjun Shah'),
      await holder(w, 3, 'Meera Iyer'),
      await holder(w, 4, 'Tara Nair'),
    ];
    await setRole(w.society.id!, a.user.id, 'chairman');
    await setRole(w.society.id!, b.user.id, 'secretary');
    await setRole(w.society.id!, c.user.id, 'treasurer');
    await setRole(w.society.id!, d.user.id, 'committee_member');
    const term = await rawTerm(w.society.id!, {
      members: [
        await seatedFor(w, a, 'S1', 'CHAIRMAN'),
        await seatedFor(w, b, 'S2', 'SECRETARY'),
        await seatedFor(w, c, 'S3', 'TREASURER'),
        await seatedFor(w, d, 'S4', 'MEMBER'),
      ],
    });
    return { w, term, a, b, c, d };
  }

  it('T10-25: an ENDED member leaves the seat (MEMBERSHIP_ENDED), a suspended one is flagged, one notification', async () => {
    const x = await seatedWorld();
    day('2026-11-01');
    await setMemberStatus(x.c.user.id, 'ENDED');
    await setMemberStatus(x.b.user.id, 'SUSPENDED');
    const baseline = (await AuditLog.max<number, AuditLog>('id')) ?? 0;
    await run(JOBS.reconcileSeats);
    const t = await reload(x.term.id!);
    const seat = (id: string) => t.members.find(s => s.seatId === id)!;
    expect(seat('S3')).toMatchObject({
      status: 'LEFT',
      exitReason: 'MEMBERSHIP_ENDED',
      toDate: '2026-11-01',
      flags: [],
    });
    expect(seat('S2')).toMatchObject({ status: 'SEATED', flags: ['MEMBERSHIP_SUSPENDED'] });
    expect(seat('S1').flags).toEqual([]);
    expect(t.version).toBe(2);
    expect(of('committee.seat_needs_attention')).toHaveLength(1);
    expect(String(of('committee.seat_needs_attention')[0]!.data.detail)).toContain('Meera Iyer (Treasurer)');
    const actions = (await AuditLog.findAll({ where: { societyId: x.w.society.id! } }))
      .filter(l => l.id! > baseline)
      .map(l => [l.action, l.actorRole]);
    expect(actions).toEqual([
      ['committee.seat.vacated', 'system'],
      ['committee.seat.flagged', 'system'],
    ]);
    // a second run changes and sends nothing
    await run(JOBS.reconcileSeats);
    expect(of('committee.seat_needs_attention')).toHaveLength(1);
    expect((await reload(x.term.id!)).version).toBe(2);
    // the overview counts the flagged seat
    const o = await x.w.c('get', '/committee');
    expect(o.body.data.current).toMatchObject({ attentionCount: 1, seatedCount: 3 });
  });

  it('flags ROLE_MISMATCH and NOT_OWNER; fixing the cause clears the flag silently; roles are never changed', async () => {
    const x = await seatedWorld();
    day('2026-11-01');
    await setRole(x.w.society.id!, x.d.user.id, 'owner'); // a MEMBER seat whose role is no longer committee_member
    await setSetting(x.w.society.id!, 'committee.ownersOnly', true);
    const tenant = await holder(x.w, 5, 'Tenant Seated', 'TENANT');
    await setRole(x.w.society.id!, tenant.user.id, 'committee_member');
    await CommitteeTerm.update(
      { members: [...(await reload(x.term.id!)).members, await seatedFor(x.w, tenant, 'S5', 'MEMBER')] },
      { where: { id: x.term.id! } },
    );
    await reconcileSeatsFor(x.w.society.id!);
    let t = await reload(x.term.id!);
    expect(t.members.find(s => s.seatId === 'S4')!.flags).toEqual(['ROLE_MISMATCH']);
    expect(t.members.find(s => s.seatId === 'S5')!.flags).toEqual(['NOT_OWNER']);
    expect(of('committee.seat_needs_attention')).toHaveLength(1);
    await setRole(x.w.society.id!, x.d.user.id, 'committee_member');
    await reconcileSeatsFor(x.w.society.id!);
    t = await reload(x.term.id!);
    expect(t.members.find(s => s.seatId === 'S4')!.flags).toEqual([]);
    expect(t.members.find(s => s.seatId === 'S5')!.flags).toEqual(['NOT_OWNER']);
    expect(of('committee.seat_needs_attention')).toHaveLength(1); // clearing does not notify
    // ownersOnly off: no NOT_OWNER flag any more
    await setSetting(x.w.society.id!, 'committee.ownersOnly', false);
    await reconcileSeatsFor(x.w.society.id!);
    expect((await reload(x.term.id!)).members.find(s => s.seatId === 'S5')!.flags).toEqual([]);
  });

  it('skips a suspended society and a society without a current term', async () => {
    const x = await seatedWorld();
    await setMemberStatus(x.c.user.id, 'ENDED');
    await suspend(x.w.society.id!);
    await committeeWorld();
    await run(JOBS.reconcileSeats);
    expect((await reload(x.term.id!)).members.find(s => s.seatId === 'S3')!.status).toBe('SEATED');
    expect(sent).toHaveLength(0);
  });
});

describe('registration (section 9.1)', () => {
  it('the three jobs are repeatable at 09:00, 00:15 and 02:00 (IST) on queue members', async () => {
    expect(await tickScheduler(new Date('2031-03-01T03:30:00Z'))).toContain(JOBS.termReminders);
    expect(await tickScheduler(new Date('2031-03-01T18:45:00Z'))).toContain(JOBS.termAutoExpiry);
    expect(await tickScheduler(new Date('2031-03-01T20:30:00Z'))).toContain(JOBS.reconcileSeats);
    await drainQueues();
  });

  it('the reminder step is idempotent when called directly', async () => {
    const x = await termWorld({ endDate: '2026-11-07' });
    day('2026-11-01');
    expect(await sendRemindersFor(x.w.society.id!)).toMatchObject({ expiring: 7 });
    expect(await sendRemindersFor(x.w.society.id!)).toMatchObject({ expiring: null, expired: false });
  });
});
