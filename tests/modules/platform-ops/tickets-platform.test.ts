import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  PlatformTicket,
  PlatformTicketMessage,
  SocietyMember,
  User,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { as, idem, login, memberUser, resetLogins } from '../../helpers/access';
import { events } from '../../helpers/auth';
import { platformAs } from '../../helpers/societies';
import { insertTicket, opsSociety, placeholderAttachment, resetOps } from '../../helpers/platform-ops';

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
  const agent = await platformAs('platform_support', 'Isha Kapoor');
  const admin = await platformAs('super_admin', 'Asha Admin');
  return { society, raiser, agent, admin };
}
const msg = (c: any, id: number, body: Record<string, unknown>) =>
  c('post', `/platform/tickets/${id}/messages`, body, { headers: idem() });

describe('platform ticket routes (8.3)', () => {
  it('T07-07 the first PUBLIC reply on an unassigned OPEN ticket: IN_PROGRESS, assignee = replier, firstRespondedAt', async () => {
    const { society, raiser, agent } = await setup();
    const t = await insertTicket(society, raiser, { priority: 'HIGH' });
    setNow('2026-10-30T04:10:00Z');
    const r = await msg(agent.c, t.id!, { body: 'We are checking the mandate limits now.' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.ticket).toMatchObject({
      status: 'IN_PROGRESS',
      version: 2,
      assignee: { id: agent.user.id, name: 'Isha Kapoor' },
    });
    expect(r.body.data.message).toMatchObject({
      authorSide: 'PLATFORM',
      visibility: 'PUBLIC',
      kind: 'MESSAGE',
    });
    const row = (await PlatformTicket.findByPk(t.id!))!;
    expect(row.firstRespondedAt!.toISOString()).toBe('2026-10-30T04:10:00.000Z');
    expect(row.lastPlatformMessageAt).not.toBeNull();
    expect(row.messageCount).toBe(2);
    const kinds = (
      await PlatformTicketMessage.findAll({ where: { ticketId: t.id! }, order: [['id', 'ASC']] })
    ).map(m => `${m.kind}:${m.visibility}`);
    expect(kinds).toEqual([
      'MESSAGE:PUBLIC',
      'MESSAGE:PUBLIC',
      'STATUS_CHANGE:PUBLIC',
      'ASSIGNMENT:INTERNAL',
    ]);
    expect(
      events.some(e => e.room === `society:${society.id}:admin` && e.event === 'support.ticket.updated'),
    ).toBe(true);
    expect(events.some(e => e.room === `user:${raiser.id}` && e.event === 'support.ticket.updated')).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain('mandate limits');
    const mail = await listInbox();
    expect(
      mail.find(m => m.to === 'meera@skyheights.in' && m.subject!.startsWith('New reply on TKT-')),
    ).toBeTruthy();
    const a = await AuditLog.findOne({ where: { action: 'platform.ticket.message_added' } });
    expect(a!.societyId).toBe(society.id);
    expect(a!.after).toEqual({ messageId: r.body.data.message.id, visibility: 'PUBLIC' });
  });

  it('a PUBLIC reply on a RESOLVED ticket does not change its status; a closed ticket refuses messages', async () => {
    const { society, raiser, agent } = await setup();
    const t = await insertTicket(society, raiser, {
      status: 'RESOLVED',
      withPlatformReply: true,
      patch: { resolvedAt: new Date() },
    });
    const r = await msg(agent.c, t.id!, { body: 'Just checking that this is fine.' });
    expect(r.body.data.ticket.status).toBe('RESOLVED');
    await t.update({ status: 'CLOSED' });
    const x = await msg(agent.c, t.id!, { body: 'Anything else to add here?' });
    expect(x.status).toBe(409);
    expect(x.body.code).toBe('TICKET_CLOSED');
  });

  it('T07-09 WAITING and RESOLVED need a PUBLIC platform reply (internal notes do not count)', async () => {
    const { society, raiser, agent } = await setup();
    const t = await insertTicket(society, raiser);
    for (const status of ['RESOLVED', 'WAITING']) {
      const r = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, status });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PUBLIC_REPLY_REQUIRED');
    }
    await msg(agent.c, t.id!, { body: 'Internal thoughts only', visibility: 'INTERNAL' });
    const again = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 2, status: 'RESOLVED' });
    expect(again.body.code).toBe('PUBLIC_REPLY_REQUIRED');
    await msg(agent.c, t.id!, { body: 'We have fixed the template.' });
    const ok = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 3, status: 'RESOLVED' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'RESOLVED' });
    expect(ok.body.data.resolvedAt).toBe('2026-10-30T04:00:00.000Z');
    expect(ok.body.data.messages.at(-1)).toMatchObject({ kind: 'STATUS_CHANGE', visibility: 'PUBLIC' });
    const mail = await listInbox();
    expect(mail.some(m => m.subject!.includes('is now resolved'))).toBe(true);
  });

  it('T07-10 PATCH on a CLOSED ticket is 409 TICKET_CLOSED', async () => {
    const { society, raiser, agent } = await setup();
    const t = await insertTicket(society, raiser, { status: 'CLOSED' });
    const r = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, priority: 'LOW' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TICKET_CLOSED');
  });

  it('T07-12 two PATCH calls with the same version: first 200, second 409 STALE_VERSION', async () => {
    const { society, raiser, agent } = await setup();
    const t = await insertTicket(society, raiser);
    expect(
      (await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, category: 'BILLING' })).status,
    ).toBe(200);
    const r = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, category: 'OTHER' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STALE_VERSION');
  });

  it('transitions follow table 6.1; a patch with no change is 400', async () => {
    const { society, raiser, agent } = await setup();
    const t = await insertTicket(society, raiser, {
      status: 'RESOLVED',
      withPlatformReply: true,
      patch: { resolvedAt: new Date() },
    });
    const bad = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, status: 'WAITING' });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('INVALID_STATE');
    const none = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, priority: 'MEDIUM' });
    expect(none.status).toBe(400);
    expect(none.body.errors[0].message).toBe('No changes');
    expect((await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, status: 'OPEN' })).status).toBe(
      400,
    );
    // RESOLVED -> IN_PROGRESS restarts the resolution clock; RESOLVED -> CLOSED needs no reason
    const back = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, status: 'IN_PROGRESS' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data.resolvedAt).toBeNull();
    // closing an open ticket needs a reason, written as the PUBLIC status line
    const noReason = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 2, status: 'CLOSED' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.errors[0].field).toBe('closeReason');
    const closed = await agent.c('patch', `/platform/tickets/${t.id}`, {
      version: 2,
      status: 'CLOSED',
      closeReason: 'Duplicate of an older ticket',
    });
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', closedReason: 'CLOSED_BY_PLATFORM' });
    expect(closed.body.data.messages.at(-1)).toMatchObject({
      kind: 'STATUS_CHANGE',
      visibility: 'PUBLIC',
      body: 'Duplicate of an older ticket',
    });
  });

  it('BR-07-6 moving to WAITING and back adds the paused minutes to the resolution due time', async () => {
    const { society, raiser, agent } = await setup();
    const t = await insertTicket(society, raiser, {
      priority: 'MEDIUM',
      withPlatformReply: true,
      patch: { status: 'IN_PROGRESS', firstRespondedAt: new Date() },
    });
    const due = t.resolutionDueAt.getTime();
    const w = await agent.c('patch', `/platform/tickets/${t.id}`, { version: 1, status: 'WAITING' });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    setNow('2026-10-30T05:30:00Z');
    const late = await platformAs('platform_support', 'Late Agent');
    const r = await late.c('patch', `/platform/tickets/${t.id}`, { version: 2, status: 'IN_PROGRESS' });
    expect(r.body.data.sla.pausedMinutes).toBe(90);
    expect(new Date(r.body.data.sla.resolutionDueAt).getTime() - due).toBe(90 * 60_000);
  });

  it('BR-07-7 a priority change recomputes due times; a past due time keeps its breach (edge case 30 hours)', async () => {
    const { society, raiser, agent } = await setup();
    setNow('2026-10-31T10:00:00Z'); // 30 hours after creation
    const fresh = await platformAs('platform_support', 'Second Agent');
    const t = await insertTicket(society, raiser, {
      priority: 'MEDIUM',
      createdAt: new Date('2026-10-30T04:00:00Z'),
      withPlatformReply: true,
      patch: {
        status: 'IN_PROGRESS',
        firstRespondedAt: new Date('2026-10-30T05:00:00Z'),
        resolutionBreachedAt: null,
      },
    });
    const hi = await fresh.c('patch', `/platform/tickets/${t.id}`, { version: 1, priority: 'HIGH' });
    expect(hi.status, JSON.stringify(hi.body)).toBe(200);
    expect(hi.body.data.sla.resolutionDueAt).toBe('2026-10-31T04:00:00.000Z'); // created + 24 h, now in the past
    expect(hi.body.data.messages.at(-1)).toMatchObject({ kind: 'PRIORITY_CHANGE', visibility: 'INTERNAL' });
    // LOW again: due time moves to the future, so warning and breach stamps clear
    await PlatformTicket.update(
      { resolutionBreachedAt: new Date(), resolutionWarnedAt: new Date() },
      { where: { id: t.id! } },
    );
    const lo = await fresh.c('patch', `/platform/tickets/${t.id}`, { version: 2, priority: 'LOW' });
    expect(lo.body.data.sla).toMatchObject({ resolutionBreachedAt: null, resolutionWarnedAt: null });
    expect(lo.body.data.sla.resolutionDueAt).toBe('2026-11-04T04:00:00.000Z');
    void agent;
  });

  it('BR-07-16 the assignee must be an ACTIVE platform user holding platform.tickets.edit', async () => {
    const { society, raiser, agent, admin } = await setup();
    const t = await insertTicket(society, raiser);
    const society_user = await agent.c('patch', `/platform/tickets/${t.id}`, {
      version: 1,
      assigneeUserId: raiser.id,
    });
    expect(society_user.status).toBe(422);
    expect(society_user.body.code).toBe('ASSIGNEE_NOT_ELIGIBLE');
    const ok = await admin.c('patch', `/platform/tickets/${t.id}`, {
      version: 1,
      assigneeUserId: agent.user.id,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.assignee).toEqual({ id: agent.user.id, name: 'Isha Kapoor' });
    expect(ok.body.data.messages.at(-1)).toMatchObject({ kind: 'ASSIGNMENT', visibility: 'INTERNAL' });
    expect((await listInbox()).some(m => m.subject!.endsWith('is assigned to you'))).toBe(true);
    const other = await platformAs('platform_support', 'Disabled Agent');
    await User.update({ status: 'DISABLED' }, { where: { id: other.user.id } });
    const off = await admin.c('patch', `/platform/tickets/${t.id}`, {
      version: 2,
      assigneeUserId: other.user.id,
    });
    expect(off.status).toBe(422);
    expect(off.body.code).toBe('ASSIGNEE_NOT_ELIGIBLE');
    const un = await admin.c('patch', `/platform/tickets/${t.id}`, { version: 2, assigneeUserId: null });
    expect(un.body.data.assignee).toBeNull();
  });

  it('GET one returns every message including INTERNAL; unknown id is 404', async () => {
    const { society, raiser, agent } = await setup();
    const t = await insertTicket(society, raiser);
    await msg(agent.c, t.id!, { body: 'Do not tell them', visibility: 'INTERNAL' });
    const r = await agent.c('get', `/platform/tickets/${t.id}`);
    expect(r.body.data.messages.map((m: any) => m.visibility)).toEqual(['PUBLIC', 'INTERNAL']);
    expect(r.body.data).toMatchObject({
      society: { id: society.id, name: 'Sky Heights CHS', status: 'ACTIVE' },
      raisedBy: { id: raiser.id, name: 'Meera Iyer', roleKey: 'treasurer' },
    });
    const nf = await agent.c('get', '/platform/tickets/99999999');
    expect(nf.body.code).toBe('TICKET_NOT_FOUND');
  });

  it('POST on behalf of a society (BR-07-19): IN_PROGRESS, assigned to the caller, counts as first response', async () => {
    const { society, raiser, agent } = await setup();
    placeholderAttachment(5001, agent.user.id, society.id!);
    const r = await agent.c(
      'post',
      '/platform/tickets',
      {
        societyId: society.id,
        raisedByUserId: raiser.id,
        subject: 'We noticed your mandate failures',
        category: 'PAYMENTS',
        body: 'Our team saw repeated mandate failures on your account.',
        fileIds: [5001],
      },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      source: 'PLATFORM',
      status: 'IN_PROGRESS',
      priority: 'MEDIUM',
      assignee: { id: agent.user.id },
    });
    expect(r.body.data.sla.firstRespondedAt).toBe('2026-10-30T04:00:00.000Z');
    expect(r.body.data.messages[0].attachments).toHaveLength(1);
    expect(
      (await listInbox()).some(m => m.to === 'meera@skyheights.in' && m.subject!.includes('opened TKT-')),
    ).toBe(true);
    expect(
      await AuditLog.count({ where: { action: 'platform.ticket.created', societyId: society.id! } }),
    ).toBe(1);
  });

  it('POST on behalf: unknown society, closed society, raiser not a member, open limit', async () => {
    const { society, raiser, agent } = await setup();
    const base = {
      raisedByUserId: raiser.id,
      subject: 'Hello from support',
      category: 'OTHER',
      body: 'Our team is writing to you.',
    };
    const post = (o: Record<string, unknown>) =>
      agent.c('post', '/platform/tickets', { ...base, ...o }, { headers: idem() });
    expect((await post({ societyId: 999999 })).body.code).toBe('SOCIETY_NOT_FOUND');
    const closed = await opsSociety('Closed Society', 'CLOSED');
    expect((await post({ societyId: closed.id })).body.code).toBe('SOCIETY_CLOSED');
    const other = await opsSociety('Other Society');
    const stranger = await post({ societyId: other.id });
    expect(stranger.status).toBe(422);
    expect(stranger.body.code).toBe('RAISER_NOT_MEMBER');
    for (let i = 0; i < 25; i++) await insertTicket(society, raiser, { subject: `Existing ticket ${i}` });
    expect((await post({ societyId: society.id })).body.code).toBe('TOO_MANY_OPEN_TICKETS');
  });

  it('list: filters, counts that ignore the status filter, search by number and society name, sorting', async () => {
    const { society, raiser, agent } = await setup();
    const green = await opsSociety('Green Park CHS');
    const gu = await memberUser(green, 'treasurer', { name: 'Ritu' });
    const a = await insertTicket(society, raiser, {
      priority: 'HIGH',
      subject: 'UPI mandate failing',
      category: 'PAYMENTS',
    });
    await insertTicket(green, gu, {
      priority: 'LOW',
      status: 'RESOLVED',
      subject: 'Import flats help',
      category: 'ONBOARDING',
    });
    await insertTicket(society, raiser, {
      priority: 'MEDIUM',
      status: 'IN_PROGRESS',
      assigneeUserId: agent.user.id,
      subject: 'Guard console',
      patch: { resolutionBreachedAt: new Date() },
    });
    const get = (q: Record<string, string>) => agent.c('get', '/platform/tickets', undefined, { query: q });
    const all = await get({});
    expect(all.body.data.counts).toEqual({
      ALL: 3,
      OPEN: 1,
      IN_PROGRESS: 1,
      WAITING: 0,
      RESOLVED: 1,
      CLOSED: 0,
    });
    expect(all.body.pagination.total).toBe(3);
    const open = await get({ status: 'OPEN', priority: 'HIGH' });
    expect(open.body.data.items.map((t: any) => t.id)).toEqual([a.id]);
    expect(open.body.data.counts.ALL).toBe(1); // priority applies to counts, status does not
    expect((await get({ societyId: String(green.id) })).body.data.items).toHaveLength(1);
    expect((await get({ assignee: 'me' })).body.data.items).toHaveLength(1);
    expect((await get({ assignee: String(agent.user.id) })).body.data.items).toHaveLength(1);
    expect((await get({ assignee: 'none' })).body.data.items).toHaveLength(2);
    expect((await get({ slaBreached: 'true' })).body.data.items.map((t: any) => t.subject)).toEqual([
      'Guard console',
    ]);
    expect((await get({ q: `TKT-${String(a.id).padStart(6, '0')}` })).body.data.items).toHaveLength(1);
    expect((await get({ q: 'mandate' })).body.data.items).toHaveLength(1);
    expect((await get({ q: 'green' })).body.data.items).toHaveLength(1); // society name prefix
    expect((await get({ q: '%%' })).body.data.items).toHaveLength(0); // LIKE wildcards are escaped
    expect((await get({ category: 'ONBOARDING' })).body.data.items).toHaveLength(1);
    expect((await get({ createdFrom: '2026-10-30', createdTo: '2026-10-30' })).body.data.items).toHaveLength(
      3,
    );
    expect((await get({ createdFrom: '2026-10-31' })).body.data.items).toHaveLength(0);
    expect((await get({ createdFrom: '2026-10-31', createdTo: '2026-10-30' })).status).toBe(400);
    const prio = await get({ sortBy: 'priority', sortOrder: 'desc' });
    expect(prio.body.data.items.map((t: any) => t.priority)).toEqual(['HIGH', 'MEDIUM', 'LOW']);
    expect((await get({ sortBy: 'nonsense' })).status).toBe(400);
    expect(all.body.data.items[0].messages).toBeUndefined();
  });

  it('T07-52 a society member is refused every platform ticket route', async () => {
    const { society, raiser } = await setup();
    const t = await insertTicket(society, raiser);
    const chair = await memberUser(society, 'chairman');
    const c = as(await login(chair));
    for (const [m, p] of [
      ['get', '/platform/tickets'],
      ['get', `/platform/tickets/${t.id}`],
      ['post', '/platform/tickets'],
      ['patch', `/platform/tickets/${t.id}`],
      ['post', `/platform/tickets/${t.id}/messages`],
    ] as const) {
      const r = await c(m, p, m === 'get' ? undefined : {}, { headers: idem() });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.code).toBe('PLATFORM_ACCESS_REQUIRED');
    }
  });

  it('edge: when the raiser has left the society, the reply goes to members holding settings.support.create', async () => {
    const { society, raiser, agent } = await setup();
    const other = await memberUser(society, 'secretary', { name: 'Arjun Shah' });
    await User.update({ email: 'arjun@skyheights.in' }, { where: { id: other.id } });
    const t = await insertTicket(society, raiser);
    await SocietyMember.update({ status: 'ENDED' as never, endedAt: new Date() } as never, {
      where: { societyId: society.id!, userId: raiser.id },
    });
    const r = await msg(agent.c, t.id!, { body: 'Thanks for raising this with us.' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const to = (await listInbox()).filter(m => m.subject!.startsWith('New reply on TKT-')).map(m => m.to);
    expect(to).toEqual(['arjun@skyheights.in']);
    expect((await PlatformTicketMessage.findAll({ where: { ticketId: t.id! } }))[0]!.authorName).toContain(
      'Meera Iyer',
    ); // snapshot stays
  });
});
