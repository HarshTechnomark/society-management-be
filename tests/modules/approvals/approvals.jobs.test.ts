import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalAction,
  ApprovalDelegation,
  ApprovalRequest,
  AuditLog,
  Society,
  SocietyMember,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow, nowMs } from '../../../src/lib/clock';
import { tickScheduler } from '../../../src/lib/queue';
import { endMember } from '../../../src/modules/access-control/access-control.public';
import {
  onMemberEnded,
  recheckSociety,
  requestChanges,
  runDelegationSweep,
  runSlaSweep,
} from '../../../src/modules/approvals/approvals.public';
import { registerType } from '../../../src/modules/approvals/approvals.registry';
import { sentNotifications } from '../../../src/modules/approvals/approvals.ports';
import { lifecycleColumns, memberUser } from '../../helpers/access';
import { approvalsWorld, events, handlerCalls, settle, type ApprovalsWorld } from '../../helpers/approvals';

afterAll(async () => {
  await settle();
  await closeDb();
});

let w: ApprovalsWorld;
beforeEach(async () => {
  w = await approvalsWorld();
});

const T0 = Date.parse('2026-11-10T05:00:00Z');
const H = 3_600_000;
const at = (hours: number) => setNow(T0 + hours * H);
const sentTo = (template: string) => sentNotifications.filter(n => n.template === template);
const actions = (id: number, action: string) => ApprovalAction.count({ where: { requestId: id, action } });
const fresh = async (id: number) => (await ApprovalRequest.findByPk(id))!;
const raiseBig = () => w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: 3_000_000 });

describe('approvals:sla-sweep reminders and escalation (BR-14-19, BR-14-20)', () => {
  it('T14-30 a reminder at dueAt and an escalation at escalateAt, each once; a second run sends nothing', async () => {
    const r = await raiseBig();
    await settle();
    sentNotifications.length = 0;

    at(47);
    expect(await runSlaSweep()).toMatchObject({ reminded: 0, escalated: 0 });

    at(49); // dueAt = +48h
    expect(await runSlaSweep()).toMatchObject({ reminded: 1, escalated: 0, expired: 0 });
    await settle();
    expect(await actions(r.id, 'REMINDED')).toBe(1);
    expect(sentTo('approvals.reminder')).toHaveLength(1);
    expect(sentTo('approvals.reminder')[0]!.userIds.sort()).toEqual(
      [w.people.chairman!.id, w.people.secretary!.id].sort(),
    );
    expect(await runSlaSweep()).toMatchObject({ reminded: 0, escalated: 0 });
    await settle();
    expect(sentTo('approvals.reminder')).toHaveLength(1);
    const row = await fresh(r.id);
    expect(row.reminderCount).toBe(1);
    expect(row.nextReminderAt!.getTime()).toBe(T0 + 49 * H + 24 * H);

    at(73); // escalateAt = +72h
    const res = await runSlaSweep();
    expect(res.escalated).toBe(1);
    await settle();
    expect(await actions(r.id, 'ESCALATED')).toBe(1);
    expect(sentTo('approvals.escalated')).toHaveLength(1);
    expect(sentTo('approvals.escalated')[0]!.userIds).toEqual([w.people.chairman!.id]);
    expect((await fresh(r.id)).escalatedAt).not.toBeNull();
    expect(await AuditLog.count({ where: { action: 'approvals.request.escalated' } })).toBe(1);
    expect(await runSlaSweep()).toMatchObject({ escalated: 0 });
    await settle();
    expect(sentTo('approvals.escalated')).toHaveLength(1);
  });

  it('reminders stop after five per step and nextReminderAt becomes null', async () => {
    const r = await raiseBig();
    let sent = 0;
    for (let h = 49; h < 49 + 24 * 8; h += 24) {
      at(h);
      sent += (await runSlaSweep()).reminded;
    }
    expect(sent).toBe(5);
    const row = await fresh(r.id);
    expect(row.reminderCount).toBe(5);
    expect(row.nextReminderAt).toBeNull();
  });

  it('the repeatable sweep job runs from the scheduler', async () => {
    const r = await raiseBig();
    at(49);
    await tickScheduler();
    await settle();
    expect(await actions(r.id, 'REMINDED')).toBe(1);
  });
});

describe('expiry (BR-14-22, BR-14-30)', () => {
  it('T14-31 a booking whose expiresAt passed is EXPIRED and onExpired is called', async () => {
    const r = await w.raise(w.people.facility_manager!, {
      type: 'BOOKING',
      entityId: 7,
      expiresAt: new Date(T0 + 24 * H),
    });
    at(23);
    expect((await runSlaSweep()).expired).toBe(0);
    at(25);
    expect((await runSlaSweep()).expired).toBe(1);
    const row = await fresh(r.id);
    expect(row).toMatchObject({ status: 'EXPIRED', decisionReason: 'Expired' });
    expect(handlerCalls.filter(c => c.type === 'BOOKING' && c.fn === 'onExpired')).toHaveLength(1);
    expect(await actions(r.id, 'EXPIRED')).toBe(1);
    expect(await AuditLog.count({ where: { action: 'approvals.request.expired' } })).toBe(1);
    expect((await runSlaSweep()).expired).toBe(0);
    expect(handlerCalls.filter(c => c.fn === 'onExpired')).toHaveLength(1);
  });

  it('without onExpired the default is onRejected with the reason "Expired"', async () => {
    await w.raise(w.people.chairman!, {
      type: 'MOVE_IN',
      entityId: 3,
      expiresAt: new Date(T0 + H),
    });
    at(2);
    await runSlaSweep();
    const c = handlerCalls.find(x => x.type === 'MOVE_IN' && x.fn === 'onRejected')!;
    expect(c).toMatchObject({ decision: 'EXPIRED', reason: 'Expired', actor: null, inTx: true });
  });

  it('T14-32 CHANGES_REQUESTED expires after 30 days without a resubmission', async () => {
    const r = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 4 });
    await requestChanges(w.ctx(w.people.chairman!), r.id, { version: 1, reason: 'Fix the wording' });
    setNow(T0 + 29 * 24 * H);
    expect((await runSlaSweep()).expired).toBe(0);
    setNow(T0 + 31 * 24 * H);
    expect((await runSlaSweep()).expired).toBe(1);
    expect((await fresh(r.id)).status).toBe('EXPIRED');
    expect(handlerCalls.some(c => c.type === 'NOTICE_PUBLISH' && c.decision === 'EXPIRED')).toBe(true);
  });

  it('BR-14-30 a society whose status does not allow the support tag (CLOSED) is skipped and the expiry catches up after reactivation', async () => {
    const r = await w.raise(w.people.facility_manager!, {
      type: 'BOOKING',
      entityId: 8,
      expiresAt: new Date(T0 + H),
    });
    await raiseBig();
    await Society.update({ ...lifecycleColumns('CLOSED') } as never, { where: { id: w.society.id! } });
    at(100);
    expect(await runSlaSweep()).toEqual({ expired: 0, escalated: 0, reminded: 0, rechecked: 0 });
    expect((await fresh(r.id)).status).toBe('PENDING');
    await Society.update({ ...lifecycleColumns('ACTIVE') } as never, { where: { id: w.society.id! } });
    expect((await runSlaSweep()).expired).toBe(1);
    expect((await fresh(r.id)).status).toBe('EXPIRED');
  });

  it('a handler that fails leaves the request untouched and the sweep goes on', async () => {
    const r = await w.raise(w.people.facility_manager!, {
      type: 'BOOKING',
      entityId: 9,
      expiresAt: new Date(T0 + H),
    });
    const r2 = await w.raise(w.people.chairman!, {
      type: 'MOVE_IN',
      entityId: 5,
      expiresAt: new Date(T0 + H),
    });
    registerType(
      'BOOKING',
      {
        onApproved: async () => {},
        onRejected: async () => {},
        onExpired: async () => {
          throw new Error('boom');
        },
        describe: () => ({ facts: [], link: null }),
      },
      { replace: true },
    );
    at(2);
    expect((await runSlaSweep()).expired).toBe(1);
    expect((await fresh(r.id)).status).toBe('PENDING');
    expect((await fresh(r2.id)).status).toBe('EXPIRED');
  });
});

describe('daily recompute', () => {
  it('the 03:xx IST tick (or recompute: true) recomputes capacity of requests older than an hour', async () => {
    const r = await raiseBig();
    const m = await SocketLess.endSecretary(w);
    expect(m).toBe(true);
    at(2);
    expect((await runSlaSweep()).rechecked).toBe(0);
    expect((await runSlaSweep({ recompute: true })).rechecked).toBe(1);
    expect((await fresh(r.id)).stuckAt).not.toBeNull();
  });
});

const SocketLess = {
  /** Ends the Secretary's membership through module 03 (no approvals hook is wired yet). */
  async endSecretary(world: ApprovalsWorld): Promise<boolean> {
    const m = await SocietyMember.findOne({
      where: { societyId: world.society.id!, userId: world.people.secretary!.id },
    });
    await sequelize.transaction(t => endMember(world.ctx(world.people.chairman!), m!.id!, 'Left society', t));
    return true;
  },
};

describe('approvals:recheck-member and onMemberEnded (BR-14-11, BR-14-32)', () => {
  it('T14-49 a leaver makes the request STUCK with alerts; a new Secretary frees it and sends approvals.pending', async () => {
    const r = await raiseBig();
    expect(r.hasEligibleApprover).toBe(true);
    await settle();
    sentNotifications.length = 0;
    events.length = 0;
    await SocketLess.endSecretary(w);
    await sequelize.transaction(t =>
      onMemberEnded(w.ctx(w.people.chairman!), w.society.id!, w.people.secretary!.id, t),
    );
    await settle(); // the recheck-member job runs
    const stuck = await fresh(r.id);
    expect(stuck.stuckAt).not.toBeNull();
    expect(stuck.hasEligibleApprover).toBe(false);
    expect(sentTo('approvals.unroutable')[0]!.userIds).toContain(w.people.chairman!.id);
    expect(events.some(e => e.event === 'approvals.stuck')).toBe(true);
    expect(await AuditLog.count({ where: { action: 'approvals.request.stuck' } })).toBe(1);

    // idempotent: a second recheck alerts nobody again
    sentNotifications.length = 0;
    expect(await recheckSociety(w.society.id!)).toEqual({ stuck: 0, freed: 0 });
    expect(sentTo('approvals.unroutable')).toHaveLength(0);

    await memberUser(w.society, 'secretary', { name: 'new secretary' });
    expect(await recheckSociety(w.society.id!)).toEqual({ stuck: 0, freed: 1 });
    await settle();
    const freed = await fresh(r.id);
    expect(freed.stuckAt).toBeNull();
    expect(freed.hasEligibleApprover).toBe(true);
    expect(sentTo('approvals.pending')).toHaveLength(1);
    expect(await AuditLog.count({ where: { action: 'approvals.request.unstuck' } })).toBe(1);
  });

  it('onMemberEnded revokes the ACTIVE delegations of the user as delegator or delegate', async () => {
    const mk = (delegator: number, delegate: number) =>
      ApprovalDelegation.create({
        societyId: w.society.id!,
        delegatorUserId: delegator,
        delegateUserId: delegate,
        source: 'TERM_HANDOVER',
        types: null,
        maxAmountPaise: null,
        startsAt: new Date(nowMs() - H),
        endsAt: new Date(nowMs() + 48 * H),
        reason: 'Away',
      } as never);
    const a = await mk(w.people.chairman!.id, w.people.treasurer!.id);
    const b = await mk(w.people.secretary!.id, w.people.chairman!.id);
    const c = await mk(w.people.secretary!.id, w.people.treasurer!.id);
    events.length = 0;
    await sequelize.transaction(t =>
      onMemberEnded(w.ctx(w.people.treasurer!), w.society.id!, w.people.chairman!.id, t),
    );
    await settle();
    for (const d of [a, b]) {
      await d.reload();
      expect(d).toMatchObject({ status: 'REVOKED', revokeReason: 'Member ended' });
      expect(d.revokedAt).not.toBeNull();
    }
    await c.reload();
    expect(c.status).toBe('ACTIVE');
    expect(await AuditLog.count({ where: { action: 'approvals.delegation.revoked' } })).toBe(2);
    expect(events.filter(e => e.event === 'approvals.delegation.updated').length).toBeGreaterThanOrEqual(2);
    expect(sentTo('approvals.delegation_revoked')).toHaveLength(2);
  });
});

describe('approvals:delegation-sweep (9.1)', () => {
  const make = (endsInHours: number, o: Record<string, unknown> = {}) =>
    ApprovalDelegation.create({
      societyId: w.society.id!,
      delegatorUserId: w.people.chairman!.id,
      delegateUserId: w.people.treasurer!.id,
      source: 'TERM_HANDOVER',
      types: null,
      maxAmountPaise: null,
      startsAt: new Date(T0 - H),
      endsAt: new Date(T0 + endsInHours * H),
      reason: 'Away',
      ...o,
    } as never);

  it('expires ended delegations once and writes audit', async () => {
    const d = await make(1);
    at(2);
    expect(await runDelegationSweep()).toMatchObject({ expired: 1 });
    await d.reload();
    expect(d.status).toBe('EXPIRED');
    expect(await AuditLog.count({ where: { action: 'approvals.delegation.expired' } })).toBe(1);
    expect(await runDelegationSweep()).toMatchObject({ expired: 0 });
    expect(await AuditLog.count({ where: { action: 'approvals.delegation.expired' } })).toBe(1);
  });

  it('notifies delegator and delegate once, 24 hours before the end', async () => {
    const far = await make(72);
    const near = await make(20);
    expect(await runDelegationSweep()).toMatchObject({ notified: 1, expired: 0 });
    await settle();
    const sent = sentTo('approvals.delegation_ending');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.userIds.sort()).toEqual([w.people.chairman!.id, w.people.treasurer!.id].sort());
    await near.reload();
    expect(near.endingNotifiedAt).not.toBeNull();
    await far.reload();
    expect(far.endingNotifiedAt).toBeNull();
    expect(await runDelegationSweep()).toMatchObject({ notified: 0 });
  });

  it('skips a closed society and catches up afterwards (BR-14-30)', async () => {
    const d = await make(1);
    await Society.update({ ...lifecycleColumns('CLOSED') } as never, { where: { id: w.society.id! } });
    at(5);
    expect(await runDelegationSweep()).toMatchObject({ expired: 0 });
    await Society.update({ ...lifecycleColumns('ACTIVE') } as never, { where: { id: w.society.id! } });
    expect(await runDelegationSweep()).toMatchObject({ expired: 1 });
    await d.reload();
    expect(d.status).toBe('EXPIRED');
  });
});
