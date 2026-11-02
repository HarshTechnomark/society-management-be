import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  PlatformSetting,
  PlatformTicket,
  PlatformTicketMessage,
  User,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { drainQueues, enqueue, queueRegistry } from '../../../src/lib/queue';
import { clearSettingsCache } from '../../../src/modules/platform-ops/platform-ops.settings.service';
import { JOBS, PLATFORM_OPS_QUEUE } from '../../../src/modules/platform-ops/platform-ops.types';
import { runTicketHousekeeping, runTicketSlaScan } from '../../../src/modules/platform-ops/platform-ops.jobs';
import { memberUser, platformUser, resetLogins } from '../../helpers/access';
import { events } from '../../helpers/auth';
import { insertTicket, opsSociety, resetOps } from '../../helpers/platform-ops';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
});

async function setup() {
  const society = await opsSociety('Sky Heights CHS');
  const raiser = await memberUser(society, 'treasurer', { name: 'Meera Iyer' });
  await User.update({ email: 'meera@skyheights.in' }, { where: { id: raiser.id } });
  const admin = await platformUser('super_admin', { email: 'asha@societyapp.in', name: 'Asha Admin' });
  const agent = await platformUser('platform_support', { email: 'isha@societyapp.in', name: 'Isha Kapoor' });
  return { society, raiser, admin, agent };
}
const mails = async (prefix: string) => (await listInbox()).filter(m => m.subject?.startsWith(prefix));

describe('platform-ops:ticket-sla-scan (BR-07-8)', () => {
  it('T07-14 running twice after a breach sets one stamp and sends one notification per recipient', async () => {
    const { society, raiser, admin, agent } = await setup();
    const t = await insertTicket(society, raiser, { priority: 'HIGH', assigneeUserId: agent.id });
    setNow('2026-10-30T06:30:00Z'); // first response was due 06:00
    const one = await runTicketSlaScan();
    const two = await runTicketSlaScan();
    expect(one).toEqual({ firstResponseBreaches: 1, warnings: 0, resolutionBreaches: 0 });
    expect(two).toEqual({ firstResponseBreaches: 0, warnings: 0, resolutionBreaches: 0 });
    const row = (await PlatformTicket.findByPk(t.id!))!;
    expect(row.firstResponseBreachedAt!.toISOString()).toBe('2026-10-30T06:30:00.000Z');
    const sent = await mails('SLA breached');
    expect(sent.map(m => m.to).sort()).toEqual(['asha@societyapp.in', 'isha@societyapp.in']); // assignee and Super Admins
    void admin;
  });

  it('warns at 80% of the resolution window, once, to the assignee or else the support team', async () => {
    const { society, raiser } = await setup();
    const t = await insertTicket(society, raiser, {
      priority: 'MEDIUM',
      patch: { status: 'IN_PROGRESS', firstRespondedAt: new Date('2026-10-30T05:00:00Z') },
    });
    setNow('2026-11-01T13:40:00Z'); // 57.6 h after creation
    expect(await runTicketSlaScan()).toEqual({
      firstResponseBreaches: 0,
      warnings: 1,
      resolutionBreaches: 0,
    });
    expect(await runTicketSlaScan()).toEqual({
      firstResponseBreaches: 0,
      warnings: 0,
      resolutionBreaches: 0,
    });
    expect((await PlatformTicket.findByPk(t.id!))!.resolutionWarnedAt).not.toBeNull();
    expect((await mails('SLA warning')).map(m => m.to).sort()).toEqual([
      'asha@societyapp.in',
      'isha@societyapp.in',
    ]);
    // later: resolution breach
    setNow('2026-11-02T04:30:00Z');
    expect(await runTicketSlaScan()).toEqual({
      firstResponseBreaches: 0,
      warnings: 0,
      resolutionBreaches: 1,
    });
    expect((await mails('SLA breached')).length).toBe(1);
    expect((await mails('SLA warning')).length).toBe(2); // no new warning
  });

  it('a WAITING ticket is never marked as breaching; a resolved one neither', async () => {
    const { society, raiser } = await setup();
    await insertTicket(society, raiser, {
      status: 'WAITING',
      withPlatformReply: true,
      patch: {
        waitingSince: new Date('2026-10-30T05:00:00Z'),
        firstRespondedAt: new Date('2026-10-30T05:00:00Z'),
      },
    });
    await insertTicket(society, raiser, {
      status: 'RESOLVED',
      subject: 'Resolved one',
      patch: { resolvedAt: new Date() },
    });
    setNow('2026-12-01T00:00:00Z');
    expect(await runTicketSlaScan()).toEqual({
      firstResponseBreaches: 0,
      warnings: 0,
      resolutionBreaches: 0,
    });
  });

  it('a disabled assignee falls back to the support team for the warning (edge case)', async () => {
    const { society, raiser, agent } = await setup();
    await User.update({ status: 'DISABLED' }, { where: { id: agent.id } });
    await insertTicket(society, raiser, {
      priority: 'HIGH',
      assigneeUserId: agent.id,
      patch: { status: 'IN_PROGRESS', firstRespondedAt: new Date('2026-10-30T04:30:00Z') },
    });
    setNow('2026-10-31T00:00:00Z'); // 20 h of 24 h
    await runTicketSlaScan();
    expect((await mails('SLA warning')).map(m => m.to)).toEqual(['asha@societyapp.in']); // Platform Support has no ACTIVE user left except the admin? admin holds tickets.edit too
  });

  it('runs through the queue as a registered repeatable job', async () => {
    expect(queueRegistry.has(PLATFORM_OPS_QUEUE)).toBe(true);
    const { society, raiser } = await setup();
    const t = await insertTicket(society, raiser, { priority: 'HIGH' });
    setNow('2026-10-30T07:00:00Z');
    await enqueue(PLATFORM_OPS_QUEUE, JOBS.ticketSlaScan, {});
    await drainQueues();
    expect((await PlatformTicket.findByPk(t.id!))!.firstResponseBreachedAt).not.toBeNull();
  });
});

describe('platform-ops:ticket-housekeeping (BR-07-12)', () => {
  it('T07-15 WAITING for 14 days without a reply becomes RESOLVED, then 7 days later CLOSED with AUTO_CLOSED', async () => {
    const { society, raiser } = await setup();
    const t = await insertTicket(society, raiser, {
      status: 'WAITING',
      withPlatformReply: true,
      patch: {
        waitingSince: new Date('2026-10-30T05:00:00Z'),
        firstRespondedAt: new Date('2026-10-30T05:00:00Z'),
        lastSocietyMessageAt: new Date('2026-10-30T04:00:00Z'),
      },
    });
    setNow('2026-11-13T04:59:00Z');
    expect(await runTicketHousekeeping()).toEqual({ autoResolved: 0, autoClosed: 0 });
    setNow('2026-11-13T05:01:00Z');
    expect(await runTicketHousekeeping()).toEqual({ autoResolved: 1, autoClosed: 0 });
    const resolved = (await PlatformTicket.findByPk(t.id!))!;
    expect(resolved).toMatchObject({ status: 'RESOLVED', waitingSince: null, updatedBy: null });
    expect(resolved.pausedMinutes).toBe(14 * 24 * 60 + 1);
    expect(resolved.resolvedAt!.toISOString()).toBe('2026-11-13T05:01:00.000Z');
    const line = (
      await PlatformTicketMessage.findAll({ where: { ticketId: t.id!, kind: 'STATUS_CHANGE' } })
    )[0]!;
    expect(line).toMatchObject({
      authorSide: 'SYSTEM',
      authorName: 'SocietyApp',
      visibility: 'PUBLIC',
      body: 'Resolved automatically because we did not hear back. Reply within 7 days to reopen.',
    });
    expect(
      await AuditLog.count({ where: { action: 'platform.ticket.auto_resolved', societyId: society.id! } }),
    ).toBe(1);
    expect(events.some(e => e.event === 'support.ticket.updated')).toBe(true);
    expect((await mails('TKT-')).some(m => m.subject!.includes('is now resolved'))).toBe(true);
    // not yet 7 days
    setNow('2026-11-20T05:00:00Z');
    expect(await runTicketHousekeeping()).toEqual({ autoResolved: 0, autoClosed: 0 });
    setNow('2026-11-20T05:02:00Z');
    expect(await runTicketHousekeeping()).toEqual({ autoResolved: 0, autoClosed: 1 });
    const closed = (await PlatformTicket.findByPk(t.id!))!;
    expect(closed).toMatchObject({ status: 'CLOSED', closedReason: 'AUTO_CLOSED' });
    expect(closed.closedAt!.toISOString()).toBe('2026-11-20T05:02:00.000Z');
    expect(await AuditLog.count({ where: { action: 'platform.ticket.auto_closed' } })).toBe(1);
    // a second run changes nothing
    expect(await runTicketHousekeeping()).toEqual({ autoResolved: 0, autoClosed: 0 });
  });

  it('a recent society message keeps a WAITING ticket; a ticket that left WAITING meanwhile is skipped', async () => {
    const { society, raiser } = await setup();
    const t = await insertTicket(society, raiser, {
      status: 'WAITING',
      withPlatformReply: true,
      patch: {
        waitingSince: new Date('2026-10-01T05:00:00Z'),
        lastSocietyMessageAt: new Date('2026-10-25T00:00:00Z'),
      },
    });
    setNow('2026-11-05T00:00:00Z'); // 11 days after the last society message
    expect(await runTicketHousekeeping()).toEqual({ autoResolved: 0, autoClosed: 0 });
    setNow('2026-11-09T00:00:01Z');
    await t.update({ status: 'IN_PROGRESS', waitingSince: null });
    expect(await runTicketHousekeeping()).toEqual({ autoResolved: 0, autoClosed: 0 });
  });

  it('uses the stored settings support.waitingAutoResolveDays and support.autoCloseDays', async () => {
    const { society, raiser } = await setup();
    await PlatformSetting.create({
      settingKey: 'support.autoCloseDays',
      category: 'SUPPORT',
      valueType: 'INTEGER',
      valueJson: 3,
      isReadOnly: false,
      description: 'x',
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    await clearSettingsCache();
    const t = await insertTicket(society, raiser, {
      status: 'RESOLVED',
      patch: { resolvedAt: new Date('2026-10-30T04:00:00Z') },
    });
    setNow('2026-11-02T03:59:00Z');
    expect((await runTicketHousekeeping()).autoClosed).toBe(0);
    setNow('2026-11-02T04:01:00Z');
    expect((await runTicketHousekeeping()).autoClosed).toBe(1);
    expect((await PlatformTicket.findByPk(t.id!))!.status).toBe('CLOSED');
  });
});
