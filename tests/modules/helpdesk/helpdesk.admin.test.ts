import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, Ticket, TicketAssignment, TicketComment, closeDb } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { sequelize } from '../../../src/models';
import { setHelpdeskPorts } from '../../../src/modules/helpdesk/helpdesk.ports';
import { helpdeskReports, helpdeskWork, tickets } from '../../../src/modules/helpdesk/helpdesk.public';
import { LIMITS } from '../../../src/modules/helpdesk/helpdesk.constants';
import { as, idem, login, memberUser } from '../../helpers/access';
import { setupSociety } from '../../helpers/society-setup';
import { addResident, mobile, owner } from '../../helpers/residents';
import { helpdeskWorld, hctx, resetHelpdesk, ticketPhoto, type HelpdeskWorld } from '../../helpers/helpdesk';

afterAll(closeDb);

let w: HelpdeskWorld;
let A: ReturnType<typeof as>;
let FM: ReturnType<typeof as>;
beforeAll(async () => {
  await resetHelpdesk();
  w = await helpdeskWorld('PREMIUM');
  A = as(await login(w.adminUser));
  FM = as(await login(w.fmUser));
});
beforeEach(async () => {
  setHelpdeskPorts();
  setNow('2026-11-01T04:30:00Z');
  await resetRateLimits();
});

let n = 0;
/** Personal complaint on behalf through the API (Plumbing by default); returns the TicketDto. */
async function flat(over: Record<string, unknown> = {}, who = A): Promise<any> {
  n += 1;
  const cat = await w.cat((over.cat as string) ?? 'Plumbing');
  const { cat: _c, ...rest } = over;
  const r = await who(
    'post',
    '/tickets',
    {
      unitId: w.a101,
      channel: 'PHONE',
      categoryId: cat.id,
      title: `Kitchen tap leaking ${n}`,
      description: 'Water drips all day from the kitchen tap',
      ...rest,
    },
    { headers: idem() },
  );
  if (r.status !== 201) throw new Error(`flat ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
/** Building issue through the API; `duplicateReason` is sent so the similar-issue guard never interferes. */
async function bldg(over: Record<string, unknown> = {}, who = A): Promise<any> {
  const cat = await w.cat((over.cat as string) ?? 'Garden');
  const { cat: _c, ...rest } = over;
  const r = await who(
    'post',
    '/building-issues',
    {
      locationNodeId: w.buildingA.locationNodeId,
      categoryId: cat.id,
      urgency: 'NORMAL',
      description: 'Lawn needs attention',
      duplicateReason: 'Reported separately by another person',
      ...rest,
    },
    { headers: idem() },
  );
  if (r.status !== 201) throw new Error(`bldg ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
const get = async (id: number, who = A) => (await who('get', `/tickets/${id}`)).body.data;
const assignFm = (id: number, version: number, who = A) =>
  who('post', `/tickets/${id}/assign`, { assigneeType: 'MEMBER', userId: w.fmUser.id, version });
const act = (id: number, body: Record<string, unknown>, who = A) =>
  who('post', `/tickets/${id}/transition`, body, { headers: idem() });
/** A ticket assigned to the facility manager and started. */
async function started(make: () => Promise<any> = () => flat()): Promise<any> {
  const t = await make();
  const a = await assignFm(t.id, t.version);
  const s = await act(t.id, { action: 'START', version: a.body.data.version });
  expect(s.status).toBe(200);
  return s.body.data;
}

describe('8.9 on-behalf create and 8.7 list', () => {
  it('creates a personal complaint on behalf, replays by idempotency key, and validates', async () => {
    const t = await flat({ priority: 'P2' });
    expect(t).toMatchObject({
      kind: 'PERSONAL',
      status: 'OPEN',
      priority: 'P2',
      prioritySource: 'ADMIN',
      channel: 'PHONE',
      unit: { id: w.a101 },
      category: { name: 'Plumbing' },
      version: 1,
      allowedActions: ['CANCEL'],
      similarOpenTicketIds: expect.any(Array),
    });
    expect(t.ticketNo).toMatch(/^TKT\/2026-27\/\d{6}$/);
    expect(t.sla.slaState).toBe('ON_TRACK');
    // same key and body replays, same key with another body is refused (T15-31)
    const key = idem();
    const body = {
      unitId: w.a101,
      channel: 'WALK_IN',
      categoryId: t.category.id,
      title: 'Replay me please',
      description: 'The same body twice over',
    };
    const r1 = await A('post', '/tickets', body, { headers: key });
    const r2 = await A('post', '/tickets', body, { headers: key });
    const r3 = await A('post', '/tickets', { ...body, title: 'A different title' }, { headers: key });
    expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 409]);
    expect(r2.body.data.id).toBe(r1.body.data.id);
    expect(r3.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // T15-28 validation
    const bad = await A(
      'post',
      '/tickets',
      {
        ...body,
        title: 'abcd',
        description: 'x'.repeat(2001),
        fileIds: [1, 2, 3, 4, 5, 6, 7],
        channel: 'APP',
      },
      { headers: idem() },
    );
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: any) => e.field).sort()).toEqual([
      'channel',
      'description',
      'fileIds',
      'title',
    ]);
    // errors of 8.9
    const u = await A('post', '/tickets', { ...body, unitId: 99999999 }, { headers: idem() });
    expect([u.status, u.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    const rs = await A('post', '/tickets', { ...body, requesterResidentId: 99999999 }, { headers: idem() });
    expect([rs.status, rs.body.code]).toEqual([404, 'RESIDENT_NOT_FOUND']);
    const sc = await A(
      'post',
      '/tickets',
      { ...body, categoryId: (await w.cat('Lift')).id },
      { headers: idem() },
    );
    expect([sc.status, sc.body.code]).toEqual([422, 'CATEGORY_SCOPE_MISMATCH']);
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'helpdesk.ticket.created' } }),
    ).toBeGreaterThan(0);
  });

  it('links the requester resident of the flat and files', async () => {
    const m = mobile();
    const res = await addResident(A, { name: 'Olive Owner', mobile: m, link: owner(w.a201) });
    const photo = ticketPhoto(w.sid, w.adminId);
    const t = await flat({ unitId: w.a201, requesterResidentId: res.id ?? res.residentId, fileIds: [photo] });
    expect(t.requester.name).toBe('Olive Owner');
    expect(t.fileIds).toEqual([photo]);
    const url = await A('get', `/tickets/${t.id}/files/${photo}/download-url?disposition=attachment`);
    expect(url.status).toBe(200);
    expect(url.body.data.url).toContain('disposition=attachment');
    const miss = await A('get', `/tickets/${t.id}/files/${photo + 500}/download-url`);
    expect([miss.status, miss.body.code]).toEqual([404, 'FILE_NOT_FOUND']);
  });

  it('lists with the frontend shape, views, filters, search and sorting', async () => {
    const f1 = await flat({ cat: 'Carpentry', title: 'Wardrobe door broken here' });
    const b1 = await bldg({ cat: 'Parking', title: 'Parking gate stuck open' });
    const b2 = await bldg({ cat: 'Parking', priority: 'P1', title: 'Parking lot flooding badly' });
    const r = await A('get', '/tickets?view=ALL&limit=100');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual(['counts', 'items', 'pagination']);
    expect(r.body.data.counts).toMatchObject({
      OPEN: expect.any(Number),
      BUILDING: expect.any(Number),
      FLATS: expect.any(Number),
      ALL: expect.any(Number),
    });
    expect(r.body.data.pagination).toMatchObject({ page: 1, limit: 100 });
    const item = r.body.data.items.find((i: any) => i.id === b2.id);
    expect(item).toMatchObject({
      ticketNo: b2.ticketNo,
      kind: 'BUILDING',
      priority: 'P1',
      categoryName: 'Parking',
      slaState: 'ON_TRACK',
      assigneeInactive: false,
    });
    expect(item.locationLabel).toContain('A');
    const ids = async (q: string) => {
      const r = await A('get', `/tickets?${q}`);
      if (r.status !== 200) throw new Error(`${q} ${JSON.stringify(r.body)}`);
      return r.body.data.items.map((i: any) => i.id);
    };
    expect(await ids('view=FLATS&limit=100')).toContain(f1.id);
    expect(await ids('view=FLATS&limit=100')).not.toContain(b1.id);
    expect(await ids('view=BUILDING&limit=100')).toEqual(expect.arrayContaining([b1.id, b2.id]));
    expect(await ids('view=URGENT&limit=100')).toContain(b2.id);
    expect(await ids('view=URGENT&limit=100')).not.toContain(b1.id);
    expect(await ids('view=UNASSIGNED&limit=100')).toContain(f1.id);
    expect(await ids(`q=${b1.ticketNo.slice(0, 12)}&view=ALL&limit=100`)).toEqual(
      expect.arrayContaining([b1.id, f1.id]),
    );
    expect(await ids('q=flooding&view=ALL')).toEqual([b2.id]);
    expect(await ids('q=A-101&view=ALL&limit=100')).toContain(f1.id);
    expect(await ids(`priority=P1&view=ALL&kind=BUILDING&limit=100`)).toContain(b2.id);
    expect(await ids(`categoryId=${(await w.cat('Parking')).id}&view=ALL`)).toEqual(
      [b2.id, b1.id].sort((a, c) => c - a),
    );
    const sorted = (await A('get', '/tickets?view=ALL&sortBy=priority&limit=100')).body.data.items;
    expect(sorted[0].priority).toBe('P1');
    expect(await ids('status=CLOSED')).toEqual([]);
    const page2 = await A('get', '/tickets?view=ALL&limit=1&page=2');
    expect(page2.body.pagination).toMatchObject({ page: 2, limit: 1 });
    const badRange = await A('get', '/tickets?createdFrom=2026-11-05&createdTo=2026-11-01');
    expect([badRange.status, badRange.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await A('get', '/tickets?limit=101')).status).toBe(400);
    expect((await A('get', '/tickets?bogus=1')).status).toBe(400);
    expect(
      (await A('get', '/tickets?createdFrom=2026-11-01&createdTo=2026-11-01&view=ALL&limit=100')).body.data
        .items.length,
    ).toBeGreaterThan(2);
    expect(
      (await A('get', '/tickets?createdFrom=2026-10-01&createdTo=2026-10-31&view=ALL')).body.data.items,
    ).toEqual([]);
  });
});

describe('8.10, 8.11 building issues by the office', () => {
  it('derives the title, honours the priority override, guards duplicates and finds similar issues', async () => {
    const lift = await w.cat('Lift');
    const stopped = await w.sub('Lift', 'Lift stopped');
    const body = {
      locationNodeId: w.buildingB.locationNodeId,
      categoryId: lift.id,
      subCategoryId: stopped.id,
      urgency: 'EMERGENCY',
      priority: 'P2',
    };
    const r1 = await A('post', '/building-issues', body, { headers: idem() });
    expect(r1.status).toBe(201);
    expect(r1.body.data).toMatchObject({
      kind: 'BUILDING',
      priority: 'P2',
      prioritySource: 'ADMIN',
      channel: 'APP',
      reporterRole: expect.stringMatching(/COMMITTEE|OFFICE/),
      affectedLevel: 'BUILDING',
      affectedUnitCount: 1,
    });
    expect(r1.body.data.title).toContain('Lift stopped');
    const dup = await A('post', '/building-issues', body, { headers: idem() });
    expect([dup.status, dup.body.code]).toEqual([409, 'SIMILAR_ISSUE_EXISTS']);
    expect(dup.body.errors).toEqual([{ field: 'ticketId', message: String(r1.body.data.id) }]);
    const ok = await A(
      'post',
      '/building-issues',
      { ...body, duplicateReason: 'Second lift is also stuck' },
      { headers: idem() },
    );
    expect(ok.status).toBe(201);
    const sys = await TicketComment.findOne({ where: { ticketId: ok.body.data.id, kind: 'SYSTEM' } });
    expect(sys?.visibility).toBe('INTERNAL');
    const s = await A(
      'get',
      `/building-issues/similar?locationNodeId=${w.buildingB.locationNodeId}&categoryId=${lift.id}`,
    );
    expect(s.status).toBe(200);
    expect(s.body.data.items.map((i: any) => i.id)).toEqual(
      expect.arrayContaining([r1.body.data.id, ok.body.data.id]),
    );
    expect(s.body.data.items[0]).toMatchObject({ iUpvoted: false, isRequester: true });
    const d = await get(r1.body.data.id);
    expect(d.similarOpen.map((i: any) => i.id)).toEqual([ok.body.data.id]);
    const nf = await A('get', `/building-issues/similar?locationNodeId=99999999&categoryId=${lift.id}`);
    expect([nf.status, nf.body.code]).toEqual([404, 'LOCATION_NOT_FOUND']);
    const cf = await A(
      'get',
      `/building-issues/similar?locationNodeId=${w.buildingB.locationNodeId}&categoryId=99999999`,
    );
    expect([cf.status, cf.body.code]).toEqual([404, 'CATEGORY_NOT_FOUND']);
    const none = await A(
      'post',
      '/building-issues',
      { categoryId: lift.id, urgency: 'NORMAL' },
      { headers: idem() },
    );
    expect(none.status).toBe(400);
    const qr = await A(
      'post',
      '/building-issues',
      { ...body, qrToken: 'ABCDEFGHIJKL', duplicateReason: 'Using a code that is unknown' },
      { headers: idem() },
    );
    expect([qr.status, qr.body.code]).toEqual([404, 'QR_NOT_FOUND']);
  });
});

describe('8.8 detail, 8.12 patch, tenant isolation', () => {
  it('returns the detail with recent comments, edits fields and recomputes the SLA', async () => {
    const t = await flat({ cat: 'Electrical' });
    const d = await get(t.id);
    expect(d).toMatchObject({
      id: t.id,
      description: 'Water drips all day from the kitchen tap',
      recentComments: expect.any(Array),
      similarOpen: [],
    });
    expect(d.recentComments[0]).toMatchObject({ kind: 'STATUS_CHANGE', toStatus: 'OPEN', canDelete: false });
    // priority needs a reason (400), changes source and due time, writes the timeline and audit rows
    const noReason = await A('patch', `/tickets/${t.id}`, { priority: 'P1', version: 1 });
    expect([noReason.status, noReason.body.errors[0].field]).toEqual([400, 'priorityReason']);
    const p = await A('patch', `/tickets/${t.id}`, {
      priority: 'P1',
      priorityReason: 'Sparks at the board',
      title: 'Sparks from the main board',
      version: 1,
    });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({
      priority: 'P1',
      prioritySource: 'ADMIN',
      title: 'Sparks from the main board',
      version: 2,
    });
    expect(new Date(p.body.data.sla.resolutionDueAt).getTime()).toBeLessThan(
      new Date(t.sla.resolutionDueAt).getTime(),
    );
    expect(
      await TicketComment.count({
        where: { ticketId: t.id, kind: 'PRIORITY_CHANGE', visibility: 'INTERNAL' },
      }),
    ).toBe(1);
    const audits = await AuditLog.findAll({
      where: {
        entityType: 'ticket',
        entityId: String(t.id),
        action: ['helpdesk.ticket.updated', 'helpdesk.ticket.priority_changed'],
      },
    });
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits.map(a => [a.before, a.after]))).not.toContain('Sparks');
    // stale version, scope mismatch, short description, closed ticket
    expect(
      (await A('patch', `/tickets/${t.id}`, { title: 'Another title here', version: 1 })).body.code,
    ).toBe('STALE_VERSION');
    const sc = await A('patch', `/tickets/${t.id}`, { categoryId: (await w.cat('Lift')).id, version: 2 });
    expect([sc.status, sc.body.code]).toEqual([422, 'CATEGORY_SCOPE_MISMATCH']);
    const sd = await A('patch', `/tickets/${t.id}`, { description: 'short', version: 2 });
    expect(sd.status).toBe(400);
    const cat = await A('patch', `/tickets/${t.id}`, { categoryId: (await w.cat('Noise')).id, version: 2 });
    expect(cat.body.data.category.name).toBe('Noise');
    expect((await A('patch', `/tickets/${t.id}`, { version: 3 })).status).toBe(400);
    const c = await act(t.id, { action: 'CANCEL', reason: 'Raised by mistake', version: 3 });
    expect(c.status).toBe(200);
    const closed = await A('patch', `/tickets/${t.id}`, { title: 'Cannot edit this now', version: 4 });
    expect([closed.status, closed.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('edits the affected level of a building issue and locks the charge flag after an estimate', async () => {
    const b = await bldg({ cat: 'Housekeeping' });
    expect(b.affectedLevel).toBe('BUILDING');
    const up = await A('patch', `/tickets/${b.id}`, { affectedLevel: 'SOCIETY', version: 1 });
    expect(up.body.data).toMatchObject({ affectedLevel: 'SOCIETY', affectedBuilding: null });
    expect(up.body.data.affectedUnitCount).toBeGreaterThanOrEqual(3);
    const fl = await A('patch', `/tickets/${b.id}`, { affectedLevel: 'FLOOR', version: 2 });
    expect([fl.status, fl.body.code]).toEqual([422, 'AFFECTED_LEVEL_INVALID']);
    const noCharge = await A('patch', `/tickets/${b.id}`, { isChargeable: true, version: 2 });
    expect(noCharge.status).toBe(400);
    const s = await started(() => flat({ cat: 'Carpentry', title: 'Fix the wardrobe door now' }));
    expect(s.isChargeable).toBe(true);
    const e = await A(
      'post',
      `/tickets/${s.id}/estimate`,
      { estimatePaise: 65000, note: 'Hinge and labour', version: s.version },
      { headers: idem() },
    );
    expect(e.status).toBe(200);
    const locked = await A('patch', `/tickets/${s.id}`, {
      isChargeable: false,
      version: e.body.data.version,
    });
    expect([locked.status, locked.body.code]).toEqual([422, 'CHARGE_STATE_LOCKED']);
  });

  it('answers 404 TICKET_NOT_FOUND for another society on every route (T15-22)', async () => {
    const t = await flat();
    const other = await setupSociety({ plan: 'PREMIUM', name: 'Other CHS' });
    const calls: [string, string, unknown?][] = [
      ['get', `/tickets/${t.id}`],
      ['patch', `/tickets/${t.id}`, { title: 'Someone elses ticket', version: 1 }],
      [
        'post',
        `/tickets/${t.id}/assign`,
        { assigneeType: 'EXTERNAL', externalName: 'Ravi', externalMobile: '9876543210', version: 1 },
      ],
      ['post', `/tickets/${t.id}/unassign`, { reason: 'Not mine to touch', version: 1 }],
      ['post', `/tickets/${t.id}/transition`, { action: 'CANCEL', reason: 'Not mine to cancel', version: 1 }],
      ['post', `/tickets/${t.id}/merge`, { intoTicketId: t.id + 1, version: 1 }],
      ['post', `/tickets/${t.id}/estimate`, { estimatePaise: 10000, note: 'Not mine', version: 1 }],
      ['get', `/tickets/${t.id}/comments`],
      ['post', `/tickets/${t.id}/comments`, { body: 'Hello from outside' }],
      ['get', `/tickets/${t.id}/files/1/download-url`],
    ];
    for (const [m, path, body] of calls) {
      const r = await other.c(m as 'get', path, body, { headers: idem() });
      expect([m, path, r.status, r.body.code]).toEqual([m, path, 404, 'TICKET_NOT_FOUND']);
    }
    const list = await other.c('get', '/tickets?view=ALL');
    expect(list.body.data.items).toEqual([]);
    expect(list.body.data.counts.ALL).toBe(0);
    // an id of the other society as the target of a merge
    const ob = await other.c('get', '/tickets/stats');
    expect(ob.body.data.created).toBe(0);
  });
});

describe('8.13 assign and unassign, 8.21 assignees', () => {
  it('assigns, refuses the same assignee, ineligible and unknown ones, masks external mobiles, unassigns', async () => {
    const t = await flat();
    const a = await A('post', `/tickets/${t.id}/assign`, {
      assigneeType: 'MEMBER',
      userId: w.fmUser.id,
      note: 'Please look today',
      noteInternal: true,
      version: 1,
    });
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({
      status: 'ASSIGNED',
      version: 2,
      assignment: { assigneeType: 'MEMBER', assigneeLabel: 'Farhan FM' },
      allowedActions: ['START', 'CANCEL'],
    });
    const note = await TicketComment.findOne({
      where: { ticketId: t.id, kind: 'ASSIGNMENT', body: 'Please look today' },
    });
    expect(note?.visibility).toBe('INTERNAL');
    const again = await assignFm(t.id, 2);
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_ASSIGNED']);
    const res = await memberUser(w.society, 'owner', { name: 'Just a resident' });
    const inel = await A('post', `/tickets/${t.id}/assign`, {
      assigneeType: 'MEMBER',
      userId: res.id,
      version: 2,
    });
    expect([inel.status, inel.body.code]).toEqual([422, 'ASSIGNEE_NOT_ELIGIBLE']);
    const unk = await A('post', `/tickets/${t.id}/assign`, {
      assigneeType: 'MEMBER',
      userId: 99999999,
      version: 2,
    });
    expect([unk.status, unk.body.code]).toEqual([404, 'ASSIGNEE_NOT_FOUND']);
    expect(
      (
        await A('post', `/tickets/${t.id}/assign`, {
          assigneeType: 'EXTERNAL',
          externalName: 'R',
          externalMobile: '12345',
          version: 2,
        })
      ).status,
    ).toBe(400);
    const ext = await A('post', `/tickets/${t.id}/assign`, {
      assigneeType: 'EXTERNAL',
      externalName: 'Ravi Plumber',
      externalMobile: '9876543111',
      version: 2,
    });
    expect(ext.status).toBe(200);
    expect(ext.body.data.assignment.externalMobile).toBe('9876543111'); // the chairman holds residents.contacts.view
    const acc = await memberUser(w.society, 'accountant', { name: 'Anita Accountant' });
    const ro = as(await login(acc));
    expect((await get(t.id, ro)).assignment.externalMobile).toBe('98XXXXX111');
    expect((await get(t.id, ro)).allowedActions).toEqual([]);
    expect(await TicketAssignment.count({ where: { ticketId: t.id } })).toBe(2);
    const un = await A('post', `/tickets/${t.id}/unassign`, { reason: 'Wrong person picked', version: 3 });
    expect(un.body.data).toMatchObject({ status: 'OPEN', assignment: null });
    const un2 = await A('post', `/tickets/${t.id}/unassign`, { reason: 'Already unassigned', version: 4 });
    expect([un2.status, un2.body.code]).toEqual([409, 'TICKET_INVALID_TRANSITION']);
    expect((await A('post', `/tickets/${t.id}/unassign`, { reason: 'abc', version: 4 })).status).toBe(400);
  });

  it('lets only one of two admins win with the same version (T15-29)', async () => {
    const t = await flat();
    const [a, b] = await Promise.all([
      A('post', `/tickets/${t.id}/assign`, { assigneeType: 'MEMBER', userId: w.fmUser.id, version: 1 }),
      FM('post', `/tickets/${t.id}/assign`, { assigneeType: 'MEMBER', userId: w.adminId, version: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find(r => r.status === 409)!.body.code).toBe('STALE_VERSION');
  });

  it('lists assignable members with their load, filters by name and keeps staff and vendors empty', async () => {
    await started();
    const r = await A('get', '/tickets/assignees');
    expect(r.status).toBe(200);
    const fm = r.body.data.members.find((m: any) => m.userId === w.fmUser.id);
    expect(fm).toMatchObject({ name: 'Farhan FM', roleKey: 'facility_manager' });
    expect(fm.openCount).toBeGreaterThanOrEqual(1);
    expect(fm.roleName).toBeTruthy();
    expect(r.body.data.members.some((m: any) => m.roleKey === 'owner')).toBe(false);
    expect(r.body.data.staff).toEqual([]);
    expect(r.body.data.vendors).toEqual([]);
    const q = await A('get', '/tickets/assignees?q=farh&type=MEMBER');
    expect(q.body.data.members.map((m: any) => m.userId)).toEqual([w.fmUser.id]);
    expect((await A('get', '/tickets/assignees?type=VENDOR')).body.data.members).toEqual([]);
    expect((await A('get', '/tickets/assignees?type=X')).status).toBe(400);
  });
});

describe('8.14 transition, 8.15 merge, 8.16 estimate', () => {
  it('runs a ticket through the lifecycle and lists the allowed actions on a refusal', async () => {
    const t = await flat({ cat: 'Parking', title: 'Neighbour parks in my slot' });
    const bad = await act(t.id, { action: 'START', version: 1 });
    expect([bad.status, bad.body.code]).toEqual([409, 'TICKET_INVALID_TRANSITION']);
    expect(bad.body.errors).toEqual([{ field: 'action', message: 'CANCEL' }]);
    const a = await assignFm(t.id, 1);
    const s = await act(t.id, { action: 'START', version: a.body.data.version });
    expect(s.body.data).toMatchObject({
      status: 'IN_PROGRESS',
      allowedActions: expect.arrayContaining(['WAIT_ON_RESIDENT', 'RESOLVE']),
    });
    expect(s.body.data.sla.firstResponseAt).toBeTruthy();
    const noNote = await act(t.id, { action: 'WAIT_ON_RESIDENT', waitingReason: 'INFORMATION', version: 3 });
    expect(noNote.status).toBe(400);
    const wait = await act(t.id, {
      action: 'WAIT_ON_RESIDENT',
      waitingReason: 'INFORMATION',
      note: 'Which slot is yours?',
      version: 3,
    });
    expect(wait.body.data).toMatchObject({ status: 'WAITING_ON_RESIDENT', waitingReason: 'INFORMATION' });
    expect(wait.body.data.sla.slaState).toBe('PAUSED');
    advance(5 * 60_000);
    const resume = await act(t.id, { action: 'RESUME', version: 4 });
    if (resume.status !== 200) throw new Error(JSON.stringify(resume.body));
    expect(resume.body.data.sla.pausedMinutes).toBe(5);
    const stale = await act(t.id, { action: 'RESOLVE', note: 'Spoke to the neighbour', version: 3 });
    expect(stale.body.code).toBe('STALE_VERSION');
    const res = await act(t.id, { action: 'RESOLVE', note: 'Spoke to the neighbour and sorted', version: 5 });
    expect(res.body.data).toMatchObject({
      status: 'RESOLVED',
      resolutionNote: 'Spoke to the neighbour and sorted',
    });
    const close = await act(t.id, { action: 'CLOSE', version: 6 });
    expect(close.body.data.status).toBe('CLOSED');
    const reopen = await act(t.id, { action: 'REOPEN', reason: 'Still happening again', version: 7 });
    expect(reopen.body.data).toMatchObject({ status: 'ASSIGNED', reopenCount: 1 });
    expect(reopen.body.data.sla.cycle).toBe(2);
    // replays of the same idempotency key
    const key = idem();
    const c1 = await A(
      'post',
      `/tickets/${t.id}/transition`,
      { action: 'CANCEL', reason: 'No longer needed', version: 8 },
      { headers: key },
    );
    const c2 = await A(
      'post',
      `/tickets/${t.id}/transition`,
      { action: 'CANCEL', reason: 'No longer needed', version: 8 },
      { headers: key },
    );
    expect([c1.status, c2.status]).toEqual([200, 200]);
    expect(c2.headers['idempotent-replay']).toBe('true');
    // an after photo is needed in Plumbing (T15-15)
    const p = await started(() => flat({ cat: 'Plumbing', title: 'Pipe leaks under the sink' }));
    const np = await act(p.id, { action: 'RESOLVE', note: 'Replaced the washer fully', version: p.version });
    expect([np.status, np.body.code]).toEqual([422, 'AFTER_PHOTO_REQUIRED']);
    const ok = await act(p.id, {
      action: 'RESOLVE',
      note: 'Replaced the washer fully',
      fileIds: [ticketPhoto(w.sid, w.adminId)],
      version: p.version,
    });
    expect(ok.body.data.status).toBe('RESOLVED');
    // the admin app uploads its photos as TICKET_ATTACHMENT: they link too
    const p2 = await started(() => flat({ cat: 'Plumbing', title: 'Another pipe leaks badly' }));
    const ok2 = await act(p2.id, {
      action: 'RESOLVE',
      note: 'Replaced the washer fully',
      fileIds: [ticketPhoto(w.sid, w.adminId, 'TICKET_ATTACHMENT')],
      version: p2.version,
    });
    expect([ok2.status, ok2.body.data?.status]).toEqual([200, 'RESOLVED']);
  });

  it('merges a duplicate building issue into the primary and refuses bad targets', async () => {
    const primary = await bldg({ cat: 'Security', title: 'Gate barrier is broken' });
    const dup = await bldg({ cat: 'Security', title: 'Barrier at the gate stuck' });
    const self = await A('post', `/tickets/${dup.id}/merge`, { intoTicketId: dup.id, version: 1 });
    expect([self.status, self.body.code]).toEqual([422, 'MERGE_SELF']);
    const flatT = await flat({ cat: 'Parking', title: 'Personal complaint here' });
    const bad = await A('post', `/tickets/${dup.id}/merge`, { intoTicketId: flatT.id, version: 1 });
    expect([bad.status, bad.body.code]).toEqual([422, 'MERGE_TARGET_INVALID']);
    const nf = await A('post', `/tickets/${dup.id}/merge`, { intoTicketId: 99999999, version: 1 });
    expect([nf.status, nf.body.code]).toEqual([404, 'TICKET_NOT_FOUND']);
    const stale = await A('post', `/tickets/${dup.id}/merge`, { intoTicketId: primary.id, version: 9 });
    expect(stale.body.code).toBe('STALE_VERSION');
    const m = await A('post', `/tickets/${dup.id}/merge`, {
      intoTicketId: primary.id,
      note: 'Same barrier',
      version: 1,
    });
    expect(m.status).toBe(200);
    expect(m.body.data.duplicate).toMatchObject({
      id: dup.id,
      status: 'CANCELLED',
      mergedIntoTicketId: primary.id,
    });
    expect(m.body.data.primary.id).toBe(primary.id);
    expect(m.body.data.primary.upvoteCount).toBe(0);
    expect(
      await AuditLog.count({
        where: {
          action: 'helpdesk.ticket.merged',
          entityType: 'ticket',
          entityId: [String(dup.id), String(primary.id)],
        },
      }),
    ).toBe(2);
  });

  it('sends an estimate (WAITING_ON_RESIDENT with the card data) and refuses wrong states', async () => {
    const s = await started(() => flat({ cat: 'Carpentry', title: 'Replace the kitchen hinge' }));
    expect(
      (
        await A(
          'post',
          `/tickets/${s.id}/estimate`,
          { estimatePaise: 50, note: 'Too small', version: s.version },
          { headers: idem() },
        )
      ).status,
    ).toBe(400);
    const e = await A(
      'post',
      `/tickets/${s.id}/estimate`,
      { estimatePaise: 65000, note: 'Hinge and labour', version: s.version },
      { headers: idem() },
    );
    expect(e.status).toBe(200);
    expect(e.body.data).toMatchObject({
      status: 'WAITING_ON_RESIDENT',
      waitingReason: 'ESTIMATE_APPROVAL',
      charge: {
        status: 'ESTIMATE_SENT',
        estimatePaise: 65000,
        estimateNote: 'Hinge and labour',
        finalPaise: 0,
      },
    });
    expect(e.body.data.sla.slaState).toBe('PAUSED');
    const again = await A(
      'post',
      `/tickets/${s.id}/estimate`,
      { estimatePaise: 65000, note: 'Hinge and labour', version: e.body.data.version },
      { headers: idem() },
    );
    expect([again.status, again.body.code]).toEqual([409, 'TICKET_INVALID_TRANSITION']);
    const entry = await TicketComment.findOne({ where: { ticketId: s.id, kind: 'ESTIMATE' } });
    expect(entry?.visibility).toBe('PUBLIC');
    expect(
      await AuditLog.count({ where: { action: 'helpdesk.ticket.estimate_sent', entityId: String(s.id) } }),
    ).toBe(1);
    const plain = await started(() => flat({ cat: 'Noise', title: 'Loud music every night' }));
    const na = await A(
      'post',
      `/tickets/${plain.id}/estimate`,
      { estimatePaise: 65000, note: 'Not chargeable', version: plain.version },
      { headers: idem() },
    );
    expect([na.status, na.body.code]).toEqual([422, 'ESTIMATE_NOT_ALLOWED']);
    const b = await bldg({ cat: 'Gym equipment' });
    const nb = await A(
      'post',
      `/tickets/${b.id}/estimate`,
      { estimatePaise: 65000, note: 'Building issue', version: 1 },
      { headers: idem() },
    );
    expect([nb.status, nb.body.code]).toEqual([422, 'ESTIMATE_NOT_ALLOWED']);
  });
});

describe('8.17 comments and 8.18 files', () => {
  it('posts public and internal comments, lists newest first with cursor, removes and refuses', async () => {
    const t = await flat({ cat: 'Internet and cable', title: 'Broadband keeps dropping' });
    const pub = await A(
      'post',
      `/tickets/${t.id}/comments`,
      { body: '  We are checking this  ' },
      { headers: idem() },
    );
    expect(pub.status).toBe(201);
    expect(pub.body.data).toMatchObject({
      kind: 'COMMENT',
      visibility: 'PUBLIC',
      body: 'We are checking this',
      authorRole: 'ADMIN',
      canDelete: true,
    });
    const internal = await A(
      'post',
      `/tickets/${t.id}/comments`,
      { body: 'Resident is difficult', visibility: 'INTERNAL', fileIds: [ticketPhoto(w.sid, w.adminId)] },
      { headers: idem() },
    );
    expect(internal.body.data).toMatchObject({ visibility: 'INTERNAL' });
    expect(internal.body.data.fileIds).toHaveLength(1);
    const list = await A('get', `/tickets/${t.id}/comments?limit=2`);
    expect(list.body.data.map((c: any) => c.id)).toEqual([internal.body.data.id, pub.body.data.id]);
    const next = await A('get', `/tickets/${t.id}/comments?before=${pub.body.data.id}`);
    expect(next.body.data.map((c: any) => c.kind)).toEqual(['STATUS_CHANGE']);
    // internal file is served to the admin
    const f = internal.body.data.fileIds[0];
    expect((await A('get', `/tickets/${t.id}/files/${f}/download-url`)).status).toBe(200);
    // validation, notifyAffected only for public building comments
    expect((await A('post', `/tickets/${t.id}/comments`, { body: '   ' }, { headers: idem() })).status).toBe(
      400,
    );
    expect(
      (
        await A(
          'post',
          `/tickets/${t.id}/comments`,
          { body: 'Tell everyone', notifyAffected: true },
          { headers: idem() },
        )
      ).status,
    ).toBe(400);
    // removal needs a reason from a moderator, never removes system entries
    const noReason = await A('delete', `/tickets/${t.id}/comments/${pub.body.data.id}`);
    expect(noReason.status).toBe(204); // own comment: the reason is optional for the author
    const other = await A('delete', `/tickets/${t.id}/comments/${internal.body.data.id}`, {
      reason: 'Not suitable here',
    });
    expect(other.status).toBe(204);
    const gone = await A('get', `/tickets/${t.id}/comments`);
    expect(gone.body.data.map((c: any) => c.kind)).toEqual(['STATUS_CHANGE']);
    const sys = await TicketComment.findOne({ where: { ticketId: t.id, kind: 'STATUS_CHANGE' } });
    const delSys = await A('delete', `/tickets/${t.id}/comments/${sys!.id}`, {
      reason: 'Trying to remove it',
    });
    expect([delSys.status, delSys.body.code]).toEqual([409, 'INVALID_STATE']);
    const unknown = await A('delete', `/tickets/${t.id}/comments/99999999`, { reason: 'Does not exist' });
    expect([unknown.status, unknown.body.code]).toEqual([404, 'COMMENT_NOT_FOUND']);
    expect(
      await AuditLog.count({ where: { action: 'helpdesk.comment.removed', societyId: w.sid } }),
    ).toBeGreaterThanOrEqual(2);
    // closed tickets take no comments
    await act(t.id, { action: 'CANCEL', reason: 'Resident moved away', version: (await get(t.id)).version });
    const late = await A('post', `/tickets/${t.id}/comments`, { body: 'Too late now' }, { headers: idem() });
    expect([late.status, late.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('limits public broadcasts to five a day', async () => {
    const b = await bldg({ cat: 'Fire and gas safety', title: 'Extinguisher missing in lobby' });
    for (let i = 1; i <= 5; i++) {
      const r = await A(
        'post',
        `/tickets/${b.id}/comments`,
        { body: `Update number ${i}`, notifyAffected: true },
        { headers: idem() },
      );
      expect(r.status).toBe(201);
      expect(r.body.data.notifyAffected).toBe(true);
    }
    const sixth = await A(
      'post',
      `/tickets/${b.id}/comments`,
      { body: 'Update number 6', notifyAffected: true },
      { headers: idem() },
    );
    expect([sixth.status, sixth.body.code]).toEqual([429, 'RATE_LIMITED']);
    const plain = await A(
      'post',
      `/tickets/${b.id}/comments`,
      { body: 'A comment without broadcast' },
      { headers: idem() },
    );
    expect(plain.status).toBe(201);
  });
});

describe('permissions (T15-25)', () => {
  it('view-only roles read but cannot write; roles without the keys get 403', async () => {
    const t = await flat();
    const acc = as(await login(await memberUser(w.society, 'accountant', { name: 'Acc' })));
    expect((await acc('get', '/tickets')).status).toBe(200);
    expect((await acc('get', `/tickets/${t.id}/comments`)).status).toBe(200);
    for (const [m, path, body] of [
      ['post', `/tickets/${t.id}/assign`, { assigneeType: 'MEMBER', userId: w.fmUser.id, version: 1 }],
      ['patch', `/tickets/${t.id}`, { title: 'Accountant edits it', version: 1 }],
      ['post', `/tickets/${t.id}/transition`, { action: 'CANCEL', reason: 'Accountant cancels', version: 1 }],
      ['post', `/tickets/${t.id}/comments`, { body: 'Accountant comment' }],
      [
        'post',
        '/tickets',
        {
          unitId: w.a101,
          channel: 'PHONE',
          categoryId: 1,
          title: 'Accountant creates',
          description: 'Accountant raises one',
        },
      ],
      ['post', '/building-issues', { locationNodeId: 1, categoryId: 1 }],
      ['get', '/tickets/assignees'],
      ['get', '/tickets/export'],
    ] as [string, string, unknown?][]) {
      const r = await acc(m as 'get', path, body, { headers: idem() });
      expect([m, path, r.status, r.body.code]).toEqual([m, path, 403, 'PERMISSION_DENIED']);
    }
    // treasurer: view and create, not edit or export
    const tre = as(await login(await memberUser(w.society, 'treasurer', { name: 'Tre' })));
    expect((await flat({ title: 'Treasurer raises it' }, tre)).status).toBe('OPEN');
    expect(
      (
        await tre('post', `/tickets/${t.id}/assign`, {
          assigneeType: 'MEMBER',
          userId: w.fmUser.id,
          version: 1,
        })
      ).status,
    ).toBe(403);
    // an auditor has none of the helpdesk keys
    const aud = as(await login(await memberUser(w.society, 'auditor', { name: 'Aud' })));
    expect((await aud('get', '/tickets')).status).toBe(403);
    // a resident session never reaches the admin routes
    const rs = as(
      await login(await memberUser(w.society, 'owner', { name: 'Own' }), {
        app: 'RESIDENT',
        societyId: w.sid,
      }),
      'RESIDENT',
    );
    expect((await rs('get', '/tickets')).status).toBe(403);
    expect(
      (await rs('post', '/building-issues', { locationNodeId: 1, categoryId: 1 }, { headers: idem() }))
        .status,
    ).toBe(403);
  });
});

describe('8.20 export, 8.19 stats', () => {
  it('streams a CSV without internal notes and audits it; refuses more than 20,000 rows (T15-38)', async () => {
    const t = await flat({ cat: 'Pest control', title: '=SUM(1,1) injected title' });
    await A(
      'post',
      `/tickets/${t.id}/comments`,
      { body: 'SECRET internal note', visibility: 'INTERNAL' },
      { headers: idem() },
    );
    const r = await A('get', '/tickets/export?view=ALL');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="tickets-2026-11-01\.csv"/);
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'ticketNo,kind,status,priority,category,subCategory,unitOrLocation,affectedUnitCount,requester,assignee,createdAt,firstResponseAt,resolvedAt,closedAt,responseBreached,resolutionBreached,upvoteCount,csatScore,reopenCount',
    );
    expect(r.text).toContain(t.ticketNo);
    expect(r.text).not.toContain('SECRET');
    expect(r.text).not.toContain('=SUM'); // titles are not exported at all
    const row = await AuditLog.findOne({
      where: { action: 'helpdesk.tickets.exported' },
      order: [['id', 'DESC']],
    });
    expect((row!.after as any).rowCount).toBe(lines.length - 1);
    const spy = vi.spyOn(Ticket, 'count').mockResolvedValue(LIMITS.exportMaxRows + 1);
    const big = await A('get', '/tickets/export?view=ALL');
    spy.mockRestore();
    expect([big.status, big.body.code]).toEqual([422, 'EXPORT_TOO_LARGE']);
    const lim = await A('get', '/tickets/export?createdFrom=2026-11-02&createdTo=2026-11-05');
    expect(lim.status).toBe(200);
    expect(lim.text.trim().split('\r\n')).toHaveLength(1);
  });

  it('computes the stats and the same numbers for module 24', async () => {
    const s = await started(() => flat({ cat: 'Noise', title: 'Garden bench broken here' }));
    advance(5 * 60_000);
    const done = await act(s.id, {
      action: 'RESOLVE',
      note: 'Bench repaired and painted',
      version: s.version,
    });
    expect(done.status).toBe(200);
    await Ticket.update({ csatScore: 4, csatAvgTenths: 43, csatCount: 3 }, { where: { id: s.id } });
    const r = await A('get', '/tickets/stats?from=2026-11-01&to=2026-11-01');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({ resolutionMetPct: 100, csatAvg: 4.3, csatCount: 3 });
    expect(d.resolved).toBeGreaterThanOrEqual(1);
    expect(typeof d.medianResolutionMinutes).toBe('number');
    expect(typeof d.reopenRatePct).toBe('number');
    expect(d.created).toBeGreaterThan(5);
    expect(d.openByPriority).toEqual({
      P1: expect.any(Number),
      P2: expect.any(Number),
      P3: expect.any(Number),
      P4: expect.any(Number),
    });
    expect(d.backlogAge.lt1d).toBe(d.open);
    expect(d.topCategories.length).toBeGreaterThan(0);
    expect(await helpdeskReports.summary(w.sid, '2026-11-01', '2026-11-01')).toEqual(d);
    const empty = await A('get', '/tickets/stats?from=2026-01-01&to=2026-01-10');
    expect(empty.body.data).toMatchObject({
      created: 0,
      resolved: 0,
      resolutionMetPct: null,
      responseMetPct: null,
      csatAvg: null,
      medianResolutionMinutes: null,
    });
    expect((await A('get', '/tickets/stats?from=2025-01-01&to=2026-11-01')).status).toBe(400);
    expect((await A('get', '/tickets/stats?kind=BUILDING')).status).toBe(200);
    const monthly = await helpdeskReports.monthly(w.sid, 2);
    expect(monthly.map(m => m.month)).toEqual(['2026-10', '2026-11']);
    expect(monthly[1]!.resolved).toBeGreaterThanOrEqual(1);
    expect(await helpdeskReports.openCounts(w.sid)).toMatchObject({ open: d.open });
    const prod = await helpdeskReports.assigneeProductivity(w.sid, '2026-11-01', '2026-11-01');
    expect(prod.find(p => p.assigneeUserId === w.fmUser.id)).toMatchObject({
      resolved: expect.any(Number),
      label: 'Farhan FM',
    });
    const rec = await helpdeskReports.recurring(w.sid, '2026-11-01', '2026-11-01');
    expect(Array.isArray(rec)).toBe(true);
    const units = await helpdeskReports.openBuildingIssuesForUnits(w.sid, [w.b101]);
    expect(units.every(u => u.kind === 'BUILDING')).toBe(true);
  });
});

describe('8.30 staff app functions, 8.31 internal readers', () => {
  it('lets the assignee work a ticket, hides internal notes from vendors, and ends access on reassignment (T15-24)', async () => {
    const t = await flat({ cat: 'Parking', title: 'Visitor slot blocked daily' });
    const a = await assignFm(t.id, 1);
    const fm = w.fm.ctx;
    const list = await helpdeskWork.listAssigned(fm, { status: 'ACTIVE', limit: 100 });
    expect(await helpdeskWork.countActive(fm)).toBe(list.pagination.total);
    expect(list.items.map(i => i.id)).toContain(t.id);
    expect(list.items.find(i => i.id === t.id)).toMatchObject({
      requesterMobile: null,
      allowedActions: ['START'],
    });
    const before = await AuditLog.count({ where: { action: 'helpdesk.ticket.contact_viewed' } });
    const g = await helpdeskWork.get(fm, t.id);
    expect(g).toMatchObject({
      id: t.id,
      kind: 'PERSONAL',
      unitLabel: expect.any(String),
      comments: expect.any(Array),
    });
    await helpdeskWork.get(fm, t.id);
    expect(await AuditLog.count({ where: { action: 'helpdesk.ticket.contact_viewed' } })).toBe(
      before + (g.requesterMobile ? 1 : 0),
    );
    await A(
      'post',
      `/tickets/${t.id}/comments`,
      { body: 'Internal for staff only', visibility: 'INTERNAL' },
      { headers: idem() },
    );
    expect((await helpdeskWork.get(fm, t.id)).comments.some(c => c.visibility === 'INTERNAL')).toBe(true);
    const started1 = await helpdeskWork.transition(fm, t.id, {
      action: 'START',
      version: a.body.data.version + 1,
    });
    expect(started1.status).toBe('IN_PROGRESS');
    const c = await helpdeskWork.addComment(fm, t.id, { body: 'On my way', visibility: 'PUBLIC' });
    expect(c).toMatchObject({ authorRole: 'STAFF', visibility: 'PUBLIC' });
    // a vendor sees only public entries; after reassignment the vendor gets 404
    setHelpdeskPorts({
      vendors: {
        getAssignable: async (_s, id) => (id === 5 ? { id: 5, name: 'Shree Lifts' } : null),
        vendorIdsForUser: async (_s, userId) => (userId === w.residentId ? [5] : []),
      },
    });
    const vendorCtx = hctx(w.society, w.residentId, { name: 'Vendor Vic' });
    const v = await A('post', `/tickets/${t.id}/assign`, {
      assigneeType: 'VENDOR',
      vendorId: 5,
      version: (await get(t.id)).version,
    });
    expect(v.status).toBe(200);
    const vget = await helpdeskWork.get(vendorCtx, t.id);
    expect(vget.comments.some(x => x.visibility === 'INTERNAL')).toBe(false);
    await expect(
      helpdeskWork.addComment(vendorCtx, t.id, { body: 'Secret', visibility: 'INTERNAL' }),
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(
      (await helpdeskWork.addComment(vendorCtx, t.id, { body: 'Parts ordered', visibility: 'PUBLIC' }))
        .authorRole,
    ).toBe('VENDOR');
    expect(
      (await helpdeskWork.listAssigned(fm, { status: 'ACTIVE', limit: 100 })).items.map(i => i.id),
    ).not.toContain(t.id);
    await expect(helpdeskWork.get(fm, t.id)).rejects.toMatchObject({ status: 404, code: 'TICKET_NOT_FOUND' });
    const back = await A('post', `/tickets/${t.id}/assign`, {
      assigneeType: 'MEMBER',
      userId: w.fmUser.id,
      version: (await get(t.id)).version,
    });
    expect(back.status).toBe(200);
    await expect(helpdeskWork.get(vendorCtx, t.id)).rejects.toMatchObject({
      status: 404,
      code: 'TICKET_NOT_FOUND',
    });
    await expect(
      helpdeskWork.transition(vendorCtx, t.id, { action: 'START', version: 1 }),
    ).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
    await expect(helpdeskWork.getFileUrl(vendorCtx, t.id, 1, 'inline')).rejects.toMatchObject({
      code: 'TICKET_NOT_FOUND',
    });
  });

  it('refuses staff resolving an approved chargeable ticket and serves ticket files to the assignee', async () => {
    const photo = ticketPhoto(w.sid, w.adminId);
    const s = await started(() =>
      flat({ cat: 'Carpentry', title: 'Fix the bedroom wardrobe', fileIds: [photo] }),
    );
    await Ticket.update({ chargeStatus: 'APPROVED', chargeEstimatePaise: 65000 }, { where: { id: s.id } });
    const row = await Ticket.findByPk(s.id);
    await expect(
      helpdeskWork.transition(w.fm.ctx, s.id, {
        action: 'RESOLVE',
        note: 'Fixed the hinge properly',
        version: row!.version,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TICKET_INVALID_TRANSITION',
      message: 'Ask the office to enter the final charge',
    });
    const g = await helpdeskWork.get(w.fm.ctx, s.id);
    expect(g.allowedActions).not.toContain('RESOLVE');
    expect((await helpdeskWork.getFileUrl(w.fm.ctx, s.id, photo, 'inline')).url).toContain(String(photo));
    await expect(helpdeskWork.getFileUrl(w.fm.ctx, s.id, photo + 900, 'inline')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('reports a building issue for the staff app and validates its input', async () => {
    const cat = await w.cat('Housekeeping');
    const r = await helpdeskWork.reportBuildingIssue(w.fm.ctx, {
      locationNodeId: w.buildingA.locationNodeId,
      categoryId: cat.id,
      urgency: 'URGENT',
      description: 'Garbage pile at the staircase',
      duplicateReason: 'Several people complained today',
    });
    expect(r).toMatchObject({ status: 'OPEN', priority: 'P2', affectedUnitCount: 2 });
    const row = await Ticket.findByPk(r.id);
    expect(row).toMatchObject({ channel: 'STAFF_APP', reporterRole: 'STAFF', kind: 'BUILDING' });
    await expect(
      helpdeskWork.reportBuildingIssue(w.fm.ctx, { categoryId: cat.id, urgency: 'URGENT' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      helpdeskWork.reportBuildingIssue(w.fm.ctx, {
        locationNodeId: 1,
        categoryId: cat.id,
        priority: 'P1',
        urgency: 'URGENT',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('creates automation tickets and reads facts', async () => {
    const cat = await w.cat('Garden');
    const sys = { ...w.admin, user: undefined } as never;
    const made = await sequelize.transaction(t =>
      tickets.createInternal(
        sys,
        {
          title: 'Water the lawn today',
          description: 'Created by an automation rule',
          categoryId: cat.id,
          priority: 'P4',
          assigneeUserId: w.fmUser.id,
          dueInDays: 2,
        },
        t,
      ),
    );
    expect(made.ticketNo).toMatch(/^TKT\//);
    const row = (await Ticket.findByPk(made.ticketId))!;
    expect(row).toMatchObject({
      kind: 'BUILDING',
      channel: 'SYSTEM',
      priority: 'P4',
      requesterName: 'System',
      status: 'ASSIGNED',
      assigneeUserId: w.fmUser.id,
    });
    expect(row.resolutionDueAt.getTime()).toBe(new Date('2026-11-03T04:30:00Z').getTime());
    const facts = await tickets.getFacts(w.sid, made.ticketId);
    expect(facts).toMatchObject({
      ticketNo: made.ticketNo,
      priority: 'P4',
      kind: 'BUILDING',
      categoryId: cat.id,
      channel: 'SYSTEM',
      isAssigned: true,
      unitId: null,
      hoursOverdue: 0,
    });
    advance(3 * 86_400_000);
    expect((await tickets.getFacts(w.sid, made.ticketId))!.hoursOverdue).toBe(24);
    expect(await tickets.getFacts(w.sid + 999, made.ticketId)).toBeNull();
    expect(await tickets.getFacts(w.sid, 99999999)).toBeNull();
  });
});
