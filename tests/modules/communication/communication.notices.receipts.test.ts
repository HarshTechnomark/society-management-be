import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Notice, NoticeReceipt, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { systemCtx } from '../../../src/types/context';
import { placeholderFiles, nextPlaceholderFileId } from '../../../src/modules/societies/societies.ports';
import { setCommunicationPorts } from '../../../src/modules/communication/communication.ports';
import { notices, noticeReports, reach } from '../../../src/modules/communication/communication.public';
import { resetAll } from '../../helpers/auth';
import { idem } from '../../helpers/access';
import { call } from '../../helpers/auth';
import { addResident, mobile, owner } from '../../helpers/residents';
import { residentSociety, residentUser } from '../../helpers/residents';
import {
  autoApproveNotices,
  mkNotice,
  noticeBody,
  noticeWorld,
  publishNow,
  resetNotices,
  type NoticeWorld,
} from '../../helpers/communication';

afterAll(closeDb);
let w: NoticeWorld;
let acc: Awaited<ReturnType<NoticeWorld['member']>>;
let noLoginUnit: number;
let n1: any; // published to everybody, ack required, SMS
beforeAll(async () => {
  await resetAll();
  await resetNotices();
  w = await noticeWorld('PREMIUM');
  await autoApproveNotices(w.sid);
  acc = await w.member('accountant');
  noLoginUnit = w.units[2]!.id;
  await addResident(w.c, { name: 'Nina NoLogin', mobile: mobile(), link: owner(noLoginUnit) });
  n1 = await publishNow(w.c, { title: 'Receipts test notice', requiresAck: true, channels: ['SMS'] });
}, 240_000);
beforeEach(async () => {
  setNow('2026-11-01T04:30:00Z');
  await resetRateLimits();
});
const ctx = () => ({
  ...systemCtx('t'),
  society: { id: w.sid, name: 'S', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: 'PREMIUM' },
  permissions: new Set<string>(),
});

describe('fan-out snapshot (BR-16-4, BR-16-14)', () => {
  it('writes one receipt per person including residents without a login', async () => {
    expect(n1).toMatchObject({ recipientCount: 4, unitCount: 4, reachedCount: 4 });
    const rows = await NoticeReceipt.findAll({ where: { noticeId: n1.id }, order: [['id', 'ASC']] });
    expect(rows).toHaveLength(4);
    const noLogin = rows.find(r => r.userId === null)!;
    expect(noLogin).toMatchObject({ unitId: noLoginUnit, reachedVia: 'SMS' });
    expect(noLogin.recipientKey).toBe(`r:${noLogin.residentId}:${noLoginUnit}`);
  });
  it('a notice without SMS or WhatsApp leaves the login-less resident unreached', async () => {
    const n = await publishNow(w.c, { title: 'In-app only notice here' });
    expect(n).toMatchObject({ recipientCount: 4, reachedCount: 3 });
    const r = await NoticeReceipt.findOne({ where: { noticeId: n.id, userId: null } });
    expect(r!.reachedAt).toBeNull();
  });
  it('residency changes later do not change the snapshot', async () => {
    const before = await NoticeReceipt.count({ where: { noticeId: n1.id } });
    await addResident(w.c, {
      name: 'Late Joiner',
      mobile: mobile(),
      link: owner(w.units[0]!.id, { relation: 'CO_OWNER' }),
    });
    expect(await NoticeReceipt.count({ where: { noticeId: n1.id } })).toBe(before);
  });
});

describe('GET /notices/:id/receipts (8.15)', () => {
  beforeAll(async () => {
    const r1 = await NoticeReceipt.findOne({ where: { noticeId: n1.id, userId: w.r1.user.id } });
    const r2 = await NoticeReceipt.findOne({ where: { noticeId: n1.id, userId: w.r2.user.id } });
    await r1!.update({
      firstReadAt: new Date('2026-11-01T05:00:00Z'),
      readCount: 1,
      acknowledgedAt: new Date('2026-11-01T05:01:00Z'),
      ackRevisionNo: 1,
    });
    await r2!.update({ firstReadAt: new Date('2026-11-01T05:30:00Z'), readCount: 2 });
    await Notice.update({ readCount: 2, ackCount: 1 }, { where: { id: n1.id } });
  });
  it('returns summary and items with the pagination block', async () => {
    const r = await w.c('get', `/notices/${n1.id}/receipts`);
    expect(r.status).toBe(200);
    expect(r.body.pagination).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
    expect(r.body.data.summary).toMatchObject({
      recipients: 4,
      units: 4,
      reached: 4,
      read: 2,
      acknowledged: 1,
      unitsAcknowledged: 1,
      byChannel: { IN_APP: 3, PUSH: 0, WHATSAPP: 0, EMAIL: 0 },
    });
    const bb = r.body.data.summary.byBuilding;
    expect(bb).toEqual([
      { buildingId: w.buildingId, code: 'A', units: 3, unitsRead: 2 },
      { buildingId: w.buildingB.id, code: 'B', units: 1, unitsRead: 0 },
    ]);
    const items = r.body.data.items;
    expect(items.map((i: any) => i.unitLabel)).toEqual(['A-101', 'A-102', 'A-103', 'B-101']);
    expect(items[0]).toEqual({
      receiptId: expect.any(Number),
      unitId: w.units[0]!.id,
      unitLabel: 'A-101',
      name: 'Rohan Mehta',
      relation: 'OWNER',
      mobile: expect.stringMatching(/^\d{10}$/),
      reachedVia: 'IN_APP',
      firstReadAt: '2026-11-01T05:00:00.000Z',
      acknowledgedAt: '2026-11-01T05:01:00.000Z',
      remindersSent: 0,
    });
  });
  it('filters, searches, sorts and pages', async () => {
    const q = (qs: string) => w.c('get', `/notices/${n1.id}/receipts?${qs}`);
    expect((await q('filter=NOT_READ')).body.data.items.map((i: any) => i.unitLabel)).toEqual([
      'A-103',
      'B-101',
    ]);
    expect((await q('filter=ACKED')).body.data.items).toHaveLength(1);
    expect((await q('filter=NOT_ACKED')).body.data.items).toHaveLength(3);
    const un = await q('filter=UNREACHED');
    expect(un.body.data.items.map((i: any) => i.name)).toEqual(['Nina NoLogin']); // no user: unreached by definition
    expect((await q(`buildingId=${w.buildingB.id}`)).body.data.items.map((i: any) => i.name)).toEqual([
      'Bela Bhosale',
    ]);
    expect((await q('q=Tina')).body.data.items.map((i: any) => i.unitLabel)).toEqual(['A-102']);
    expect((await q('q=A-10')).body.data.items).toHaveLength(3);
    expect((await q('sortBy=firstReadAt&sortOrder=desc&limit=1&page=1')).body.data.items[0].unitLabel).toBe(
      'A-102',
    );
    const p2 = await q('limit=3&page=2');
    expect(p2.body.pagination).toMatchObject({ total: 4, totalPages: 2 });
    expect(p2.body.data.items).toHaveLength(1);
    for (const bad of ['filter=NOPE', 'q=a', 'sortBy=name', 'limit=500', 'x=1'])
      expect((await q(bad)).status, bad).toBe(400);
  });
  it('shows unreached residents of a notice without SMS', async () => {
    const n = await publishNow(w.c, { title: 'Unreached follow up test' });
    const r = await w.c('get', `/notices/${n.id}/receipts?filter=UNREACHED`);
    expect(r.body.data.items.map((i: any) => i.name)).toEqual(['Late Joiner', 'Nina NoLogin']);
  });
  it('masks the mobile without residents.contacts.view', async () => {
    const r = await acc.c('get', `/notices/${n1.id}/receipts`);
    expect(r.status).toBe(200);
    expect(r.body.data.items[0].mobile).toMatch(/^\d{2}XXXXX\d{3}$/);
  });
  it('is INVALID_STATE before publish and 404 for another society', async () => {
    const d = await mkNotice(w.c);
    expect((await w.c('get', `/notices/${d.id}/receipts`)).body.code).toBe('INVALID_STATE');
    const other = await residentSociety({ plan: 'PREMIUM', flats: 1 });
    const x = await mkNotice(other.c);
    expect((await w.c('get', `/notices/${x.id}/receipts`)).status).toBe(404);
    expect((await w.c('get', `/notices/${x.id}/receipts/export`)).status).toBe(404);
  });
  it('402 for the unreached filter on a Starter plan', async () => {
    const s = await residentSociety({ plan: 'STARTER', flats: 1 });
    await residentUser(s.society, s.unit(1).id, { name: 'Starter Resident' });
    await autoApproveNotices(s.society.id!);
    const n = await publishNow(s.c, { title: 'Starter plan notice' });
    const ok = await s.c('get', `/notices/${n.id}/receipts`);
    expect(ok.status).toBe(200);
    const r = await s.c('get', `/notices/${n.id}/receipts?filter=UNREACHED`);
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });
});

describe('GET /notices/:id/receipts/export (8.16)', () => {
  it('streams a CSV with the same filters and audits the export', async () => {
    const r = await w.c('get', `/notices/${n1.id}/receipts/export?filter=ALL`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain(
      `notice-${String(n1.id).padStart(6, '0')}-receipts.csv`,
    );
    const lines = String(r.text ?? r.body)
      .trim()
      .split(/\r?\n/);
    expect(lines[0]).toBe('Flat,Building,Name,Relation,Mobile,Reached via,Read at,Acknowledged at,Reminders');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('A-101,A,Rohan Mehta,OWNER');
    const filtered = await w.c('get', `/notices/${n1.id}/receipts/export?filter=ACKED`);
    expect(
      String(filtered.text ?? filtered.body)
        .trim()
        .split(/\r?\n/),
    ).toHaveLength(2);
    const a = await AuditLog.findAll({
      where: { action: 'communication.notice_receipts.exported', entityId: String(n1.id) },
    });
    expect(a.length).toBe(2);
  });
  it('needs notices.edit (403 for a viewer) and is rate limited to 10 an hour (429)', async () => {
    expect((await acc.c('get', `/notices/${n1.id}/receipts/export`)).status).toBe(403);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await w.c('get', `/notices/${n1.id}/receipts/export`)).status;
    expect(last).toBe(429);
  });
});

describe('attachment download URLs (8.17)', () => {
  it('serves linked, clean files only', async () => {
    const mk = (status: string) => {
      const id = nextPlaceholderFileId();
      placeholderFiles.set(id, {
        fileId: id,
        societyId: w.sid,
        purpose: 'NOTICE_ATTACHMENT',
        name: `f${id}.pdf`,
        contentType: 'application/pdf',
        content: Buffer.from('pdf'),
        ownerUserId: null,
        status: 'CLEAN',
      });
      return { id, set: () => (placeholderFiles.get(id)!.status = status as never) };
    };
    const f = mk('CLEAN');
    const n = await mkNotice(w.c, { fileIds: [f.id] });
    const ok = await w.c('get', `/notices/${n.id}/attachments/${f.id}/download-url`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({
      url: expect.stringContaining(`/files/${f.id}`),
      expiresAt: expect.any(String),
    });
    expect(ok.body.data.url).toContain('disposition=attachment');
    const inline = await w.c('get', `/notices/${n.id}/attachments/${f.id}/download-url?disposition=inline`);
    expect(inline.body.data.url).not.toContain('disposition=');
    const other = mk('CLEAN');
    const nf = await w.c('get', `/notices/${n.id}/attachments/${other.id}/download-url`);
    expect([nf.status, nf.body.code]).toEqual([404, 'FILE_NOT_FOUND']);
    placeholderFiles.get(f.id)!.status = 'PENDING' as never;
    expect((await w.c('get', `/notices/${n.id}/attachments/${f.id}/download-url`)).body.code).toBe(
      'FILE_NOT_READY',
    );
    placeholderFiles.get(f.id)!.status = 'INFECTED' as never;
    expect((await w.c('get', `/notices/${n.id}/attachments/${f.id}/download-url`)).body.code).toBe(
      'FILE_INFECTED',
    );
    const x = await residentSociety({ plan: 'PREMIUM', flats: 1 });
    const xn = await mkNotice(x.c);
    expect((await w.c('get', `/notices/${xn.id}/attachments/${f.id}/download-url`)).body.code).toBe(
      'NOTICE_NOT_FOUND',
    );
  });
});

describe('permission matrix (T16-35)', () => {
  it('view-only roles read but cannot write; residents and anonymous callers are refused', async () => {
    const n = await mkNotice(w.c);
    const writes: [string, string, unknown][] = [
      ['post', '/notices', noticeBody()],
      ['post', '/notices/audience-preview', { audience: { type: 'ALL' } }],
      ['patch', `/notices/${n.id}`, { version: 1, title: 'Viewer edit here' }],
      ['post', `/notices/${n.id}/publish`, { version: 1 }],
      ['post', `/notices/${n.id}/withdraw`, { version: 1 }],
      ['post', `/notices/${n.id}/recall`, { version: 1, reason: 'Reason long enough' }],
      ['post', `/notices/${n.id}/pin`, { version: 1 }],
      ['post', `/notices/${n.id}/unpin`, { version: 1 }],
      ['post', `/notices/${n.id}/archive`, { version: 1 }],
      ['post', `/notices/${n.id}/duplicate`, undefined],
      ['post', `/notices/${n.id}/remind`, { version: 1 }],
      ['post', `/notices/${n.id}/restored`, { version: 1 }],
      ['get', `/notices/${n1.id}/receipts/export`, undefined],
      ['get', '/notices/templates', undefined],
    ];
    for (const [m, p, b] of writes) {
      const r = await acc.c(m as never, p, b, { headers: idem() });
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 403, 'PERMISSION_DENIED']);
    }
    for (const p of ['/notices', `/notices/${n.id}`, `/notices/${n1.id}/receipts`])
      expect((await acc.c('get', p)).status, p).toBe(200);
    // a resident (owner) has no communication.notices permissions
    for (const [m, p] of [
      ['get', '/notices'],
      ['get', `/notices/${n.id}`],
      ['post', '/notices'],
    ] as const) {
      const r = await w.r1.c(m, p, m === 'post' ? noticeBody() : undefined, { headers: idem() });
      expect([m, p, r.status]).toEqual([m, p, 403]);
    }
    expect((await call('get', '/notices')).status).toBe(401);
  });
});

describe('public API for other modules (8.38)', () => {
  const sys = (over: Record<string, unknown> = {}) => ({
    sourceModule: '12',
    sourceRefType: 'collection',
    sourceRefId: 2,
    title: 'Terrace waterproofing collection',
    body: '<p>A new collection was published for the terrace waterproofing work.</p>',
    category: 'FINANCE' as const,
    audience: { type: 'ALL' as const },
    ...over,
  });
  it('createSystemNotice is unique per source record, starts PUBLISHED and fans out (T16-30)', async () => {
    const a = await notices.createSystemNotice(ctx(), sys());
    const b = await notices.createSystemNotice(ctx(), sys({ title: 'Changed title not used' }));
    expect(a.created).toBe(true);
    expect(b).toEqual({ noticeId: a.noticeId, created: false });
    await drainQueues();
    const row = (await Notice.findByPk(a.noticeId))!;
    expect(row).toMatchObject({
      kind: 'SYSTEM',
      status: 'PUBLISHED',
      sourceModule: '12',
      sourceRefType: 'collection',
      sourceRefId: 2,
      recipientCount: 5,
    });
    expect(row.fanoutCompletedAt).not.toBeNull();
    const list = await w.c('get', '/notices?kind=SYSTEM');
    expect(list.body.data.map((x: any) => x.id)).toContain(a.noticeId);
    // system notices cannot be created through the API
    expect((await w.c('post', '/notices', noticeBody({ kind: 'SYSTEM' }), { headers: idem() })).status).toBe(
      400,
    );
    await notices.recallBySource(ctx(), 'collection', 2, 'The collection was cancelled');
    expect(await Notice.findByPk(a.noticeId)).toMatchObject({
      status: 'RECALLED',
      recallReason: 'The collection was cancelled',
    });
    await notices.recallBySource(ctx(), 'collection', 2, 'Again'); // no-op
    await notices.recallBySource(ctx(), 'collection', 999, 'Nothing there'); // no-op
    expect(
      (
        await AuditLog.findAll({
          where: { action: 'communication.notice.recalled', entityId: String(a.noticeId) },
        })
      ).length,
    ).toBe(1);
  });
  it('createDraft makes an ALL-audience DRAFT in the callers transaction', async () => {
    const { noticeId } = await sequelize.transaction(t =>
      notices.createDraft(
        ctx(),
        { title: 'Automation draft notice', body: '<p>Written by automation rule.</p>', category: 'GENERAL' },
        t,
      ),
    );
    const d = (await w.c('get', `/notices/${noticeId}`)).body.data;
    expect(d).toMatchObject({ status: 'DRAFT', audience: { type: 'ALL' } });
  });
  it('ackSummary and hasUserAcknowledged read the receipts', async () => {
    expect(await notices.ackSummary(w.sid, n1.id)).toEqual({ audience: 4, acknowledged: 1 });
    expect(await notices.hasUserAcknowledged(w.sid, n1.id, w.r1.user.id)).toEqual({
      acknowledged: true,
      at: '2026-11-01T05:01:00.000Z',
    });
    expect(await notices.hasUserAcknowledged(w.sid, n1.id, w.r2.user.id)).toEqual({
      acknowledged: false,
      at: null,
    });
    expect(await notices.ackSummary(w.sid + 999, n1.id)).toEqual({ audience: 0, acknowledged: 0 });
  });
  it('reach readers report percentages for the range and only for the society (T16-58, T16-59)', async () => {
    const x = await residentSociety({ plan: 'PREMIUM', flats: 1 });
    await Notice.update({ status: 'ARCHIVED' }, { where: { societyId: w.sid } });
    await Notice.update(
      {
        status: 'PUBLISHED',
        publishedAt: new Date('2026-10-30T04:30:00Z'),
        recipientCount: 64,
        readCount: 45,
        requiresAck: false,
        ackCount: 0,
      },
      { where: { id: n1.id } },
    );
    const n2 = await publishNow(w.c, { title: 'Second reach notice', requiresAck: true });
    await Notice.update(
      { recipientCount: 64, readCount: 32, ackCount: 16, publishedAt: new Date('2026-10-31T04:30:00Z') },
      { where: { id: n2.id } },
    );
    await Notice.update(
      {
        status: 'PUBLISHED',
        recipientCount: 10,
        readCount: 10,
        publishedAt: new Date('2026-10-30T04:30:00Z'),
      },
      { where: { societyId: x.society.id! } },
    ).catch(() => undefined);
    const rep = await noticeReports.reachByNotice(w.sid, '2026-10-30', '2026-10-31', {
      deadlineMs: 5000,
      sortBy: 'readPct',
      sortOrder: 'desc',
    });
    expect(rep.total).toBe(2);
    expect(rep.rows.map(r => [r.noticeId, r.readPct, r.ackPct, r.audienceSize])).toEqual([
      [n1.id, '70.3', null, 64],
      [n2.id, '50.0', '25.0', 64],
    ]);
    const asc = await noticeReports.reachByNotice(w.sid, '2026-10-30', '2026-10-31', {
      deadlineMs: 5000,
      sortBy: 'publishedAt',
      sortOrder: 'asc',
      limit: 1,
    });
    expect(asc.rows.map(r => r.noticeId)).toEqual([n1.id]);
    expect(rep.totals).toEqual(await reach.forNotices(w.sid, '2026-10-30', '2026-10-31'));
    expect(rep.totals).toEqual({ notices: 2, avgReadPct: '60.2', avgAckPct: '25.0' });
    expect(await reach.forNotices(w.sid, '2025-01-01', '2025-01-31')).toEqual({
      notices: 0,
      avgReadPct: '0.0',
      avgAckPct: '0.0',
    });
  });
});

void setCommunicationPorts;
