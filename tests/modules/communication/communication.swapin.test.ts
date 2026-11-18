import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { InboxItem, Notification } from '../../../src/models';
import { clearInbox, listInbox } from '../../../src/lib/inbox';
import { hasNotifyEngine, notify as libNotify, setNotifyEngine } from '../../../src/lib/notify';
import { legacyEngine } from '../../../src/modules/communication/communication.core';
import { registerCommunication } from '../../../src/modules/communication/communication.public';
import { app, makeUser, resetAll } from '../../helpers/auth';
import { clearCommunicationRows, resetCommunication } from '../../helpers/communication';

beforeAll(async () => {
  await resetAll();
}, 600_000);
beforeEach(async () => {
  await resetCommunication();
  await clearCommunicationRows();
}, 240_000);

describe('the real engine behind lib/notify (the stand-in swap-in)', () => {
  it('registerCommunication installs the engine', () => {
    setNotifyEngine(undefined);
    expect(hasNotifyEngine()).toBe(false);
    registerCommunication();
    expect(hasNotifyEngine()).toBe(true);
  });
  it('auth.otp: one SMS with the same text as the stand-in, no inbox item, an OTP delivery row (2 attempts)', async () => {
    await libNotify('auth.otp', [{ mobile: '9876500001' }], { code: '123456', purpose: 'login' });
    const sms = (await listInbox()).filter(m => m.channel === 'SMS');
    expect(sms).toHaveLength(1);
    expect(sms[0]!.to).toBe('9876500001');
    expect(sms[0]!.body).toContain('123456');
    expect(sms[0]!.templateKey).toBe('auth.otp');
    const row = (await Notification.findAll())[0]!;
    expect(row).toMatchObject({
      deliveryClass: 'OTP',
      channel: 'SMS',
      status: 'SENT',
      maxAttempts: 2,
      societyId: null,
    });
    expect(await InboxItem.count()).toBe(0);
  });
  it('auth.otp over WhatsApp uses the WhatsApp adapter', async () => {
    await libNotify(
      'auth.otp',
      [{ mobile: '9876500002' }],
      { code: '654321', purpose: 'login' },
      { channel: 'WHATSAPP' },
    );
    const wa = (await listInbox()).filter(m => m.channel === 'WHATSAPP');
    expect(wa).toHaveLength(1);
    expect(wa[0]!.body).toContain('auth.otp');
    expect((await listInbox()).some(m => m.channel === 'SMS')).toBe(false);
  });
  it('a legacy template to a user: e-mail and SMS keep their text, plus an inbox item and the in-app row in the dev inbox', async () => {
    const u = await makeUser({ mobile: '9876500003' });
    await libNotify('auth.account_deleted', [{ userId: u.id }], {});
    const all = await listInbox();
    expect(all.find(m => m.channel === 'SMS')?.body).toBe('Your SocietyApp account was deleted.');
    expect(all.find(m => m.channel === 'EMAIL')?.subject).toBe('Your account was deleted');
    expect(all.find(m => m.channel === 'IN_APP')?.to).toBe(`user:${u.id}`);
    const item = (await InboxItem.findAll({ where: { userId: u.id } }))[0]!;
    expect(item).toMatchObject({ scope: 'USER', deliveryClass: 'SECURITY', tone: 'warn' });
  });
  it('options.channels restricts delivery like the stand-in', async () => {
    const u = await makeUser({ mobile: '9876500004' });
    await libNotify('auth.account_deleted', [{ userId: u.id }], {}, { channels: ['EMAIL'] });
    const all = await listInbox();
    expect(all.some(m => m.channel === 'SMS')).toBe(false);
    expect(all.some(m => m.channel === 'EMAIL')).toBe(true);
  });
  it('an explicit contact beats the user record, a failing send never throws to the caller, an unknown key only logs', async () => {
    await libNotify(
      'auth.account_deleted',
      [{ userId: (await makeUser()).id, mobile: '9000000009', email: 'x@y.in' }],
      {},
    );
    expect((await listInbox()).find(m => m.channel === 'SMS')?.to).toBe('9000000009');
    await expect(libNotify('nope.nothing', [{ mobile: '9876500005' }], {})).resolves.toBeUndefined();
    await expect(libNotify('auth.otp', [], {})).resolves.toBeUndefined();
  });
  it('GET /api/v1/dev/inbox shows SMS, e-mail and in-app rows and can filter by channel', async () => {
    const u = await makeUser({ mobile: '9876500006' });
    await libNotify('auth.account_deleted', [{ userId: u.id }], {});
    const sms = await request(app).get('/api/v1/dev/inbox?channel=sms');
    const inapp = await request(app).get('/api/v1/dev/inbox?channel=in_app');
    const to = await request(app).get(`/api/v1/dev/inbox?to=user:${u.id}`);
    expect(sms.body.data).toHaveLength(1);
    expect(inapp.body.data).toHaveLength(1);
    expect(to.body.data.map((m: { channel: string }) => m.channel)).toEqual(['IN_APP']);
    await clearInbox();
  });
  it('without the engine the original stand-in still works (unit tests of other modules)', async () => {
    setNotifyEngine(undefined);
    await libNotify('auth.otp', [{ mobile: '9876500007' }], { code: '111222', purpose: 'login' });
    expect((await listInbox()).filter(m => m.channel === 'SMS')).toHaveLength(1);
    expect(await Notification.count()).toBe(0);
    setNotifyEngine(legacyEngine);
  });
});
