import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, InboxItem, Notice, NoticeReceipt, closeDb, sequelize } from '../../../src/models';
import { makeNotice, makeReceipt, residentsWorld } from '../../helpers/communication';
import { events } from '../../helpers/auth';
import { makeSociety } from '../../helpers/access';
import { placeholderFiles } from '../../../src/modules/societies/societies.ports';
import {
  communicationPorts,
  setCommunicationPorts,
} from '../../../src/modules/communication/communication.ports';

afterAll(async () => {
  await closeDb();
});
let w: Awaited<ReturnType<typeof residentsWorld>>;
beforeEach(async () => {
  w = await residentsWorld();
});
const titles = (r: { body: { data: { title: string }[] } }) => r.body.data.map(x => x.title);

describe('T16-2 resident notice board (8.19)', () => {
  it('shows what the audience or a receipt allows; orders pinned, unacknowledged, newest; filters; isolates tenants', async () => {
    await makeNotice(w.sid, { title: 'All residents', publishedAt: new Date('2026-10-25T00:00:00Z') });
    await makeNotice(w.sid, {
      title: 'Tower A only',
      audienceType: 'BUILDINGS',
      audienceIds: [w.buildingA.id],
      publishedAt: new Date('2026-10-26T00:00:00Z'),
    });
    await makeNotice(w.sid, { title: 'Tenants only', audienceRelation: 'TENANTS' });
    await makeNotice(w.sid, { title: 'Flat B-101', audienceType: 'UNITS', audienceIds: [w.b101] });
    await makeNotice(w.sid, { title: 'Roles only', audienceType: 'ROLES', audienceRoleKeys: ['chairman'] });
    await makeNotice(w.sid, { title: 'Still a draft', status: 'DRAFT', publishedAt: null });
    await makeNotice(w.sid, { title: 'Recalled one', status: 'RECALLED' });
    await makeNotice(w.sid, {
      title: 'Pinned notice',
      isPinned: true,
      pinnedAt: new Date('2026-10-01T00:00:00Z'),
      publishedAt: new Date('2026-09-01T00:00:00Z'),
    });
    await makeNotice(w.sid, {
      title: 'Must acknowledge',
      requiresAck: true,
      publishedAt: new Date('2026-10-20T00:00:00Z'),
    });
    await makeNotice(w.sid, {
      title: 'Expired lately',
      status: 'EXPIRED',
      expiredAt: new Date('2026-10-20T00:00:00Z'),
      publishedAt: new Date('2026-10-01T00:00:00Z'),
    });
    await makeNotice(w.sid, {
      title: 'Expired long ago',
      status: 'EXPIRED',
      expiredAt: new Date('2026-08-01T00:00:00Z'),
    });
    const foreign = await makeSociety('Other CHS');
    await makeNotice(foreign.id!, { title: 'Other society' });

    const a = await w.a1.c('get', '/me/notices');
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(titles(a)).toEqual([
      'Pinned notice',
      'Must acknowledge',
      'Tower A only',
      'All residents',
      'Expired lately',
    ]);
    expect(a.body.pagination).toMatchObject({ total: 5, page: 1, limit: 20 });
    expect(a.body.data[1]).toMatchObject({
      requiresAck: true,
      acknowledgedAt: null,
      readAt: null,
      actions: [],
      attachmentCount: 0,
    });
    expect(a.body.data[0].excerpt).toContain('Pinned notice');
    expect(a.body.data.find((x: { title: string }) => x.title === 'Expired lately').status).toBe('EXPIRED');

    // B-101 owner: the all-resident notice, the flat notice, not Tower A
    expect(titles(await w.b1.c('get', '/me/notices'))).toEqual([
      'Pinned notice',
      'Must acknowledge',
      'Flat B-101',
      'All residents',
      'Expired lately',
    ]);

    // filters and validation
    expect(titles(await w.a1.c('get', '/me/notices?q=Tower'))).toEqual(['Tower A only']);
    expect((await w.a1.c('get', '/me/notices?q=T')).status).toBe(400);
    expect((await w.a1.c('get', '/me/notices?limit=51')).status).toBe(400);
    expect((await w.a1.c('get', '/me/notices?bogus=1')).status).toBe(400);
    expect((await w.a1.c('get', '/me/notices?limit=2&page=2')).body.data).toHaveLength(2);
    expect((await w.a1.c('get', '/me/notices?category=SAFETY')).body.data).toHaveLength(0);

    // a receipt makes a notice visible even outside the audience; the ROLES notice never shows
    const flatB = (await Notice.findOne({ where: { societyId: w.sid, title: 'Flat B-101' } }))!;
    await makeReceipt(flatB, w.a1.userId, w.a101);
    expect(titles(await w.a1.c('get', '/me/notices'))).toContain('Flat B-101');
    const roles = (await Notice.findOne({ where: { societyId: w.sid, title: 'Roles only' } }))!;
    await makeReceipt(roles, w.a1.userId, null);
    expect(titles(await w.a1.c('get', '/me/notices'))).not.toContain('Roles only');

    // the tenants-only notice reaches a tenant, not an owner or family member
    expect(titles(await w.fam.c('get', '/me/notices'))).not.toContain('Tenants only');
    expect(titles(await w.a1.c('get', '/me/notices'))).not.toContain('Tenants only');

    // unread filter follows the receipts
    const all = (await Notice.findOne({ where: { societyId: w.sid, title: 'All residents' } }))!;
    await makeReceipt(all, w.a1.userId, w.a101, { firstReadAt: new Date() });
    const unread = await w.a1.c('get', '/me/notices?unread=true');
    expect(titles(unread)).not.toContain('All residents');
    expect(titles(unread)).toContain('Tower A only');
  }, 240_000);

  it('detail records the read once per person, marks the inbox item read, hides invisible notices', async () => {
    const n = await makeNotice(w.sid, { title: 'Water tank cleaning' });
    await InboxItem.create({
      scope: 'SOCIETY',
      societyId: w.sid,
      userId: w.a1.userId,
      batchId: '00000000-0000-4000-8000-000000000002',
      templateKey: 'communication.notice_published',
      category: 'NOTICES',
      deliveryClass: 'STANDARD',
      title: 'Water tank cleaning',
      body: 'x',
      deepLink: `/notices/${n.id}`,
    } as never);
    const r1 = await makeReceipt(n, w.a1.userId, w.a101);
    events.length = 0;
    const d = await w.a1.c('get', `/me/notices/${n.id}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.data).toMatchObject({
      id: n.id,
      title: 'Water tank cleaning',
      body: '<p>Water tank cleaning body text</p>',
      attachments: [],
      utility: null,
      actions: [],
      revisionNo: 1,
    });
    expect(d.body.data.readAt).not.toBeNull();
    const rr = (await NoticeReceipt.findByPk(r1.id))!;
    expect(rr.firstReadAt).not.toBeNull();
    expect(rr.readCount).toBe(1);
    expect((await Notice.findByPk(n.id))!.readCount).toBe(1);
    expect(
      (await InboxItem.findOne({
        where: { userId: w.a1.userId, templateKey: 'communication.notice_published' },
      }))!.readAt,
    ).not.toBeNull();
    expect(events.some(e => e.event === 'notification.read')).toBe(true);
    // a second open counts the person's receipt again but the notice counter once
    await w.a1.c('get', `/me/notices/${n.id}`);
    expect((await NoticeReceipt.findByPk(r1.id))!.readCount).toBe(2);
    expect((await Notice.findByPk(n.id))!.readCount).toBe(1);

    // live match without a receipt creates one (not counted in recipientCount)
    const live = await w.b1.c('get', `/me/notices/${n.id}`);
    expect(live.status).toBe(200);
    const made = (await NoticeReceipt.findOne({ where: { noticeId: n.id, userId: w.b1.userId } }))!;
    expect(made).toMatchObject({ unitId: w.b101, relation: 'OWNER' });
    expect(made.firstReadAt).not.toBeNull();
    expect((await Notice.findByPk(n.id))!.recipientCount).toBe(0);
    expect((await Notice.findByPk(n.id))!.readCount).toBe(2);

    // not visible: another society, draft, recalled, outside the audience, ROLES, unknown id
    const foreign = await makeNotice((await makeSociety('Elsewhere')).id!, { title: 'Foreign' });
    const draft = await makeNotice(w.sid, { status: 'DRAFT', publishedAt: null });
    const recalled = await makeNotice(w.sid, { status: 'RECALLED' });
    const unitB = await makeNotice(w.sid, { audienceType: 'UNITS', audienceIds: [w.b101] });
    const roles = await makeNotice(w.sid, { audienceType: 'ROLES', audienceRoleKeys: ['chairman'] });
    for (const x of [foreign, draft, recalled, unitB, roles]) {
      const r = await w.a1.c('get', `/me/notices/${x.id}`);
      expect([x.id, r.status, r.body.code]).toEqual([x.id, 404, 'NOTICE_NOT_FOUND']);
    }
    expect((await w.a1.c('get', '/me/notices/99999999')).status).toBe(404);
    expect((await w.a1.c('get', '/me/notices/abc')).status).toBe(400);
  }, 240_000);

  it('detail shows utility window and action states (collection open, vote closed)', async () => {
    setCommunicationPorts({
      collections: { get: async (_s, id) => ({ id, status: 'PUBLISHED', title: 'Diwali fund' }) },
      targets: { isOpen: async () => false },
    });
    const n = await makeNotice(w.sid, {
      title: 'Lift shutdown',
      kind: 'UTILITY_SHUTDOWN',
      utilityType: 'LIFT',
      outageStartsAt: new Date('2026-11-05T04:00:00Z'),
      outageEndsAt: new Date('2026-11-05T08:00:00Z'),
      actions: [
        { type: 'PAY_COLLECTION', refId: 5, label: 'Pay Diwali fund' },
        { type: 'VOTE', refId: 9 },
        { type: 'LINK', url: 'https://example.com/x', label: 'More' },
      ],
    });
    const d = (await w.a1.c('get', `/me/notices/${n.id}`)).body.data;
    expect(d.utility).toEqual({
      type: 'LIFT',
      label: 'Lift', // display label of the type
      startsAt: '2026-11-05T04:00:00.000Z',
      endsAt: '2026-11-05T08:00:00.000Z',
      restoredAt: null,
    });
    expect(d.actions.map((a: { type: string; state: string }) => [a.type, a.state])).toEqual([
      ['PAY_COLLECTION', 'OPEN'],
      ['VOTE', 'CLOSED'],
      ['LINK', 'OPEN'],
    ]);
    expect(d.actions[0]).toMatchObject({ refId: 5, label: 'Pay Diwali fund' });
  }, 240_000);
});

describe('T16-2 acknowledge (8.18, BR-16-11)', () => {
  it('acknowledges once for every receipt of the person, immutable, audited once, with errors', async () => {
    const n = await makeNotice(w.sid, { title: 'Fire drill', requiresAck: true, revisionNo: 2 });
    await makeReceipt(n, w.a1.userId, w.a101);
    await makeReceipt(n, w.a1.userId, w.a201);
    await makeReceipt(n, w.fam.userId, w.a101);
    events.length = 0;
    const r = await w.a1.c('post', `/me/notices/${n.id}/acknowledge`, { appVersion: '1.2.3' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ noticeId: n.id, revisionNo: 2 });
    const rows = await NoticeReceipt.findAll({ where: { noticeId: n.id, userId: w.a1.userId } });
    expect(rows).toHaveLength(2);
    for (const x of rows) expect(x).toMatchObject({ ackRevisionNo: 2 });
    expect(rows.every(x => x.acknowledgedAt !== null && x.ackUserAgent)).toBe(true);
    expect((await Notice.findByPk(n.id))!.ackCount).toBe(2);
    expect(events.some(e => e.event === 'notice.updated')).toBe(true);
    // the family member's receipt is untouched
    expect(
      (await NoticeReceipt.findOne({ where: { noticeId: n.id, userId: w.fam.userId } }))!.acknowledgedAt,
    ).toBeNull();
    // the second call returns the existing time and writes nothing
    const again = await w.a1.c('post', `/me/notices/${n.id}/acknowledge`, {});
    expect(again.status).toBe(200);
    expect(again.body.data.acknowledgedAt).toBe(r.body.data.acknowledgedAt);
    expect((await Notice.findByPk(n.id))!.ackCount).toBe(2);
    expect(
      await AuditLog.count({
        where: { action: 'communication.notice.acknowledged', entityId: String(n.id) },
      }),
    ).toBe(1);
    // the list shows it acknowledged
    expect((await w.a1.c('get', '/me/notices')).body.data[0].acknowledgedAt).toBe(r.body.data.acknowledgedAt);

    // live match without receipt: a receipt is created first
    const m = await w.b1.c('post', `/me/notices/${n.id}/acknowledge`, {});
    expect(m.status).toBe(200);
    expect(
      (await NoticeReceipt.findOne({ where: { noticeId: n.id, userId: w.b1.userId } }))!.acknowledgedAt,
    ).not.toBeNull();

    // errors: no ack needed 422, not PUBLISHED 409, not visible 404, unknown body key 400
    const plain = await makeNotice(w.sid, { title: 'No ack here' });
    const e422 = await w.a1.c('post', `/me/notices/${plain.id}/acknowledge`, {});
    expect([e422.status, e422.body.code]).toEqual([422, 'NOTICE_ACK_NOT_REQUIRED']);
    const expired = await makeNotice(w.sid, {
      requiresAck: true,
      status: 'EXPIRED',
      expiredAt: new Date('2026-10-30T00:00:00Z'),
    });
    const e409 = await w.a1.c('post', `/me/notices/${expired.id}/acknowledge`, {});
    expect([e409.status, e409.body.code]).toEqual([409, 'INVALID_STATE']);
    const hidden = await makeNotice(w.sid, {
      requiresAck: true,
      audienceType: 'UNITS',
      audienceIds: [w.b101],
    });
    expect((await w.a1.c('post', `/me/notices/${hidden.id}/acknowledge`, {})).status).toBe(404);
    const draft = await makeNotice(w.sid, { requiresAck: true, status: 'DRAFT', publishedAt: null });
    expect((await w.a1.c('post', `/me/notices/${draft.id}/acknowledge`, {})).status).toBe(404);
    expect((await w.a1.c('post', `/me/notices/${n.id}/acknowledge`, { nope: 1 })).status).toBe(400);
    expect(
      (await w.a1.c('post', `/me/notices/${n.id}/acknowledge`, { appVersion: 'x'.repeat(21) })).status,
    ).toBe(400);
  }, 240_000);
});

describe('T16-2 attachment download (8.17 /me)', () => {
  it('needs a visible notice and a linked, clean file', async () => {
    const n = await makeNotice(w.sid, { title: 'With file', attachmentCount: 1 });
    const hidden = await makeNotice(w.sid, { audienceType: 'UNITS', audienceIds: [w.b101] });
    const file = (id: number, o: Record<string, unknown> = {}) => {
      placeholderFiles.set(id, {
        fileId: id,
        societyId: w.sid,
        purpose: 'NOTICE_ATTACHMENT',
        name: `f${id}.pdf`,
        contentType: 'application/pdf',
        content: Buffer.from('pdf-bytes'),
        ownerUserId: null,
        status: 'CLEAN',
        ...o,
      } as never);
      return id;
    };
    const f = file(9001);
    const stray = file(9002); // exists but is not linked to the notice
    const gone = file(9003, { status: 'DELETED' });
    await sequelizeLink(n.id, [f, gone]);
    await sequelizeLink(hidden.id, [file(9004)]);
    const ok = await w.a1.c('get', `/me/notices/${n.id}/attachments/${f}/download-url`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.url).toContain(`/${f}`);
    const det = (await w.a1.c('get', `/me/notices/${n.id}`)).body.data;
    expect(det.attachments).toEqual([{ fileId: f, name: 'f9001.pdf', sizeBytes: 9 }]);
    const unlinked = await w.a1.c('get', `/me/notices/${n.id}/attachments/${stray}/download-url`);
    expect([unlinked.status, unlinked.body.code]).toEqual([404, 'FILE_NOT_FOUND']);
    expect((await w.a1.c('get', `/me/notices/${n.id}/attachments/${gone}/download-url`)).status).toBe(410);
    // not visible notice: 404 NOTICE_NOT_FOUND even though the file is linked
    const r = await w.a1.c('get', `/me/notices/${hidden.id}/attachments/9004/download-url`);
    expect([r.status, r.body.code]).toEqual([404, 'NOTICE_NOT_FOUND']);
    expect(
      (await w.a1.c('get', `/me/notices/${n.id}/attachments/${f}/download-url?disposition=zip`)).status,
    ).toBe(400);
  }, 240_000);
});

async function sequelizeLink(noticeId: number, fileIds: number[]): Promise<void> {
  await sequelize.transaction(t => communicationPorts().files.link({} as never, fileIds, noticeId, t));
}
