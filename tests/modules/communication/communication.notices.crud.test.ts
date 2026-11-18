import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, Notice, closeDb } from '../../../src/models';
import { placeholderFiles, nextPlaceholderFileId } from '../../../src/modules/societies/societies.ports';
import { setCommunicationPorts } from '../../../src/modules/communication/communication.ports';
import { events, resetAll } from '../../helpers/auth';
import { idem } from '../../helpers/access';
import { residentSociety } from '../../helpers/residents';
import {
  autoApproveNotices,
  mkNotice,
  noticeBody,
  noticeWorld,
  resetNotices,
  type NoticeWorld,
} from '../../helpers/communication';

afterAll(closeDb);
let w: NoticeWorld;
let acc: Awaited<ReturnType<NoticeWorld['member']>>; // accountant: notices view only
let mgr: Awaited<ReturnType<NoticeWorld['member']>>; // committee_member: view + create
let sec: Awaited<ReturnType<NoticeWorld['member']>>; // secretary: all
beforeAll(async () => {
  void events;
  await resetAll();
  await resetNotices();
  w = await noticeWorld('PREMIUM');
  await autoApproveNotices(w.sid);
  acc = await w.member('accountant');
  mgr = await w.member('treasurer'); // VC
  sec = await w.member('secretary');
}, 240_000);

const audits = (action: string, id?: number) =>
  AuditLog.findAll({ where: { action, ...(id ? { entityId: String(id) } : {}) } });

describe('POST /notices (8.2)', () => {
  it('creates a sanitised draft with computed fields and audits without the body', async () => {
    const r = await w.c(
      'post',
      '/notices',
      noticeBody({
        body: '<p>Hello <script>alert(1)</script><strong>all</strong></p>',
        title: '  Lift service  ',
      }),
      { headers: idem() },
    );
    expect(r.status).toBe(201);
    const n = r.body.data;
    expect(n).toMatchObject({
      status: 'DRAFT',
      title: 'Lift service',
      body: '<p>Hello <strong>all</strong></p>',
      number: `NTC-${String(n.id).padStart(6, '0')}`,
      kind: 'STANDARD',
      priority: 'NORMAL',
      locale: 'en-IN',
      revisionNo: 1,
      version: 1,
      audience: { type: 'ALL', relation: 'ANY', ids: null, roleKeys: null, label: 'All residents' },
      author: { id: w.chairman.id },
    });
    const row = await Notice.findByPk(n.id);
    expect(row!.bodyText).toBe('Hello all');
    const [a] = await audits('communication.notice.created', n.id);
    expect(JSON.stringify(a!.after)).not.toContain('Hello');
  });
  it('replays the same Idempotency-Key and rejects a changed body', async () => {
    const h = idem();
    const a = await w.c('post', '/notices', noticeBody({ title: 'Idempotent notice' }), { headers: h });
    const b = await w.c('post', '/notices', noticeBody({ title: 'Idempotent notice' }), { headers: h });
    expect(b.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    const c = await w.c('post', '/notices', noticeBody({ title: 'Another notice' }), { headers: h });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  it('validates strictly', async () => {
    const bad: Record<string, unknown>[] = [
      { title: 'abc' },
      { kind: 'SYSTEM' },
      { unknown: 1 },
      { audience: { type: 'BUILDINGS' } },
      { audience: { type: 'ROLES', roleKeys: ['chairman'], relation: 'OWNERS' } },
      { channels: ['PUSH'] },
      { ackDueAt: '2026-12-01T00:00:00.000Z' },
      { actions: [{ type: 'LINK', url: 'http://x.in', label: 'Go' }] },
      {
        actions: [
          { type: 'PAY_DUES' },
          { type: 'PAY_DUES' },
          { type: 'LINK', url: 'https://a.in', label: 'Go' },
        ],
      },
      { kind: 'UTILITY_SHUTDOWN' },
      { fileIds: [1, 1] },
    ];
    for (const b of bad) {
      const r = await w.c('post', '/notices', noticeBody(b), { headers: idem() });
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
    const noKey = await w.c('post', '/notices', noticeBody());
    expect(noKey.status).toBe(400);
  });
  it('checks that buildings, flats and roles exist in this society (422)', async () => {
    const other = await residentSociety({ plan: 'PREMIUM', flats: 1 });
    for (const audience of [
      { type: 'BUILDINGS', ids: [other.buildingId] },
      { type: 'UNITS', ids: [other.unit(1).id] },
      { type: 'ROLES', roleKeys: ['no_such_role'] },
    ]) {
      const r = await w.c('post', '/notices', noticeBody({ audience }), { headers: idem() });
      expect(r.status, JSON.stringify(audience)).toBe(422);
      expect(r.body.code).toBe('NOTICE_AUDIENCE_INVALID');
    }
    const ok = await w.c(
      'post',
      '/notices',
      noticeBody({
        audience: { type: 'BUILDINGS', ids: [w.buildingB.id, w.buildingId], relation: 'OWNERS' },
      }),
      { headers: idem() },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data.audience).toMatchObject({
      type: 'BUILDINGS',
      relation: 'OWNERS',
      ids: [w.buildingId, w.buildingB.id].sort((a, b) => a - b),
    });
    const roles = await w.c(
      'post',
      '/notices',
      noticeBody({ audience: { type: 'ROLES', roleKeys: ['treasurer', 'secretary'] } }),
      { headers: idem() },
    );
    expect(roles.status).toBe(201);
    expect(roles.body.data.audience.roleKeys).toEqual(['secretary', 'treasurer']);
  });
  it('creates a utility shutdown notice', async () => {
    const r = await w.c(
      'post',
      '/notices',
      noticeBody({
        kind: 'UTILITY_SHUTDOWN',
        utilityType: 'WATER',
        outageStartsAt: '2026-11-05T04:30:00.000Z',
        outageEndsAt: '2026-11-05T08:30:00.000Z',
      }),
      { headers: idem() },
    );
    expect(r.status).toBe(201);
    expect(r.body.data.utility).toEqual({
      type: 'WATER',
      startsAt: '2026-11-05T04:30:00.000Z',
      endsAt: '2026-11-05T08:30:00.000Z',
      restoredAt: null,
    });
  });
  it('links attachments and refuses unknown ones', async () => {
    const id = nextPlaceholderFileId();
    placeholderFiles.set(id, {
      fileId: id,
      societyId: w.sid,
      purpose: 'NOTICE_ATTACHMENT',
      name: 'quotes.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('x'.repeat(100)),
      ownerUserId: null,
      status: 'CLEAN',
    });
    const r = await w.c('post', '/notices', noticeBody({ fileIds: [id] }), { headers: idem() });
    expect(r.status).toBe(201);
    expect(r.body.data.attachments).toEqual([
      { fileId: id, name: 'quotes.pdf', sizeBytes: 100, status: 'CLEAN' },
    ]);
    const bad = await w.c('post', '/notices', noticeBody({ fileIds: [999999] }), { headers: idem() });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('FILE_NOT_LINKABLE');
  });
});

describe('permissions and plan gates', () => {
  it('view-only members cannot create, patch or delete (403)', async () => {
    const r = await acc.c('post', '/notices', noticeBody(), { headers: idem() });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
    const n = await mkNotice(w.c);
    expect((await acc.c('patch', `/notices/${n.id}`, { version: 1, title: 'New title here' })).status).toBe(
      403,
    );
    expect((await acc.c('delete', `/notices/${n.id}?version=1`)).status).toBe(403);
    expect((await acc.c('get', `/notices/${n.id}`)).status).toBe(200);
    expect((await acc.c('get', '/notices')).status).toBe(200);
  });
  it('a creator cannot edit or delete the draft of someone else without edit/delete', async () => {
    const n = await mkNotice(w.c);
    expect((await mgr.c('patch', `/notices/${n.id}`, { version: 1, title: 'Hijacked title' })).status).toBe(
      403,
    );
    expect((await mgr.c('delete', `/notices/${n.id}?version=1`)).status).toBe(403);
    // the secretary (edit) may
    expect(
      (await sec.c('patch', `/notices/${n.id}`, { version: 1, title: 'Edited by secretary' })).status,
    ).toBe(200);
    // an author with create may edit and delete their own
    const own = await mkNotice(mgr.c);
    expect(
      (await mgr.c('patch', `/notices/${own.id}`, { version: 1, title: 'Edited by author' })).status,
    ).toBe(200);
    expect((await mgr.c('delete', `/notices/${own.id}?version=2`)).status).toBe(204);
  });
  it('gates the WhatsApp channel by plan (402) on a Starter society', async () => {
    const s = await residentSociety({ plan: 'STARTER', flats: 2 });
    const post = (b: Record<string, unknown>) => s.c('post', '/notices', noticeBody(b), { headers: idem() });
    expect((await post({})).status).toBe(201);
    expect((await post({ channels: ['SMS', 'EMAIL'] })).status).toBe(201);
    const r = await post({ channels: ['WHATSAPP'] });
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });
});

describe('GET /notices and /notices/:id (8.1, 8.5)', () => {
  it('lists with filters, search, sort and pagination', async () => {
    await mkNotice(w.c, { title: 'Parking rules reminder', category: 'GENERAL' });
    await mkNotice(w.c, { title: 'Annual maintenance dues', category: 'FINANCE' });
    const all = await w.c('get', '/notices?limit=2&page=1');
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.pagination).toMatchObject({ page: 1, limit: 2 });
    expect(all.body.pagination.total).toBeGreaterThan(4);
    const fin = await w.c('get', '/notices?category=FINANCE');
    expect(fin.body.data.every((n: any) => n.category === 'FINANCE')).toBe(true);
    const q = await w.c('get', '/notices?q=parking');
    expect(q.body.data.map((n: any) => n.title)).toContain('Parking rules reminder');
    const byTitle = await w.c('get', '/notices?sortBy=title&sortOrder=asc&limit=100');
    const titles = byTitle.body.data.map((n: any) => n.title);
    expect(titles).toEqual(
      [...titles].sort((a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })).length
        ? titles
        : [],
    );
    expect((await w.c('get', '/notices?status=DRAFT&pinned=false&sortBy=readPct')).status).toBe(200);
    expect(
      (await w.c('get', '/notices?status=ACTIVE')).body.data.every((n: any) =>
        ['PUBLISHED', 'SCHEDULED', 'PENDING_APPROVAL'].includes(n.status),
      ),
    ).toBe(true);
    const item = all.body.data[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'actions',
        'ackCount',
        'audienceLabel',
        'author',
        'category',
        'excerpt',
        'id',
        'isPinned',
        'kind',
        'number',
        'priority',
        'publishedAt',
        'readCount',
        'recipientCount',
        'requiresAck',
        'scheduledAt',
        'status',
        'title',
        'version',
      ].sort(),
    );
  });
  it('rejects bad queries (400) and a one-letter q', async () => {
    for (const qs of [
      'sortBy=nope',
      'q=a',
      'from=2026-02-30',
      'from=2026-12-01&to=2026-11-01',
      'foo=1',
      'limit=101',
      'from=2025-01-01&to=2026-11-01',
    ])
      expect((await w.c('get', `/notices?${qs}`)).status, qs).toBe(400);
  });
  it('404 NOTICE_NOT_FOUND for another society (tenant isolation)', async () => {
    const other = await residentSociety({ plan: 'PREMIUM', flats: 1 });
    const n = await mkNotice(other.c);
    const r = await w.c('get', `/notices/${n.id}`);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOTICE_NOT_FOUND');
    for (const [m, p, b] of [
      ['patch', `/notices/${n.id}`, { version: 1, title: 'Stolen title' }],
      ['post', `/notices/${n.id}/publish`, { version: 1 }],
      ['post', `/notices/${n.id}/pin`, { version: 1 }],
      ['post', `/notices/${n.id}/duplicate`, undefined],
    ] as const) {
      const x = await w.c(m, p, b, { headers: idem() });
      expect(x.status, p).toBe(404);
    }
    expect((await w.c('delete', `/notices/${n.id}?version=1`)).status).toBe(404);
    const list = await w.c('get', '/notices?limit=100');
    expect(list.body.data.some((x: any) => x.id === n.id)).toBe(false);
  });
});

describe('PATCH and DELETE a draft (8.6, 8.7)', () => {
  it('edits every field, bumps the version and checks the optimistic lock', async () => {
    const n = await mkNotice(w.c);
    const r = await w.c('patch', `/notices/${n.id}`, {
      version: 1,
      title: 'Brand new title',
      body: '<p>Different text for the notice</p>',
      category: 'SAFETY',
      priority: 'HIGH',
      requiresAck: true,
      ackDueAt: '2026-12-01T00:00:00.000Z',
      isPinned: true,
      audience: { type: 'UNITS', ids: [w.units[0]!.id] },
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      title: 'Brand new title',
      category: 'SAFETY',
      priority: 'HIGH',
      requiresAck: true,
      isPinned: true,
      version: 2,
      revisionNo: 1,
      audience: { type: 'UNITS', ids: [w.units[0]!.id], label: expect.stringContaining(w.units[0]!.label) },
    });
    const stale = await w.c('patch', `/notices/${n.id}`, { version: 1, title: 'Late edit here' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const clear = await w.c('patch', `/notices/${n.id}`, { version: 2, requiresAck: false });
    expect(clear.body.data.ackDueAt).toBeNull();
    const [a] = await audits('communication.notice.updated', n.id);
    expect((a!.after as any).changed).toContain('title');
    expect(JSON.stringify(a!.after)).not.toContain('Different text');
  });
  it('rejects ackDueAt without requiresAck and utility fields on a standard notice', async () => {
    const n = await mkNotice(w.c);
    expect(
      (await w.c('patch', `/notices/${n.id}`, { version: 1, ackDueAt: '2026-12-01T00:00:00.000Z' })).status,
    ).toBe(400);
    expect((await w.c('patch', `/notices/${n.id}`, { version: 1, utilityType: 'WATER' })).status).toBe(400);
  });
  it('deletes a draft (204) and then it is gone; a pinned version check applies', async () => {
    const n = await mkNotice(w.c);
    expect((await w.c('delete', `/notices/${n.id}?version=9`)).status).toBe(409);
    expect((await w.c('delete', `/notices/${n.id}?version=1`)).status).toBe(204);
    expect((await w.c('get', `/notices/${n.id}`)).status).toBe(404);
    expect(await Notice.findByPk(n.id)).toBeNull();
    expect((await Notice.findByPk(n.id, { paranoid: false }))?.deletedAt).not.toBeNull();
    expect((await audits('communication.notice.deleted', n.id)).length).toBe(1);
  });
});

describe('templates, preview and duplicate (8.3, 8.4, 8.12)', () => {
  it('returns the library, filtered by locale', async () => {
    const r = await w.c('get', '/notices/templates?locale=mr-IN');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(8);
    expect(r.body.data[0]).toEqual(
      expect.objectContaining({ key: expect.any(String), locale: 'mr-IN', category: expect.any(String) }),
    );
    expect((await w.c('get', '/notices/templates')).body.data).toHaveLength(24);
    expect((await w.c('get', '/notices/templates?locale=fr-FR')).status).toBe(400);
    expect((await acc.c('get', '/notices/templates')).status).toBe(403);
  });
  it('previews the audience (units, people, with and without login)', async () => {
    const r = await w.c('post', '/notices/audience-preview', { audience: { type: 'ALL' } });
    expect(r.status).toBe(200);
    expect(r.body.data.units).toBe(3);
    expect(r.body.data.people).toBe(r.body.data.withLogin + r.body.data.withoutLogin);
    expect(r.body.data.withLogin).toBe(3);
    expect(r.body.data.sample.length).toBeLessThanOrEqual(20);
    expect(r.body.data.sample[0]).toEqual({ unitId: expect.any(Number), unitLabel: expect.any(String) });
    const b = await w.c('post', '/notices/audience-preview', {
      audience: { type: 'BUILDINGS', ids: [w.buildingB.id] },
    });
    expect(b.body.data).toMatchObject({ units: 1, people: 1 });
    const empty = await w.c('post', '/notices/audience-preview', {
      audience: { type: 'UNITS', ids: [w.units[2]!.id] },
    });
    expect(empty.body.data).toMatchObject({ units: 0, people: 0 });
    const roles = await w.c('post', '/notices/audience-preview', {
      audience: { type: 'ROLES', roleKeys: ['secretary'] },
    });
    expect(roles.body.data).toMatchObject({ units: 0, people: 1, withLogin: 1 });
    expect(
      (await w.c('post', '/notices/audience-preview', { audience: { type: 'UNITS', ids: [1e9] } })).status,
    ).toBe(422);
  });
  it('duplicates any notice into a new draft', async () => {
    const n = await mkNotice(w.c, {
      title: 'Original long title',
      requiresAck: true,
      channels: ['SMS'],
      priority: 'HIGH',
      audience: { type: 'BUILDINGS', ids: [w.buildingId] },
    });
    const r = await w.c('post', `/notices/${n.id}/duplicate`, undefined, { headers: idem() });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'DRAFT',
      title: 'Copy of Original long title',
      requiresAck: true,
      channels: ['SMS'],
      priority: 'HIGH',
      version: 1,
      audience: { type: 'BUILDINGS', ids: [w.buildingId] },
    });
    expect(r.body.data.id).not.toBe(n.id);
    const [a] = await audits('communication.notice.created', r.body.data.id);
    expect((a!.after as any).duplicatedFrom).toBe(n.id);
    const long = await mkNotice(w.c, { title: 'x'.repeat(150) });
    const d2 = await w.c('post', `/notices/${long.id}/duplicate`, undefined, { headers: idem() });
    expect(d2.body.data.title).toHaveLength(150);
  });
});

void setCommunicationPorts;
