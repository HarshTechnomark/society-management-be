import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, InboxItem, Society, closeDb } from '../../../src/models';
import { residentsWorld } from '../../helpers/communication';
import { events } from '../../helpers/auth';
import { lifecycleColumns, makeSociety, platformLogin, platformUser, as } from '../../helpers/access';
import { invalidateSociety } from '../../../src/modules/access-control/access-control.public';
import { notify } from '../../../src/modules/communication/communication.core';
import { NOTIFY } from '../../../src/modules/communication/communication.constants';

afterAll(async () => {
  await closeDb();
});
let w: Awaited<ReturnType<typeof residentsWorld>>;
beforeEach(async () => {
  w = await residentsWorld();
});

const item = (userId: number, o: Record<string, unknown> = {}) =>
  InboxItem.create({
    scope: 'SOCIETY',
    societyId: w.sid,
    userId,
    batchId: '00000000-0000-4000-8000-000000000001',
    templateKey: 'approvals.pending',
    category: 'APPROVALS',
    deliveryClass: 'TRANSACTIONAL',
    tone: 'warn',
    title: 'Approval needed',
    body: 'Something to approve',
    deepLink: '/approvals/77',
    ...o,
  } as never);

describe('T16-2 notification bell (8.20, 8.21)', () => {
  it('lists own items by scope, counts unread, marks read, read-all by category, tenant isolation', async () => {
    await InboxItem.destroy({ where: {} }); // the world's own sign-up messages
    const mine1 = await item(w.a1.userId);
    const mine2 = await item(w.a1.userId, {
      category: 'PAYMENTS',
      templateKey: 'payments.receipt',
      title: 'Receipt',
    });
    await item(w.a1.userId, {
      scope: 'USER',
      societyId: null,
      templateKey: 'auth.login',
      category: 'ACCOUNT',
    });
    await item(w.a1.userId, { scope: 'PLATFORM', societyId: null, templateKey: 'x.y' }); // never in the society bell
    await item(w.a1.userId, { societyId: (await makeSociety('Elsewhere')).id! }); // an item of another society is hidden
    await item(w.b1.userId); // someone else's
    const read = await w.a1.c('get', '/notifications');
    expect(read.status).toBe(200);
    expect(read.body.data).toHaveLength(3);
    expect(read.body.unreadCount).toBe(3);
    expect(read.body.pagination).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(read.body.data[0]).toEqual(
      expect.objectContaining({
        templateKey: expect.any(String),
        tone: expect.stringMatching(/info|ok|warn|bad/),
        readAt: null,
      }),
    );
    expect((await w.a1.c('get', '/notifications/unread-count')).body.data).toEqual({ count: 3 });
    expect((await w.a1.c('get', '/notifications?category=PAYMENTS')).body.data).toHaveLength(1);

    // validation: strict keys, limit cap
    expect((await w.a1.c('get', '/notifications?limit=51')).status).toBe(400);
    expect((await w.a1.c('get', '/notifications?foo=1')).status).toBe(400);

    // another user's item is a 404, not a 403
    const others = await InboxItem.findOne({ where: { userId: w.b1.userId } });
    expect((await w.a1.c('post', `/notifications/${others!.id}/read`, {})).body.code).toBe(
      'NOTIFICATION_NOT_FOUND',
    );

    events.length = 0;
    const one = await w.a1.c('post', `/notifications/${mine1.id}/read`, {});
    expect(one.status).toBe(200);
    expect(events.some(e => e.event === 'notification.read')).toBe(true);
    expect((await w.a1.c('get', '/notifications/unread-count')).body.data.count).toBe(2);
    expect((await w.a1.c('get', '/notifications?unread=true')).body.data).toHaveLength(2);
    // reading twice keeps the first time
    const first = (await InboxItem.findByPk(mine1.id))!.readAt;
    await w.a1.c('post', `/notifications/${mine1.id}/read`, {});
    expect((await InboxItem.findByPk(mine1.id))!.readAt!.getTime()).toBe(first!.getTime());

    expect((await w.a1.c('post', '/notifications/read-all', { category: 'PAYMENTS' })).body.data).toEqual({
      updated: 1,
    });
    expect((await w.a1.c('post', '/notifications/read-all', {})).body.data).toEqual({ updated: 1 });
    expect((await w.a1.c('post', '/notifications/read-all', {})).body.data).toEqual({ updated: 0 });
    expect((await w.a1.c('get', '/notifications/unread-count')).body.data.count).toBe(0);
    expect(mine2.id).toBeGreaterThan(0);
    // the other user is untouched and no audit row was written for read state
    expect((await w.b1.c('get', '/notifications/unread-count')).body.data.count).toBe(1);
    expect(await AuditLog.count({ where: { entityType: 'inbox_item' } })).toBe(0);
  }, 180_000);

  it('real notify() items reach the bell with their deep link; the bell works while the society is SUSPENDED', async () => {
    await notify(NOTIFY.pushTest, [{ userId: w.a1.userId }], {}, { channels: ['IN_APP'] });
    const l = await w.a1.c('get', '/notifications');
    expect(l.body.data.some((x: { templateKey: string }) => x.templateKey === NOTIFY.pushTest)).toBe(true);
    await Society.update(lifecycleColumns('SUSPENDED') as never, { where: { id: w.sid } });
    await invalidateSociety(w.sid);
    const id = l.body.data[0].id;
    const r = await w.a1.c('post', `/notifications/${id}/read`, {});
    expect(r.status).toBe(200);
    expect((await w.a1.c('post', '/notifications/read-all', {})).status).toBe(200);
  }, 180_000);
});

describe('T16-2 platform bell (8.22)', () => {
  it('shows PLATFORM and USER items of a platform user; a society user is refused', async () => {
    const pu = await platformUser('super_admin');
    const pc = as(await platformLogin(pu), 'PLATFORM');
    await item(pu.id, {
      scope: 'PLATFORM',
      societyId: null,
      templateKey: 'platform.alert',
      category: 'SYSTEM',
    });
    await item(pu.id, { scope: 'USER', societyId: null, templateKey: 'auth.login', category: 'ACCOUNT' });
    await item(pu.id, { scope: 'SOCIETY', societyId: w.sid }); // not on the platform bell
    const l = await pc('get', '/platform/notifications');
    expect(l.status, JSON.stringify(l.body)).toBe(200);
    expect(l.body.data).toHaveLength(2);
    expect(l.body.unreadCount).toBe(2);
    expect((await pc('get', '/platform/notifications/unread-count')).body.data).toEqual({ count: 2 });
    const first = l.body.data[0].id;
    expect((await pc('post', `/platform/notifications/${first}/read`, {})).status).toBe(200);
    expect((await pc('post', '/platform/notifications/read-all', {})).body.data).toEqual({ updated: 1 });
    // a resident is not a platform user
    const denied = await w.a1.c('get', '/platform/notifications', undefined, { app: 'PLATFORM' });
    expect([401, 403]).toContain(denied.status);
  }, 180_000);
});
