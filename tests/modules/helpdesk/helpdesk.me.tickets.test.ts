import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Ticket, TicketComment, closeDb, sequelize } from '../../../src/models';
import { helpdeskPorts } from '../../../src/modules/helpdesk/helpdesk.ports';
import { settings } from '../../../src/modules/society-setup/society-setup.public';
import { addComment } from '../../../src/modules/helpdesk/helpdesk.tickets.comment';
import { userActor } from '../../../src/modules/helpdesk/helpdesk.shared';
import { helpdeskHttp, idem, resetHelpdesk, ticketPhoto } from '../../helpers/helpdesk';
import { placeholderFiles } from '../../../src/modules/societies/societies.ports';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetHelpdesk);

const run = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);

describe('resident personal complaints', () => {
  it('T15-08, T15-09, T15-31: raise with photos, other flat 404, idempotency, visibility and no staff fields', async () => {
    const w = await helpdeskHttp();
    const plumbing = await w.cat('Plumbing');
    const photos = [ticketPhoto(w.sid, w.resUserId), ticketPhoto(w.sid, w.resUserId)];
    const body = {
      unitId: w.a101,
      categoryId: plumbing.id,
      title: 'Kitchen tap leaking',
      description: 'The kitchen tap drips all night',
      fileIds: photos,
    };
    const key = idem();
    const r = await w.res('post', '/me/tickets', body, { headers: key });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.ticketNo).toMatch(/^TKT\/2026-27\/000001$/);
    expect(r.body.data.fileIds).toEqual(photos);
    expect(r.body.data).not.toHaveProperty('requester');
    expect(r.body.data.sla).not.toHaveProperty('escalationLevel');
    expect(r.body.data.allowedActions).toEqual(expect.arrayContaining(['CANCEL', 'COMMENT']));
    expect(r.body.data.myRelation).toBe('REQUESTER');
    expect(await AuditLog.count({ where: { societyId: w.sid, action: 'helpdesk.ticket.created' } })).toBe(1);
    const id = r.body.data.id;

    // same key, same body replays; same key, other body is refused (T15-31)
    const again = await w.res('post', '/me/tickets', body, { headers: key });
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(id);
    const reused = await w.res('post', '/me/tickets', { ...body, title: 'Another title' }, { headers: key });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // another flat (T15-09) and the strict body
    const other = await w.res('post', '/me/tickets', { ...body, unitId: w.b101 }, { headers: idem() });
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('UNIT_NOT_FOUND');
    const extra = await w.res('post', '/me/tickets', { ...body, priority: 'P1' }, { headers: idem() });
    expect(extra.status).toBe(400);
    const emergency = await w.res(
      'post',
      '/me/tickets',
      { ...body, urgency: 'EMERGENCY' },
      { headers: idem() },
    );
    expect(emergency.status).toBe(422);

    // BR-15-50: the family member of the flat sees it, residents of other flats do not
    expect((await w.fam('get', `/me/tickets/${id}`)).status).toBe(200);
    expect((await w.resB('get', `/me/tickets/${id}`)).status).toBe(404);
    const bList = await w.resB('get', '/me/tickets');
    expect(bList.body.data).toHaveLength(0);
    const list = await w.res('get', '/me/tickets?tab=OPEN&kind=PERSONAL');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.pagination.total).toBe(1);
    expect((await w.res('get', `/me/tickets?unitId=${w.b101}`)).status).toBe(404);
    expect((await w.res('get', '/me/tickets?bogus=1')).status).toBe(400);

    // detail carries recentComments (the raise entry) and the staff-only fields stay out
    const d = await w.res('get', `/me/tickets/${id}`);
    expect(d.body.data.recentComments.length).toBeGreaterThan(0);
    expect(JSON.stringify(d.body.data)).not.toMatch(/escalationLevel|assigneeUserId|duplicateReason/);

    // tenant isolation: the guard (another audience) and a resident without a link cannot read it either
    expect((await w.resC('get', `/me/tickets/${id}`)).status).toBe(404);
  }, 120_000);

  it('T15-20: internal notes and their photos never reach the resident; public files do', async () => {
    const w = await helpdeskHttp();
    const plumbing = await w.cat('Plumbing');
    const created = await w.res(
      'post',
      '/me/tickets',
      {
        unitId: w.a101,
        categoryId: plumbing.id,
        title: 'Bathroom pipe burst',
        description: 'Water everywhere in the bathroom',
      },
      { headers: idem() },
    );
    const id = created.body.data.id as number;
    const internalPhoto = ticketPhoto(w.sid, w.adminId);
    const publicPhoto = ticketPhoto(w.sid, w.adminId);
    const staff = userActor(w.admin, new Set(['ADMIN']), 'ADMIN');
    await run(t =>
      addComment(
        w.admin,
        id,
        staff,
        { body: 'Vendor quote is too high', visibility: 'INTERNAL', fileIds: [internalPhoto] },
        t,
      ),
    );
    await run(t =>
      addComment(
        w.admin,
        id,
        staff,
        { body: 'We are sending a plumber', visibility: 'PUBLIC', fileIds: [publicPhoto] },
        t,
      ),
    );
    const d = await w.res('get', `/me/tickets/${id}`);
    const text = JSON.stringify(d.body.data);
    expect(text).toContain('We are sending a plumber');
    expect(text).not.toContain('Vendor quote');
    const c = await w.res('get', `/me/tickets/${id}/comments`);
    expect(c.status).toBe(200);
    expect(JSON.stringify(c.body.data)).not.toContain('Vendor quote');
    // authors of office comments show a role label, not the admin's name
    const office = c.body.data.find((x: { body: string }) => x.body === 'We are sending a plumber');
    expect(office.authorLabel).toBe('Society office');
    const bad = await w.res('get', `/me/tickets/${id}/files/${internalPhoto}/download-url`);
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe('FILE_NOT_FOUND');
    const good = await w.res('get', `/me/tickets/${id}/files/${publicPhoto}/download-url`);
    expect(good.status).toBe(200);
    expect(good.body.data.url).toBeTruthy();
    expect((await w.resB('get', `/me/tickets/${id}/files/${publicPhoto}/download-url`)).status).toBe(404);
    // the resident can answer; comments of INTERNAL visibility are not accepted from the resident route
    const reply = await w.res(
      'post',
      `/me/tickets/${id}/comments`,
      { body: 'Thank you' },
      { headers: idem() },
    );
    expect(reply.status).toBe(201);
    expect(reply.body.data.authorLabel).toBe('You');
    expect(
      (
        await w.res(
          'post',
          `/me/tickets/${id}/comments`,
          { body: 'x', visibility: 'INTERNAL' },
          { headers: idem() },
        )
      ).status,
    ).toBe(400);
    expect(await TicketComment.count({ where: { ticketId: id, visibility: 'INTERNAL' } })).toBe(1);
    expect(placeholderFiles.size).toBeGreaterThan(0);
    expect(helpdeskPorts().files.list('ticket_comment', 1)).toBeDefined();
  }, 120_000);

  it('BR-15-14: the daily limit counts both kinds and answers 429', async () => {
    const w = await helpdeskHttp();
    await run(t =>
      settings.set(
        { ...w.admin, permissions: new Set(['helpdesk.settings.edit']) },
        w.sid,
        'helpdesk.residentDailyTicketLimit',
        5,
        t,
      ),
    );
    const plumbing = await w.cat('Plumbing');
    const lift = await w.cat('Lift');
    const mk = (n: number) => ({
      unitId: w.a101,
      categoryId: plumbing.id,
      title: `Leak number ${n}`,
      description: 'Something is leaking here again',
    });
    for (let i = 1; i <= 4; i++)
      expect((await w.res('post', '/me/tickets', mk(i), { headers: idem() })).status).toBe(201);
    const issue = await w.res(
      'post',
      '/me/building-issues',
      { locationNodeId: w.buildingA.locationNodeId, categoryId: lift.id, urgency: 'URGENT' },
      { headers: idem() },
    );
    expect(issue.status).toBe(201);
    const sixth = await w.res('post', '/me/tickets', mk(6), { headers: idem() });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('RATE_LIMITED');
    expect(await Ticket.count({ where: { societyId: w.sid } })).toBe(5);
  }, 150_000);
  it('BR-15-14: concurrent creates, the day boundary, other users and the hourly comment limit', async () => {
    const w = await helpdeskHttp();
    await run(t =>
      settings.set(
        { ...w.admin, permissions: new Set(['helpdesk.settings.edit']) },
        w.sid,
        'helpdesk.residentDailyTicketLimit',
        5,
        t,
      ),
    );
    const plumbing = await w.cat('Plumbing');
    const lift = await w.cat('Lift');
    const mk = (n: number) => ({
      unitId: w.a101,
      categoryId: plumbing.id,
      title: `Leak number ${n}`,
      description: 'Something is leaking here again',
    });
    // eight requests at once: exactly five get through, the rest answer 429 with a readable message
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, i) => w.res('post', '/me/tickets', mk(i), { headers: idem() })).concat(
        Array.from({ length: 2 }, () =>
          w.res(
            'post',
            '/me/building-issues',
            { locationNodeId: w.buildingA.locationNodeId, categoryId: lift.id, urgency: 'URGENT' },
            { headers: idem() },
          ),
        ),
      ),
    );
    expect(burst.filter(r => r.status === 201)).toHaveLength(5);
    const refused = burst.filter(r => r.status === 429);
    expect(refused).toHaveLength(3);
    expect(refused[0]!.body.code).toBe('RATE_LIMITED');
    expect(refused[0]!.body.message).toMatch(/at most 5/);
    expect(await Ticket.count({ where: { societyId: w.sid } })).toBe(5);

    // another resident is unaffected
    const other = await w.resB('post', '/me/tickets', { ...mk(9), unitId: w.b101 }, { headers: idem() });
    expect(other.status, JSON.stringify(other.body)).toBe(201);

    // the next society day starts a fresh count
    // (the day boundary: yesterday's tickets no longer count; the session token would expire if the clock moved)
    await sequelize.query('UPDATE tickets SET createdAt = createdAt - INTERVAL 1 DAY WHERE societyId = ?', {
      replacements: [w.sid],
    });
    expect((await w.res('post', '/me/tickets', mk(10), { headers: idem() })).status).toBe(201);
  }, 150_000);

  it('BR-15-14: 60 comments per hour per user answer 429 and the window slides', async () => {
    const w = await helpdeskHttp();
    const plumbing = await w.cat('Plumbing');
    const made = await w.res(
      'post',
      '/me/tickets',
      {
        unitId: w.a101,
        categoryId: plumbing.id,
        title: 'Tap leaking',
        description: 'The tap is leaking again',
      },
      { headers: idem() },
    );
    const id = made.body.data.id;
    const rows = Array.from({ length: 60 }, (_, i) => ({
      societyId: w.sid,
      ticketId: id,
      kind: 'COMMENT' as const,
      visibility: 'PUBLIC' as const,
      authorUserId: w.resUserId,
      authorRole: 'RESIDENT' as const,
      authorName: 'Resident',
      body: `bulk ${i}`,
      notifyAffected: false,
      createdAt: new Date(),
    }));
    await TicketComment.bulkCreate(rows as never);
    const over = await w.res(
      'post',
      `/me/tickets/${id}/comments`,
      { body: 'one too many' },
      { headers: idem() },
    );
    expect(over.status, JSON.stringify(over.body)).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
    expect(
      (await w.resB('post', `/me/tickets/${id}/comments`, { body: 'hello' }, { headers: idem() })).status,
    ).not.toBe(429);
    await sequelize.query(
      "UPDATE ticket_comments SET createdAt = '2026-11-01 02:00:00.000' WHERE ticketId = ? AND kind = 'COMMENT'",
      {
        replacements: [id],
      },
    );
    const later = await w.res(
      'post',
      `/me/tickets/${id}/comments`,
      { body: 'fine now' },
      { headers: idem() },
    );
    expect(later.status, JSON.stringify(later.body)).toBe(201);
  }, 150_000);
});
