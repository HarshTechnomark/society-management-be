import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, PlatformTicket, PlatformTicketMessage, User, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { as, idem, login, memberUser, resetLogins } from '../../helpers/access';
import { events } from '../../helpers/auth';
import { platformAs } from '../../helpers/societies';
import {
  countRows,
  insertTicket,
  opsSociety,
  placeholderAttachment,
  resetOps,
} from '../../helpers/platform-ops';
import { opsPorts } from '../../../src/modules/platform-ops/platform-ops.ports';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
});

async function setup(status: 'ACTIVE' | 'SUSPENDED' | 'TRIAL' = 'ACTIVE') {
  const society = await opsSociety('Sky Heights CHS', status);
  const user = await memberUser(society, 'treasurer', { name: 'Meera Iyer' });
  await User.update({ email: 'meera@skyheights.in' }, { where: { id: user.id } });
  const c = as(await login(user));
  return { society, user, c };
}
const body = (o: Record<string, unknown> = {}) => ({
  subject: 'UPI AutoPay mandate failing for 3 members',
  category: 'PAYMENTS',
  priority: 'HIGH',
  body: 'Three members say the mandate debit failed with "limit exceeded". Please check.',
  ...o,
});

describe('society ticket routes (8.4)', () => {
  it('T07-01 a member with settings.support.create raises a HIGH ticket: TKT number, OPEN, SLA from the setting', async () => {
    const { c, user, society } = await setup();
    const r = await c('post', '/support-tickets', body(), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = r.body.data;
    expect(d.ticketNo).toBe(`TKT-${String(d.id).padStart(6, '0')}`);
    expect(d).toMatchObject({
      status: 'OPEN',
      priority: 'HIGH',
      source: 'ADMIN_APP',
      assignee: null,
      messageCount: 1,
    });
    expect(d.expectedFirstResponseBy).toBe('2026-10-30T06:00:00.000Z');
    expect(d.sla.resolutionDueAt).toBe('2026-10-31T04:00:00.000Z');
    expect(d.version).toBeUndefined();
    expect(d.sla.firstResponseBreachedAt).toBeUndefined();
    expect(d.messages).toHaveLength(1);
    expect(d.messages[0]).toMatchObject({
      authorSide: 'SOCIETY',
      authorName: 'Meera Iyer, Treasurer, Sky Heights CHS',
    });
    const row = (await PlatformTicket.findByPk(d.id))!;
    expect(row.societyId).toBe(society.id);
    expect(row.raisedByUserId).toBe(user.id);
    expect(
      await AuditLog.count({ where: { action: 'platform.ticket.created', societyId: society.id! } }),
    ).toBe(1);
    expect(events.some(e => e.room === 'platform:support' && e.event === 'platform.ticket.created')).toBe(
      true,
    );
    const mail = await listInbox();
    expect(
      mail.find(m => m.to === 'meera@skyheights.in' && m.subject!.startsWith('We received your request')),
    ).toBeTruthy();
  });

  it('BR-07-4 changing the SLA setting affects new tickets only', async () => {
    const { c } = await setup();
    const first = await c('post', '/support-tickets', body(), { headers: idem() });
    const sa = await platformAs('super_admin');
    const cur = await sa.c('get', '/platform/settings');
    const v = cur.body.data.categories.SUPPORT.find((s: any) => s.key === 'support.slaHours').version;
    const sla = {
      HIGH: { firstResponse: 4, resolution: 48 },
      MEDIUM: { firstResponse: 8, resolution: 72 },
      LOW: { firstResponse: 24, resolution: 120 },
    };
    const p = await sa.c('patch', '/platform/settings', {
      changes: [{ key: 'support.slaHours', value: sla, version: v }],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const second = await c('post', '/support-tickets', body({ subject: 'Second ticket here' }), {
      headers: idem(),
    });
    expect(second.body.data.expectedFirstResponseBy).toBe('2026-10-30T08:00:00.000Z');
    expect((await c('get', `/support-tickets/${first.body.data.id}`)).body.data.expectedFirstResponseBy).toBe(
      '2026-10-30T06:00:00.000Z',
    );
  });

  it('T07-02 a member of society A gets 404 TICKET_NOT_FOUND for the ticket of society B', async () => {
    const a = await setup();
    const b = await opsSociety('Green Park CHS');
    const bu = await memberUser(b, 'treasurer', { name: 'Ritu' });
    const t = await insertTicket(b, bu);
    for (const [m, p, data] of [
      ['get', `/support-tickets/${t.id}`],
      ['post', `/support-tickets/${t.id}/messages`, { body: 'hello there' }],
      ['post', `/support-tickets/${t.id}/reopen`, { body: 'please reopen this one' }],
      ['post', `/support-tickets/${t.id}/close`, {}],
      ['post', `/support-tickets/${t.id}/rating`, { rating: 5 }],
    ] as const) {
      const r = await a.c(m, p, data, { headers: idem() });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.code).toBe('TICKET_NOT_FOUND');
    }
    const list = await a.c('get', '/support-tickets');
    expect(list.body.data).toEqual([]);
  });

  it('T07-03 a member without settings.support.view gets 403 PERMISSION_DENIED', async () => {
    const society = await opsSociety();
    const auditor = await memberUser(society, 'auditor');
    const c = as(await login(auditor));
    const r = await c('get', '/support-tickets');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
    expect((await c('post', '/support-tickets', body(), { headers: idem() })).status).toBe(403);
  });

  it('a committee member can view but not create (V only)', async () => {
    const society = await opsSociety();
    const u = await memberUser(society, 'committee_member');
    const c = as(await login(u));
    expect((await c('get', '/support-tickets')).status).toBe(200);
    expect((await c('post', '/support-tickets', body(), { headers: idem() })).body.code).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('T07-04 the 26th open ticket is 422 TOO_MANY_OPEN_TICKETS', async () => {
    const { c, society, user } = await setup();
    const old = new Date('2026-10-20T04:00:00Z');
    for (let i = 0; i < 25; i++)
      await insertTicket(society, user, { createdAt: old, subject: `Old ticket ${i}` });
    const r = await c('post', '/support-tickets', body(), { headers: idem() });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('TOO_MANY_OPEN_TICKETS');
    // a resolved ticket does not count
    await PlatformTicket.update({ status: 'RESOLVED' }, { where: { subject: 'Old ticket 0' } });
    expect((await c('post', '/support-tickets', body(), { headers: idem() })).status).toBe(201);
  });

  it('BR-07-3 more than 20 tickets in 24 hours is 429 RATE_LIMITED', async () => {
    const { c, society, user } = await setup();
    for (let i = 0; i < 20; i++)
      await insertTicket(society, user, {
        status: 'RESOLVED',
        subject: `Recent ticket ${i}`,
        createdAt: new Date('2026-10-30T01:00:00Z'),
      });
    const r = await c('post', '/support-tickets', body(), { headers: idem() });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    expect(r.headers['retry-after']).toBeDefined();
    await PlatformTicket.update({ createdAt: new Date('2026-10-29T03:00:00Z') }, { where: {} });
    expect((await c('post', '/support-tickets', body(), { headers: idem() })).status).toBe(201);
  });

  it('T07-13 a suspended society can raise, reply and close tickets (no 423)', async () => {
    const { c } = await setup('SUSPENDED');
    const r = await c('post', '/support-tickets', body(), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.data.id;
    expect(
      (await c('post', `/support-tickets/${id}/messages`, { body: 'Please hurry up' }, { headers: idem() }))
        .status,
    ).toBe(201);
    expect((await c('post', `/support-tickets/${id}/close`, { reason: 'Sorted out' })).status).toBe(200);
  });

  it('validation: subject, body and attachment limits, unknown fields, idempotency', async () => {
    const { c } = await setup();
    const bad = await c('post', '/support-tickets', body({ subject: 'abc', body: 'short', extra: 1 }), {
      headers: idem(),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const fields = bad.body.errors.map((e: any) => e.field).sort();
    expect(fields).toEqual(['body', 'extra', 'subject']);
    expect(
      (await c('post', '/support-tickets', body({ fileIds: [1, 2, 3, 4, 5, 6] }), { headers: idem() }))
        .status,
    ).toBe(400);
    expect((await c('post', '/support-tickets', body())).status).toBe(400); // Idempotency-Key missing
    const key = idem();
    const one = await c('post', '/support-tickets', body(), { headers: key });
    const two = await c('post', '/support-tickets', body(), { headers: key });
    expect(two.body.data.id).toBe(one.body.data.id);
    expect(await countRows('platform_tickets')).toBe(1);
  });

  it('BR-07-15 attachments are linked to the message, FILE_NOT_LINKABLE otherwise', async () => {
    const { c, user, society } = await setup();
    placeholderAttachment(9012, user.id, society.id!);
    const bad = await c('post', '/support-tickets', body({ fileIds: [777] }), { headers: idem() });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('FILE_NOT_LINKABLE');
    expect(await countRows('platform_tickets')).toBe(0);
    const r = await c('post', '/support-tickets', body({ fileIds: [9012] }), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.messages[0].attachments).toEqual([
      {
        fileId: 9012,
        originalName: 'mandate-error.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        status: 'CLEAN',
      },
    ]);
    expect((await PlatformTicketMessage.findOne())!.attachmentCount).toBe(1);
    // the same file cannot be linked twice
    const again = await c('post', '/support-tickets', body({ fileIds: [9012] }), { headers: idem() });
    expect(again.body.code).toBe('FILE_NOT_LINKABLE');
    void opsPorts;
  });

  it('list filters by status and searches by number or subject', async () => {
    const { c, society, user } = await setup();
    const a = await insertTicket(society, user, { subject: 'First problem here' });
    await insertTicket(society, user, { subject: 'Second problem here', status: 'RESOLVED' });
    const open = await c('get', '/support-tickets', undefined, { query: { status: 'OPEN,IN_PROGRESS' } });
    expect(open.body.data.map((t: any) => t.subject)).toEqual(['First problem here']);
    expect(open.body.pagination.total).toBe(1);
    const byNo = await c('get', '/support-tickets', undefined, {
      query: { q: `TKT-${String(a.id).padStart(6, '0')}` },
    });
    expect(byNo.body.data).toHaveLength(1);
    const bySubject = await c('get', '/support-tickets', undefined, { query: { q: 'second' } });
    expect(bySubject.body.data).toHaveLength(1);
    expect((await c('get', '/support-tickets', undefined, { query: { status: 'NOPE' } })).status).toBe(400);
  });

  it('BR-07-10 a society message on a WAITING ticket moves it to IN_PROGRESS and settles the pause (T07-08)', async () => {
    setNow('2026-10-30T15:30:00Z');
    const { c, society, user } = await setup();
    const t = await insertTicket(society, user, {
      status: 'WAITING',
      createdAt: new Date('2026-10-30T04:00:00Z'),
      withPlatformReply: true,
      patch: {
        waitingSince: new Date('2026-10-30T12:00:00Z'),
        firstRespondedAt: new Date('2026-10-30T05:00:00Z'),
      },
    });
    const before = (await PlatformTicket.findByPk(t.id!))!;
    const r = await c(
      'post',
      `/support-tickets/${t.id}/messages`,
      { body: 'It is the main gate.' },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = (await PlatformTicket.findByPk(t.id!))!;
    expect(after.status).toBe('IN_PROGRESS');
    expect(after.pausedMinutes).toBe(210);
    expect(after.waitingSince).toBeNull();
    expect(after.resolutionDueAt.getTime() - before.resolutionDueAt.getTime()).toBe(210 * 60_000);
    expect(after.lastSocietyMessageAt!.toISOString()).toBe('2026-10-30T15:30:00.000Z');
    expect(
      (await PlatformTicketMessage.findAll({ where: { ticketId: t.id!, kind: 'STATUS_CHANGE' } })).map(
        m => m.meta,
      ),
    ).toEqual([{ from: 'WAITING', to: 'IN_PROGRESS' }]);
    expect(events.some(e => e.room === 'platform:support' && e.event === 'platform.ticket.updated')).toBe(
      true,
    );
  });

  it('BR-07-11 reopen: allowed within the window, restarts the clock, counts, then limit and window errors', async () => {
    const { c, society, user } = await setup();
    const t = await insertTicket(society, user, {
      status: 'RESOLVED',
      withPlatformReply: true,
      patch: {
        resolvedAt: new Date('2026-10-30T03:00:00Z'),
        firstRespondedAt: new Date('2026-10-30T03:00:00Z'),
      },
    });
    const view = await c('get', `/support-tickets/${t.id}`);
    expect(view.body.data.reopenAllowedUntil).toBe('2026-11-06T03:00:00.000Z');
    expect((await c('post', `/support-tickets/${t.id}/reopen`, { body: 'short' })).status).toBe(400);
    const r = await c('post', `/support-tickets/${t.id}/reopen`, {
      body: 'The issue came back after the fix.',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'IN_PROGRESS', reopenCount: 1, resolvedAt: null });
    const row = (await PlatformTicket.findByPk(t.id!))!;
    expect(row.resolutionDueAt.toISOString()).toBe('2026-11-02T04:00:00.000Z'); // now + 72 h (MEDIUM)
    expect(await AuditLog.count({ where: { action: 'platform.ticket.reopened' } })).toBe(1);
    // not resolved any more
    const again = await c('post', `/support-tickets/${t.id}/reopen`, { body: 'Reopening one more time' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE');
    // limit
    await row.update({ status: 'RESOLVED', resolvedAt: new Date('2026-10-30T03:00:00Z'), reopenCount: 5 });
    const lim = await c('post', `/support-tickets/${t.id}/reopen`, { body: 'Reopening one more time' });
    expect(lim.status).toBe(422);
    expect(lim.body.code).toBe('REOPEN_LIMIT_REACHED');
  });

  it('T07-11 reopen 8 days after resolve is 422 REOPEN_WINDOW_EXPIRED (also through a reply)', async () => {
    const { c, society, user } = await setup();
    const t = await insertTicket(society, user, {
      status: 'RESOLVED',
      patch: { resolvedAt: new Date('2026-10-22T03:00:00Z') },
    });
    const r = await c('post', `/support-tickets/${t.id}/reopen`, {
      body: 'The issue came back after the fix.',
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('REOPEN_WINDOW_EXPIRED');
    const m = await c(
      'post',
      `/support-tickets/${t.id}/messages`,
      { body: 'The issue came back after the fix.' },
      { headers: idem() },
    );
    expect(m.body.code).toBe('REOPEN_WINDOW_EXPIRED');
  });

  it('a society reply on a RESOLVED ticket reopens it (BR-07-10)', async () => {
    const { c, society, user } = await setup();
    const t = await insertTicket(society, user, {
      status: 'RESOLVED',
      patch: { resolvedAt: new Date('2026-10-29T03:00:00Z') },
    });
    const r = await c(
      'post',
      `/support-tickets/${t.id}/messages`,
      { body: 'It broke again after the update.' },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.ticket.status).toBe('IN_PROGRESS');
    expect((await PlatformTicket.findByPk(t.id!))!.reopenCount).toBe(1);
  });

  it('close: from any open state, settles WAITING, CLOSED is final (409 TICKET_CLOSED), then rating', async () => {
    const { c, society, user } = await setup();
    const t = await insertTicket(society, user, {
      status: 'WAITING',
      patch: { waitingSince: new Date('2026-10-30T02:00:00Z') },
    });
    expect((await c('post', `/support-tickets/${t.id}/rating`, { rating: 4 })).body.code).toBe(
      'INVALID_STATE',
    );
    const r = await c('post', `/support-tickets/${t.id}/close`, { reason: 'Not needed any more' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'CLOSED', closedReason: 'CLOSED_BY_SOCIETY' });
    const row = (await PlatformTicket.findByPk(t.id!))!;
    expect(row.pausedMinutes).toBe(120);
    expect(row.waitingSince).toBeNull();
    for (const [p, d] of [
      ['messages', { body: 'Anyone there?' }],
      ['close', {}],
      ['reopen', { body: 'Please reopen this one' }],
    ] as const) {
      const x = await c('post', `/support-tickets/${t.id}/${p}`, d, { headers: idem() });
      expect(x.status, p).toBe(409);
      expect(x.body.code, p).toBe('TICKET_CLOSED');
    }
    // rating once, 1 to 5
    expect((await c('post', `/support-tickets/${t.id}/rating`, { rating: 6 })).status).toBe(400);
    const rate = await c('post', `/support-tickets/${t.id}/rating`, { rating: 5, comment: 'Quick help' });
    expect(rate.status).toBe(200);
    expect(rate.body.data).toMatchObject({ satisfactionRating: 5, satisfactionComment: 'Quick help' });
    const twice = await c('post', `/support-tickets/${t.id}/rating`, { rating: 3 });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('RATING_ALREADY_GIVEN');
    expect(await AuditLog.count({ where: { action: 'platform.ticket.rated' } })).toBe(1);
  });

  it('T07-05/06 an internal note is hidden from the society, sends nothing, and its audit row has no society', async () => {
    const { c, society, user } = await setup();
    const sa = await platformAs('platform_support');
    const t = await insertTicket(society, user);
    const note = await sa.c(
      'post',
      `/platform/tickets/${t.id}/messages`,
      { body: 'Root cause: bad cache', visibility: 'INTERNAL' },
      { headers: idem() },
    );
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    const view = await c('get', `/support-tickets/${t.id}`);
    expect(JSON.stringify(view.body)).not.toContain('Root cause');
    expect(view.body.data.messages).toHaveLength(1);
    const row = (await AuditLog.findOne({ where: { action: 'platform.ticket.message_added' } }))!;
    expect(row.societyId).toBeNull();
    expect(JSON.stringify(row.after)).not.toContain('Root cause');
    expect(events.filter(e => e.event === 'support.ticket.updated')).toEqual([]);
    expect((await listInbox()).filter(m => m.subject?.startsWith('New reply'))).toEqual([]);
    // T07-06: the society audit trail (rows of its own society) never sees it
    expect(
      await AuditLog.count({ where: { societyId: society.id!, action: 'platform.ticket.message_added' } }),
    ).toBe(0);
    // the internal note did not count as a first response
    expect((await PlatformTicket.findByPk(t.id!))!.firstRespondedAt).toBeNull();
  });
});
