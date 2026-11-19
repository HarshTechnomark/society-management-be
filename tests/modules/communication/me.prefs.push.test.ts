import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, InboxItem, NotificationPreference, PushSubscription, closeDb } from '../../../src/models';
import { residentsWorld, subscribePush } from '../../helpers/communication';
import { call } from '../../helpers/auth';
import { decrypt } from '../../../src/modules/communication/communication.crypto';
import {
  communicationPortCalls,
  setCommunicationPorts,
} from '../../../src/modules/communication/communication.ports';
import { listInbox } from '../../../src/lib/inbox';
import { communicationHooks } from '../../../src/modules/communication/communication.public';
import { isChannelOn } from '../../../src/modules/communication/communication.prefs';
import { sequelize } from '../../../src/models';

afterAll(async () => {
  await closeDb();
});
let w: Awaited<ReturnType<typeof residentsWorld>>;
beforeEach(async () => {
  w = await residentsWorld();
});

const P256 = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);
const body = (n: number, o: Record<string, unknown> = {}) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/tok-${n}`,
  keys: { p256dh: P256, auth: AUTH },
  app: 'RESIDENT',
  ...o,
});

describe('T16-2 preferences (8.23)', () => {
  it('GET creates defaults; PUT validates, versions, audits and drives channel routing', async () => {
    const g = await w.a1.c('get', '/me/notification-preferences');
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const d = g.body.data;
    expect(d).toMatchObject({
      locale: null,
      quietHours: { mode: 'SOCIETY_DEFAULT', start: '22:00', end: '07:00' },
      whatsapp: { optIn: false, optInAt: null },
      version: 1,
    });
    expect(
      d.categories.filter((c: { locked: boolean }) => c.locked).map((c: { key: string }) => c.key),
    ).toEqual(['EMERGENCY', 'SECURITY']);
    expect(d.categories.find((c: { key: string }) => c.key === 'PAYMENTS').channels).toEqual({
      PUSH: true,
      SMS: true,
      WHATSAPP: true,
      EMAIL: true,
    });
    expect(await NotificationPreference.count({ where: { userId: w.a1.userId } })).toBe(1);
    await w.a1.c('get', '/me/notification-preferences');
    expect(await NotificationPreference.count({ where: { userId: w.a1.userId } })).toBe(1);

    const put = (o: Record<string, unknown>) =>
      w.a1.c('put', '/me/notification-preferences', {
        version: 1,
        locale: 'hi-IN',
        categories: { PAYMENTS: { PUSH: true, SMS: false, WHATSAPP: false, EMAIL: true } },
        quietHours: { mode: 'CUSTOM', start: '23:00', end: '06:30' },
        whatsappOptIn: true,
        ...o,
      });
    const ok = await put({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      locale: 'hi-IN',
      effectiveLocale: 'hi-IN',
      quietHours: { mode: 'CUSTOM', start: '23:00', end: '06:30' },
      whatsapp: { optIn: true },
      version: 2,
    });
    expect(ok.body.data.whatsapp.optInAt).not.toBeNull();
    const row = (await NotificationPreference.findOne({ where: { userId: w.a1.userId } }))!;
    expect(row).toMatchObject({
      whatsappOptInSource: 'APP',
      whatsappOptOutAt: null,
      quietHoursMode: 'CUSTOM',
    });
    expect(isChannelOn(row.channelMatrix, 'PAYMENTS', 'SMS')).toBe(false);
    expect(isChannelOn(row.channelMatrix, 'PAYMENTS', 'PUSH')).toBe(true);
    expect(isChannelOn(row.channelMatrix, 'EMERGENCY', 'SMS')).toBe(true);
    expect(
      await AuditLog.count({
        where: { action: 'communication.preferences.updated', actorUserId: w.a1.userId },
      }),
    ).toBe(1);
    expect(
      (await AuditLog.findOne({ where: { action: 'communication.preferences.updated' } }))!.societyId,
    ).toBeNull();

    // stale version, locked, unknown category, quiet hours, shape
    const stale = await put({ version: 1 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const locked = await put({
      version: 2,
      categories: { EMERGENCY: { PUSH: false, SMS: false, WHATSAPP: false, EMAIL: false } },
    });
    expect([locked.status, locked.body.code]).toEqual([422, 'PREFERENCE_LOCKED']);
    expect(
      (
        await put({
          version: 2,
          // a locked row sent back all on is ignored (the screen shows it so); switching any channel off is refused
          categories: { SECURITY: { PUSH: true, SMS: false, WHATSAPP: true, EMAIL: true } },
        })
      ).body.code,
    ).toBe('PREFERENCE_LOCKED');
    expect(
      (
        await put({
          version: 2,
          categories: { NOPE: { PUSH: true, SMS: true, WHATSAPP: true, EMAIL: true } },
        })
      ).status,
    ).toBe(400);
    expect((await put({ version: 2, categories: { PAYMENTS: { PUSH: true } } })).status).toBe(400);
    const same = await put({ version: 2, quietHours: { mode: 'CUSTOM', start: '22:00', end: '22:00' } });
    expect([same.status, same.body.code]).toEqual([422, 'QUIET_HOURS_INVALID']);
    expect((await put({ version: 2, quietHours: { mode: 'CUSTOM' } })).body.code).toBe('QUIET_HOURS_INVALID');
    expect(
      (await put({ version: 2, quietHours: { mode: 'CUSTOM', start: '25:00', end: '06:00' } })).status,
    ).toBe(400);
    expect((await put({ version: 2, locale: 'xx-YY' })).status).toBe(400);
    expect((await put({ version: 2, extra: 1 })).status).toBe(400);
    // quiet hours OFF clears the times; opting out of WhatsApp records the time
    const off = await put({ version: 2, quietHours: { mode: 'OFF' }, whatsappOptIn: false, locale: null });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const r2 = (await NotificationPreference.findOne({ where: { userId: w.a1.userId } }))!;
    expect(r2).toMatchObject({ quietHoursStart: null, quietHoursEnd: null, whatsappOptIn: false });
    expect(r2.whatsappOptOutAt).not.toBeNull();
    expect(await AuditLog.count({ where: { action: 'communication.whatsapp.opted_out' } })).toBe(1);
    // preferences are per user
    expect((await w.b1.c('get', '/me/notification-preferences')).body.data.version).toBe(1);
    // unauthenticated
    expect((await call('get', '/me/notification-preferences', undefined, { app: 'RESIDENT' })).status).toBe(
      401,
    );
  }, 240_000);
});

describe('T16-2 push subscriptions (8.24, BR-16-35, BR-16-36)', () => {
  it('registers, upserts, caps at 10, revokes, tests and lists; validates; hooks revoke', async () => {
    // public key
    const pk = await call('get', '/public/push/vapid-public-key', undefined, { app: 'RESIDENT' });
    expect(pk.status).toBe(200);
    expect(pk.body.data.publicKey).toBeTruthy();
    setCommunicationPorts({ push: { publicKey: () => null } });
    const nk = await call('get', '/public/push/vapid-public-key', undefined, { app: 'RESIDENT' });
    expect([nk.status, nk.body.code]).toEqual([503, 'PUSH_NOT_CONFIGURED']);
    expect((await w.a1.c('post', '/me/push-subscriptions', body(0))).body.code).toBe('PUSH_NOT_CONFIGURED');
    setCommunicationPorts();

    // register
    const c1 = await w.a1.c('post', '/me/push-subscriptions', body(1));
    expect(c1.status, JSON.stringify(c1.body)).toBe(201);
    expect(c1.body.data).toMatchObject({ status: 'ACTIVE' });
    const row = (await PushSubscription.findByPk(c1.body.data.id))!;
    expect(row).toMatchObject({
      userId: w.a1.userId,
      app: 'RESIDENT',
      status: 'ACTIVE',
      deviceLabel: 'Chrome on Android',
    });
    expect(row.sessionId).not.toBeNull();
    expect(decrypt(row.authSecretEnc)).toBe(AUTH);
    expect(row.endpointHash).toHaveLength(64);
    expect(await AuditLog.count({ where: { action: 'communication.push_subscription.created' } })).toBe(1);
    const list = await w.a1.c('get', '/me/push-subscriptions');
    expect(list.body.data).toEqual([
      expect.objectContaining({
        id: c1.body.data.id,
        app: 'RESIDENT',
        status: 'ACTIVE',
        isThisDevice: true,
        lastSuccessAt: null,
      }),
    ]);

    // same endpoint again updates the same row; another user taking it moves it
    const again = await w.a1.c('post', '/me/push-subscriptions', body(1));
    expect(again.body.data.id).toBe(c1.body.data.id);
    expect(await PushSubscription.count()).toBe(1);
    const moved = await w.b1.c('post', '/me/push-subscriptions', body(1));
    expect(moved.body.data.id).toBe(c1.body.data.id);
    expect((await PushSubscription.findByPk(c1.body.data.id))!.userId).toBe(w.b1.userId);
    expect((await w.a1.c('get', '/me/push-subscriptions')).body.data).toEqual([]);

    // validation
    const bad = async (o: Record<string, unknown>, status: number, code?: string) => {
      const r = await w.a1.c('post', '/me/push-subscriptions', body(2, o));
      expect([r.status, ...(code ? [r.body.code] : [])]).toEqual([status, ...(code ? [code] : [])]);
    };
    await bad({ endpoint: 'https://evil.example.com/push/1' }, 422, 'PUSH_ENDPOINT_NOT_ALLOWED');
    await bad({ endpoint: 'http://fcm.googleapis.com/x' }, 400);
    await bad({ app: 'ADMIN' }, 400);
    await bad({ app: 'NOPE' }, 400);
    await bad({ keys: { p256dh: 'short', auth: AUTH } }, 400);
    await bad({ keys: { p256dh: P256, auth: 'a'.repeat(30) } }, 400);
    await bad({ expirationTime: Date.UTC(2026, 9, 1) }, 400);
    await bad({ extra: 1 }, 400);
    expect(
      (await w.a1.c('post', '/me/push-subscriptions', body(3, { expirationTime: Date.UTC(2026, 11, 1) })))
        .status,
    ).toBe(201);
    expect(
      (await PushSubscription.findOne({ where: { userId: w.a1.userId } }))!.expirationTime,
    ).not.toBeNull();

    // BR-16-35: the 11th revokes the oldest by lastSuccessAt / createdAt
    await PushSubscription.destroy({ where: { userId: w.a1.userId } });
    const made: PushSubscription[] = [];
    for (let i = 0; i < 10; i += 1) {
      const s = await subscribePush(w.a1.userId);
      // raw SQL: Sequelize never writes createdAt on update
      await sequelize.query('UPDATE push_subscriptions SET createdAt = :at WHERE id = :id', {
        replacements: { at: new Date(Date.UTC(2026, 0, 1 + i)), id: s.id },
      });
      made.push(s);
    }
    await made[0]!.update({ lastSuccessAt: new Date(2026, 5, 1) } as never); // recently used: not the oldest
    const eleven = await w.a1.c('post', '/me/push-subscriptions', body(11));
    expect(eleven.status).toBe(201);
    expect(await PushSubscription.count({ where: { userId: w.a1.userId, status: 'ACTIVE' } })).toBe(10);
    const gone = (await PushSubscription.findByPk(made[1]!.id))!;
    expect(gone).toMatchObject({ status: 'REVOKED', revokedReason: 'LIMIT' });
    expect((await PushSubscription.findByPk(made[0]!.id))!.status).toBe('ACTIVE');

    // delete: other's id is 404, own is 204 and audited, again is still 204
    const other = await subscribePush(w.b1.userId);
    expect((await w.a1.c('delete', `/me/push-subscriptions/${other.id}`)).body.code).toBe(
      'PUSH_SUBSCRIPTION_NOT_FOUND',
    );
    const del = await w.a1.c('delete', `/me/push-subscriptions/${made[2]!.id}`);
    expect(del.status).toBe(204);
    expect(await PushSubscription.findByPk(made[2]!.id)).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'USER',
    });
    expect(await AuditLog.count({ where: { action: 'communication.push_subscription.revoked' } })).toBe(1);
    expect((await w.a1.c('delete', `/me/push-subscriptions/${made[2]!.id}`)).status).toBe(204);
    expect(await AuditLog.count({ where: { action: 'communication.push_subscription.revoked' } })).toBe(1);
    expect((await w.a1.c('delete', '/me/push-subscriptions/abc')).status).toBe(400);
  }, 240_000);

  it('test push goes only to that browser; revoked is 409; others 404; limited to 5 per hour', async () => {
    const mine = await subscribePush(w.a1.userId);
    const second = await subscribePush(w.a1.userId);
    const revoked = await subscribePush(w.a1.userId);
    await revoked.update({ status: 'REVOKED', revokedReason: 'USER' } as never);
    const theirs = await subscribePush(w.b1.userId);
    communicationPortCalls.length = 0;
    const r = await w.a1.c('post', `/me/push-subscriptions/${mine.id}/test`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const sent = communicationPortCalls.filter(c => c.fn === 'push.send');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.input as { target: number }).target).toBe(mine.id);
    expect((await listInbox()).some(m => m.channel === 'PUSH' && m.to === `user:${w.a1.userId}`)).toBe(true);
    const nope = await w.a1.c('post', `/me/push-subscriptions/${theirs.id}/test`, {});
    expect([nope.status, nope.body.code]).toEqual([404, 'PUSH_SUBSCRIPTION_NOT_FOUND']);
    const rev = await w.a1.c('post', `/me/push-subscriptions/${revoked.id}/test`, {});
    expect([rev.status, rev.body.code]).toEqual([409, 'INVALID_STATE']);
    for (let i = 0; i < 2; i += 1)
      expect((await w.a1.c('post', `/me/push-subscriptions/${second.id}/test`, {})).status).toBe(200);
    expect((await w.a1.c('post', `/me/push-subscriptions/${mine.id}/test`, {})).status).toBe(429);
    expect(InboxItem).toBeTruthy();
  }, 240_000);

  it('module 02 hooks: a revoked session revokes its subscriptions (LOGOUT); anonymising clears everything', async () => {
    const a = await subscribePush(w.a1.userId);
    const b = await subscribePush(w.a1.userId);
    await a.update({ sessionId: 5_000_001 } as never).catch(() => undefined);
    const real = (await PushSubscription.findByPk(b.id))!;
    await real.update({ sessionId: null } as never);
    // use the session that registered one through the API
    const reg = await w.a1.c('post', '/me/push-subscriptions', body(77));
    const sub = (await PushSubscription.findByPk(reg.body.data.id))!;
    await communicationHooks.onSessionRevoked(sub.sessionId!);
    expect(await PushSubscription.findByPk(sub.id)).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'LOGOUT',
    });
    expect((await PushSubscription.findByPk(b.id))!.status).toBe('ACTIVE');
    await InboxItem.create({
      scope: 'USER',
      userId: w.a1.userId,
      batchId: '00000000-0000-4000-8000-000000000009',
      templateKey: 'x.y',
      category: 'ACCOUNT',
      deliveryClass: 'TRANSACTIONAL',
      title: 't',
      body: 'b',
    } as never);
    await sequelize.transaction(t => communicationHooks.onUserAnonymised(w.a1.userId, t));
    expect(await PushSubscription.count({ where: { userId: w.a1.userId, status: 'ACTIVE' } })).toBe(0);
    expect(await InboxItem.count({ where: { userId: w.a1.userId } })).toBe(0);
    expect(await NotificationPreference.count({ where: { userId: w.a1.userId } })).toBe(0);
    expect((await PushSubscription.findByPk(b.id))!.revokedReason).toBe('USER_DELETED');
  }, 240_000);
});
