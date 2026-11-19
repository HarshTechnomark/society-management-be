import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxItem, Notification } from '../../../src/models';
import { setAdapters } from '../../../src/adapters';
import { FakeEmailSender } from '../../../src/adapters/email/email';
import { FakeWhatsAppSender } from '../../../src/adapters/whatsapp/whatsapp';
import { listInbox } from '../../../src/lib/inbox';
import { advance, nowMs, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { AppError } from '../../../src/utils/errors';
import { NOTIFY } from '../../../src/modules/communication/communication.constants';
import { decrypt } from '../../../src/modules/communication/communication.crypto';
import { notify, setDeliveryMode } from '../../../src/modules/communication/communication.core';
import { deliverNotification, repairStuck } from '../../../src/modules/communication/communication.deliver';
import { markRead, unreadCount } from '../../../src/modules/communication/communication.inbox';
import { registerCommunicationJobs } from '../../../src/modules/communication/communication.jobs';
import { setCommunicationPorts } from '../../../src/modules/communication/communication.ports';
import { entitlements } from '../../../src/modules/subscriptions/subscriptions.public';
import { events, makeUser, resetAll } from '../../helpers/auth';
import { resetSetup, setupSociety } from '../../helpers/society-setup';
import { subSociety } from '../../helpers/subscriptions';
import {
  clearCommunicationRows,
  deliveries,
  inboxItems,
  resetCommunication,
  setPrefs,
  setSocietyStatus,
  subscribePush,
} from '../../helpers/communication';

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as AppError).code;
  }
};
const IST = (hhmm: string, day = '2026-11-01') => new Date(`${day}T${hhmm}:00+05:30`);

let main: Awaited<ReturnType<typeof setupSociety>>;
let std: { id?: number };
let strt: { id?: number };
// the full reset and the societies are built once (each takes tens of seconds on a busy database); every test clears module 16 rows
beforeAll(async () => {
  await resetAll();
  await resetSetup();
  await resetCommunication();
  main = await setupSociety();
  std = main.society;
  strt = (await subSociety({ plan: 'STARTER', flats: 0 })).society;
}, 600_000);
beforeEach(async () => {
  await resetCommunication();
  await clearCommunicationRows();
  events.length = 0;
  for (const s of [std, strt]) await setSocietyStatus(s.id!, 'ACTIVE');
}, 240_000);

describe('notify(): programmer errors (8.38)', () => {
  it('throws for unknown keys, missing data, society, channels and recipients', async () => {
    const u = await makeUser();
    expect(await codeOf(notify('nope.nothing', [u.id], {}))).toBe('TEMPLATE_NOT_FOUND');
    expect(await codeOf(notify(NOTIFY.pushTest, [u.id], { extra: 1 }))).toBeNull();
    expect(
      await codeOf(notify(NOTIFY.noticePublished, [u.id], { noticeId: 1, link: '/x' }, { societyId: 1 })),
    ).toBe('TEMPLATE_VARIABLE_MISSING');
    expect(
      await codeOf(notify(NOTIFY.noticePublished, [u.id], { noticeId: 'x', title: 't' }, { societyId: 1 })),
    ).toBe('TEMPLATE_VARIABLE_INVALID');
    expect(await codeOf(notify(NOTIFY.noticePublished, [u.id], { noticeId: 1, title: 't' }))).toBe(
      'NOTIFY_SOCIETY_REQUIRED',
    );
    expect(
      await codeOf(
        notify(
          NOTIFY.noticeRecalled,
          [u.id],
          { noticeId: 1, title: 't' },
          { societyId: 1, channels: ['SMS'] },
        ),
      ),
    ).toBe('NOTIFY_CHANNEL_NOT_ALLOWED');
    expect(await codeOf(notify(NOTIFY.pushTest, [], {}))).toBe('NOTIFY_RECIPIENTS_INVALID');
    expect(await codeOf(notify(NOTIFY.pushTest, [{ mobile: '12345' }], {}))).toBe(
      'NOTIFY_RECIPIENTS_INVALID',
    );
    expect(await codeOf(notify(NOTIFY.pushTest, [{ email: 'bad' }], {}))).toBe('NOTIFY_RECIPIENTS_INVALID');
  });
});

describe('notify(): inbox, push delivery, realtime and unread count', () => {
  it('creates the inbox item, a SKIPPED push row without a subscription and the realtime event', async () => {
    const u = await makeUser();
    const r = await notify(NOTIFY.pushTest, [u.id], {});
    expect(r).toMatchObject({ accepted: 1, queued: false, suppressed: false });
    const items = await inboxItems(u.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      scope: 'USER',
      societyId: null,
      tone: 'info',
      templateKey: NOTIFY.pushTest,
      readAt: null,
    });
    expect(items[0]!.title).toBe('Test notification');
    const rows = await deliveries({ userId: u.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'PUSH',
      status: 'SKIPPED',
      skipReason: 'NO_SUBSCRIPTION',
      dataEnc: null,
    });
    const ev = events.find(e => e.event === 'notification.created');
    expect(ev?.room).toBe(`user:${u.id}`);
    expect(ev?.payload).toMatchObject({ title: 'Test notification', unreadCount: 1, tone: 'info' });
    expect(await unreadCount(u.id)).toBe(1);
    const inbox = await listInbox();
    expect(inbox.find(m => m.channel === 'IN_APP' && m.to === `user:${u.id}`)?.subject).toBe(
      'Test notification',
    );
  });
  it('sends push to an active subscription, marks SENT and shows it in the dev inbox', async () => {
    const u = await makeUser();
    const sub = await subscribePush(u.id);
    await notify(NOTIFY.pushTest, [u.id], {}, { pushSubscriptionId: sub.id });
    const [row] = await deliveries({ userId: u.id });
    expect(row).toMatchObject({ channel: 'PUSH', status: 'SENT', attempts: 1, providerKey: 'fake' });
    expect(row!.providerMessageId).toMatch(/^fake-push-/);
    expect((await listInbox()).some(m => m.channel === 'PUSH' && m.to === `user:${u.id}`)).toBe(true);
    expect((await sub.reload()).lastSuccessAt).not.toBeNull();
  });
  it('markRead lowers the unread count and emits notification.read', async () => {
    const u = await makeUser();
    await notify(NOTIFY.pushTest, [u.id], {}, { dedupeKey: 'a' });
    await notify(NOTIFY.pushTest, [u.id], {}, { dedupeKey: 'b' });
    expect(await unreadCount(u.id)).toBe(2);
    const [first] = await inboxItems(u.id);
    await markRead(u.id, first!.id);
    expect(await unreadCount(u.id)).toBe(1);
    expect(events.filter(e => e.event === 'notification.read').pop()?.payload).toMatchObject({
      unreadCount: 1,
    });
    await markRead(u.id, 'all');
    expect(await unreadCount(u.id)).toBe(0);
  });
});

describe('notify(): dedupe (BR-16-25)', () => {
  it('writes an inbox item and a delivery row once per dedupe key, and again for a new key', async () => {
    const u = await makeUser();
    await subscribePush(u.id);
    for (const key of ['d1', 'd1', 'd2']) await notify(NOTIFY.pushTest, [u.id], {}, { dedupeKey: key });
    expect(await inboxItems(u.id)).toHaveLength(2);
    expect(await deliveries({ userId: u.id })).toHaveLength(2);
    await notify(NOTIFY.pushTest, [u.id], {});
    await notify(NOTIFY.pushTest, [u.id], {}); // no key: never deduplicated
    expect(await inboxItems(u.id)).toHaveLength(4);
  });
  it('the same caller key on two templates does not collide', async () => {
    const u = await makeUser();
    await notify(NOTIFY.pushTest, [u.id], {}, { dedupeKey: 'x' });
    await notify(NOTIFY.residentExportFailed, [u.id], {}, { dedupeKey: 'x' });
    expect(await inboxItems(u.id)).toHaveLength(2);
  });
});

describe('notify(): preferences (BR-16-21, BR-16-33)', () => {
  it('skips a switched-off optional channel but never the inbox', async () => {
    const u = await makeUser();
    await subscribePush(u.id);
    await setPrefs(u.id, { channelMatrix: { ACCOUNT: { PUSH: false } } });
    await notify(NOTIFY.pushTest, [u.id], {});
    expect((await deliveries({ userId: u.id }))[0]).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'PREFERENCE_OFF',
    });
    expect(await inboxItems(u.id)).toHaveLength(1);
  });
});

describe('notify(): society state (BR-16-20)', () => {
  it('suppresses STANDARD for SUSPENDED, TRANSACTIONAL goes, CLOSED sends only sendWhenClosed', async () => {
    const society = std;
    const u = await makeUser();
    const o = { societyId: society.id! };
    await setSocietyStatus(society.id!, 'SUSPENDED');
    const standard = await notify(NOTIFY.noticeAckReminder, [u.id], { noticeId: 1, title: 't' }, o);
    expect(standard).toMatchObject({ suppressed: true, accepted: 0 });
    expect(await inboxItems(u.id)).toHaveLength(0);
    const trx = await notify(
      NOTIFY.utilityRestored,
      [u.id],
      { noticeId: 1, title: 't', utilityType: 'WATER' },
      o,
    );
    expect(trx.suppressed).toBe(false);
    const sos = await notify(
      NOTIFY.emergencyAlert,
      [u.id],
      { broadcastId: 1, title: 'Fire', message: 'm', link: '/e' },
      o,
    );
    expect(sos.suppressed).toBe(false);
    await setSocietyStatus(society.id!, 'CLOSED');
    expect(
      (await notify(NOTIFY.utilityRestored, [u.id], { noticeId: 1, title: 't', utilityType: 'WATER' }, o))
        .suppressed,
    ).toBe(true);
    expect(
      (
        await notify(
          NOTIFY.emergencyAlert,
          [u.id],
          { broadcastId: 1, title: 'Fire', message: 'm', link: '/e' },
          o,
        )
      ).suppressed,
    ).toBe(true);
  });
});

describe('notify(): quiet hours (BR-16-22)', () => {
  const data = { noticeId: 7, title: 'Tank cleaning', link: 'https://x.in/n/7' };
  it('defers STANDARD push inside the society window until it ends, then repair delivers it', async () => {
    const society = std;
    const u = await makeUser();
    await subscribePush(u.id);
    setNow(IST('23:00'));
    await notify(NOTIFY.noticePublished, [u.id], data, { societyId: society.id });
    const [row] = await deliveries({ userId: u.id });
    expect(row).toMatchObject({ channel: 'PUSH', status: 'DEFERRED' });
    expect(row!.nextAttemptAt!.toISOString()).toBe(IST('07:00', '2026-11-02').toISOString());
    expect(await inboxItems(u.id)).toHaveLength(1); // in-app is never deferred
    expect(await deliverNotification(row!.id)).toBe('NOT_DUE');
    setNow(IST('07:01', '2026-11-02'));
    await repairStuck();
    expect((await row!.reload()).status).toBe('SENT');
  });
  it('urgent skips quiet hours; the user window OFF disables them; SAFETY ignores them', async () => {
    const society = std;
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    for (const x of [a, b, c]) await subscribePush(x.id);
    await setPrefs(b.id, { quietHoursMode: 'OFF' });
    setNow(IST('23:30'));
    await notify(NOTIFY.noticePublished, [a.id], data, { societyId: society.id, urgent: true });
    await notify(NOTIFY.noticePublished, [b.id], data, { societyId: society.id });
    await notify(
      NOTIFY.emergencyAlert,
      [c.id],
      { broadcastId: 1, title: 'Fire', message: 'm', link: '/e' },
      { societyId: society.id },
    );
    expect((await deliveries({ userId: a.id }))[0]!.status).toBe('SENT');
    expect((await deliveries({ userId: b.id }))[0]!.status).toBe('SENT');
    const sos = await deliveries({ userId: c.id });
    expect(sos.every(r => r.status === 'SENT' || r.status === 'SKIPPED')).toBe(true);
    expect(sos.find(r => r.channel === 'PUSH')!.status).toBe('SENT');
  });
  it("uses the user's CUSTOM window", async () => {
    const society = std;
    const u = await makeUser();
    await subscribePush(u.id);
    await setPrefs(u.id, {
      quietHoursMode: 'CUSTOM',
      quietHoursStart: '13:00:00',
      quietHoursEnd: '15:00:00',
    });
    setNow(IST('14:00'));
    await notify(NOTIFY.noticePublished, [u.id], data, { societyId: society.id });
    expect((await deliveries({ userId: u.id }))[0]!.status).toBe('DEFERRED');
  });
});

describe('notify(): external channels, contacts and WhatsApp (BR-16-21)', () => {
  const alert = { broadcastId: 1, title: 'Fire', message: 'Evacuate', link: 'https://x.in/e/1' };
  it('SAFETY goes to SMS for a user with a mobile; WhatsApp without opt-in is skipped (SMS already in the set)', async () => {
    const society = std;
    const u = await makeUser({ mobile: '9876543210' });
    await notify(NOTIFY.emergencyAlert, [u.id], alert, { societyId: society.id });
    const rows = await deliveries({ userId: u.id });
    expect(rows.map(r => [r.channel, r.status, r.skipReason])).toEqual([
      ['PUSH', 'SKIPPED', 'NO_SUBSCRIPTION'],
      ['SMS', 'SENT', null],
      ['WHATSAPP', 'SKIPPED', 'NOT_OPTED_IN'],
    ]);
    const sms = (await listInbox()).find(m => m.channel === 'SMS')!;
    expect(sms.to).toBe('9876543210');
    expect(sms.body).toContain('ALERT: Fire');
    const tone = (await inboxItems(u.id))[0]!.tone;
    expect(tone).toBe('bad');
  });
  it('WhatsApp goes out for an opted-in user when the plan has the feature (STANDARD) and is skipped FEATURE_OFF on STARTER', async () => {
    const u = await makeUser({ mobile: '9876543211' });
    await setPrefs(u.id, { whatsappOptIn: true });
    await notify(NOTIFY.emergencyAlert, [u.id], alert, { societyId: std.id });
    expect((await deliveries({ userId: u.id, channel: 'WHATSAPP' }))[0]!.status).toBe('SENT');
    expect((await listInbox()).some(m => m.channel === 'WHATSAPP' && m.to === '9876543211')).toBe(true);
    const v = await makeUser({ mobile: '9876543212' });
    await setPrefs(v.id, { whatsappOptIn: true });
    await notify(NOTIFY.emergencyAlert, [v.id], alert, { societyId: strt.id });
    expect((await deliveries({ userId: v.id, channel: 'WHATSAPP' }))[0]).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'FEATURE_OFF',
    });
  });
  it('a mobile-only recipient gets SMS, no inbox item, an encrypted destination and a masked one', async () => {
    const society = std;
    await notify(NOTIFY.emergencyAlert, [{ mobile: '9876543213' }], alert, { societyId: society.id });
    const rows = await deliveries({ societyId: society.id });
    const sms = rows.find(r => r.channel === 'SMS')!;
    expect(sms).toMatchObject({ status: 'SENT', userId: null, destinationMasked: '98XXXXX213' });
    expect(sms.recipientKey).toMatch(/^m:[0-9a-f]{32}$/);
    expect(decrypt(sms.destinationEnc!)).toBe('9876543213');
    expect(rows.find(r => r.channel === 'WHATSAPP')!.skipReason).toBe('NOT_OPTED_IN');
    expect(await InboxItem.count()).toBe(0);
  });
  it('e-mail needs a verified address for a user', async () => {
    const society = std;
    const ok = await makeUser();
    const bad = await makeUser({ emailVerified: false });
    const d = { noticeId: 1, title: 'T', link: 'https://x.in/n/1' };
    await notify(NOTIFY.noticePublished, [ok.id, bad.id], d, { societyId: society.id, channels: ['EMAIL'] });
    expect((await deliveries({ userId: ok.id }))[0]).toMatchObject({ channel: 'EMAIL', status: 'SENT' });
    expect((await deliveries({ userId: bad.id }))[0]).toMatchObject({
      channel: 'EMAIL',
      status: 'SKIPPED',
      skipReason: 'NO_CONTACT',
    });
    expect((await listInbox()).filter(m => m.channel === 'EMAIL').map(m => m.to)).toEqual([ok.email]);
  });
});

describe('notify(): locale (BR-16-23)', () => {
  it("uses the user's preferred locale, an explicit one, and falls back to en-IN", async () => {
    const society = std;
    const u = await makeUser();
    const d = { noticeId: 1, title: 'T', link: 'https://x.in/n/1' };
    await setPrefs(u.id, { locale: 'hi-IN' });
    await notify(NOTIFY.noticePublished, [u.id], d, { societyId: society.id, dedupeKey: '1' });
    await notify(NOTIFY.noticePublished, [u.id], d, {
      societyId: society.id,
      dedupeKey: '2',
      locale: 'en-IN',
    });
    await notify(NOTIFY.noticePublished, [u.id], d, {
      societyId: society.id,
      dedupeKey: '3',
      locale: 'ta-IN',
    });
    const titles = (await inboxItems(u.id)).map(i => i.title);
    expect(titles[0]).toBe('नया सूचना: T');
    expect(titles[1]).toBe('New notice: T');
    expect(titles[2]).toBe('New notice: T');
  });
});

describe('notify(): fan-out for query recipients (6.5 step 4)', () => {
  it('a permission recipient returns queued without a count and reaches the holders', async () => {
    const { society, user } = main;
    const r = await notify(
      NOTIFY.noticeRecalled,
      [{ permission: 'communication.notices.approve' }],
      { noticeId: 1, title: 'T' },
      { societyId: society.id },
    );
    expect(r).toMatchObject({ accepted: null, queued: true, suppressed: false });
    expect((await inboxItems(user.id)).length).toBe(1);
  });
  it('query recipients without a society are a programmer error', async () => {
    expect(await codeOf(notify(NOTIFY.pushTest, [{ roleKey: 'chairman' }], {}))).toBe(
      'NOTIFY_SOCIETY_REQUIRED',
    );
  });
  it('queue mode: rows are written, deliver jobs enqueued and run by the worker', async () => {
    registerCommunicationJobs();
    setDeliveryMode('queue');
    const u = await makeUser();
    await subscribePush(u.id);
    await notify(NOTIFY.pushTest, [u.id], {});
    expect((await deliveries({ userId: u.id }))[0]!.status).toBe('QUEUED');
    await drainQueues();
    expect((await deliveries({ userId: u.id }))[0]!.status).toBe('SENT');
  });
});

describe('delivery: limits, retries, failures and fallbacks (BR-16-24, BR-16-27)', () => {
  const alert = { broadcastId: 1, title: 'Fire', message: 'Evacuate', link: 'https://x.in/e/1' };
  const limitError = () => new AppError(402, 'USAGE_LIMIT_EXCEEDED', 'limit');
  it('consumes the SMS limit exactly once per row, even across retries', async () => {
    const society = std;
    const spy = vi
      .spyOn(entitlements, 'consumeLimit')
      .mockResolvedValue({ used: 1, limit: 100, overLimit: false });
    let calls = 0;
    setAdapters({
      sms: {
        send: async () => {
          if (++calls === 1) throw new Error('timeout');
          return { providerId: 'p1' };
        },
      },
      whatsapp: new FakeWhatsAppSender(),
      email: new FakeEmailSender(),
    });
    const u = await makeUser({ mobile: '9876543214' });
    await notify(NOTIFY.emergencyAlert, [u.id], alert, { societyId: society.id, channels: ['SMS'] });
    const row = (await deliveries({ userId: u.id, channel: 'SMS' }))[0]!;
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, limitKey: 'limit.sms_per_month' });
    expect(row.nextAttemptAt!.getTime() - nowMs()).toBe(10_000); // SAFETY: 10 s after the failure
    advance(11_000);
    await repairStuck();
    const after = await row.reload();
    expect(after).toMatchObject({ status: 'SENT', attempts: 2, providerMessageId: 'p1' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
  it('over the limit: SAFETY is sent anyway (limitBypassed), STANDARD is skipped LIMIT_REACHED and falls back to push', async () => {
    const society = std;
    const spy = vi.spyOn(entitlements, 'consumeLimit').mockRejectedValue(limitError());
    const u = await makeUser({ mobile: '9876543215' });
    await subscribePush(u.id);
    await notify(NOTIFY.emergencyAlert, [u.id], alert, { societyId: society.id, channels: ['SMS'] });
    expect((await deliveries({ userId: u.id, channel: 'SMS' }))[0]).toMatchObject({
      status: 'SENT',
      limitBypassed: true,
      limitConsumedAt: null,
    });
    await notify(
      NOTIFY.noticePublished,
      [u.id],
      { noticeId: 1, title: 'T', link: 'https://x.in/n/1' },
      { societyId: society.id, channels: ['SMS'], dedupeKey: 'n1' },
    );
    const rows = await deliveries({ userId: u.id, templateKey: NOTIFY.noticePublished });
    expect(rows[0]).toMatchObject({ channel: 'SMS', status: 'SKIPPED', skipReason: 'LIMIT_REACHED' });
    expect(rows[1]).toMatchObject({ channel: 'PUSH', status: 'SENT', fallbackFromId: rows[0]!.id });
    spy.mockRestore();
  });
  it('a permanent error fails at once and a failed SMS of a SAFETY message creates a push fallback', async () => {
    const society = std;
    vi.spyOn(entitlements, 'consumeLimit').mockResolvedValue({ used: 1, limit: 100, overLimit: false });
    const perm = Object.assign(new Error('invalid number'), { permanent: true });
    setAdapters({
      sms: {
        send: async () => {
          throw perm;
        },
      },
      whatsapp: new FakeWhatsAppSender(),
      email: new FakeEmailSender(),
    });
    const u = await makeUser({ mobile: '9876543216' });
    await subscribePush(u.id);
    await notify(NOTIFY.emergencyAllClear, [u.id], alert, { societyId: society.id, channels: ['SMS'] });
    const rows = await deliveries({ userId: u.id });
    const sms = rows.find(r => r.channel === 'SMS')!;
    expect(sms).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(sms.lastErrorMessage).not.toContain('invalid');
    const push = rows.find(r => r.channel === 'PUSH')!;
    expect(push).toMatchObject({ status: 'SENT', fallbackFromId: sms.id });
    vi.restoreAllMocks();
  });
  it('gives up after the last attempt (OTP-class limit of 2 attempts is covered by retryPolicy)', async () => {
    const society = std;
    vi.spyOn(entitlements, 'consumeLimit').mockResolvedValue({ used: 1, limit: 100, overLimit: false });
    setAdapters({
      sms: {
        send: async () => {
          throw new Error('down');
        },
      },
      whatsapp: new FakeWhatsAppSender(),
      email: new FakeEmailSender(),
    });
    const u = await makeUser({ mobile: '9876543217' });
    await notify(NOTIFY.emergencyAlert, [u.id], alert, { societyId: society.id, channels: ['SMS'] });
    for (let i = 0; i < 4; i++) {
      advance(60_000);
      await repairStuck();
    }
    const row = (await deliveries({ userId: u.id, channel: 'SMS' }))[0]!;
    expect(row).toMatchObject({ status: 'FAILED', attempts: 3, maxAttempts: 3 });
    expect(row.failedAt).not.toBeNull();
    vi.restoreAllMocks();
  });
  it('cancels a STANDARD row when the society is suspended before delivery, and rows of an anonymised user', async () => {
    const society = std;
    const u = await makeUser();
    await subscribePush(u.id);
    setNow(IST('23:00'));
    await notify(
      NOTIFY.noticePublished,
      [u.id],
      { noticeId: 1, title: 'T', link: 'https://x.in/n/1' },
      { societyId: society.id },
    );
    await setSocietyStatus(society.id!, 'SUSPENDED');
    setNow(IST('07:30', '2026-11-02'));
    await repairStuck();
    expect((await deliveries({ userId: u.id }))[0]).toMatchObject({
      status: 'CANCELLED',
      lastErrorCode: 'SOCIETY_SUSPENDED',
    });
  });
  it('repairStuck puts a stale SENDING row back and re-delivers it without counting the attempt twice', async () => {
    const u = await makeUser();
    await subscribePush(u.id);
    await notify(NOTIFY.pushTest, [u.id], {});
    const [row] = await deliveries({ userId: u.id });
    await Notification.update({ status: 'SENDING' }, { where: { id: row!.id } });
    advance(11 * 60_000);
    const r = await repairStuck();
    expect(r.reset).toBe(1);
    expect((await row!.reload()).status).toBe('SENT');
  });
});

describe('ports', () => {
  it('the push port can be replaced (gone endpoints revoke the subscription, BR-16-36)', async () => {
    const u = await makeUser();
    const sub = await subscribePush(u.id);
    setCommunicationPorts({ push: { send: async () => ({ ok: false, gone: true, error: 'HTTP_410' }) } });
    await notify(NOTIFY.pushTest, [u.id], {});
    expect(await sub.reload()).toMatchObject({ status: 'REVOKED', revokedReason: 'GONE' });
    expect((await deliveries({ userId: u.id }))[0]!.status).toBe('QUEUED'); // temporary from the row's point of view: retried while subscriptions remain
  });
});
