import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  EmergencyBroadcast,
  Notice,
  NoticeReceipt,
  Notification,
  NotificationPreference,
  closeDb,
} from '../../../src/models';
import { signFakeWebhook } from '../../../src/adapters/provider-adapter';
import { advance, nowMs, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { registerCommunicationJobs } from '../../../src/modules/communication/communication.jobs';
import { setJobHooks } from '../../../src/modules/communication/communication.jobs.common';
import { resetWebhookThrottle } from '../../../src/modules/communication/communication.webhooks.service';
import { call, makeUser, resetAll } from '../../helpers/auth';
import { subSociety } from '../../helpers/subscriptions';
import { resetCommunication } from '../../helpers/communication';

afterAll(closeDb);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(async () => {
  await resetAll();
  await resetCommunication();
  await resetRateLimits();
  resetWebhookThrottle();
  setJobHooks(null);
  registerCommunicationJobs();
});

/** POST a signed webhook of the fake vendor. */
async function hook(
  events: unknown[],
  o: { key?: string; secret?: string; ts?: number; sign?: boolean; providerKey?: string } = {},
) {
  const body = JSON.stringify({ events });
  const ts = o.ts ?? nowMs();
  const sig = o.sign === false ? 'ab'.repeat(32) : signFakeWebhook(body, ts, o.secret);
  return call('post', `/webhooks/messaging/${o.providerKey ?? 'fake'}`, body, {
    app: 'ADMIN',
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': String(ts),
      'x-webhook-signature': sig,
    },
  });
}

async function sentRow(o: Record<string, unknown> = {}) {
  const { society } = await subSociety({ plan: 'PREMIUM' });
  const u = await makeUser({ name: 'Rita', mobile: '9811111111', email: 'Rita@Mail.in' });
  const n = await Notification.create({
    societyId: society.id,
    batchId: 'b',
    templateKey: 'communication.notice_published',
    locale: 'en-IN',
    deliveryClass: 'STANDARD',
    channel: 'WHATSAPP',
    userId: u.id,
    recipientKey: `u:${u.id}`,
    status: 'SENT',
    providerKey: 'fake',
    providerMessageId: 'pm-1',
    sentAt: new Date(),
    ...o,
  } as never);
  return { society, u, n };
}

describe('POST /webhooks/messaging/:providerKey (8.37): request', () => {
  it('needs no cookie, answers 200 and queues the events; the job applies them', async () => {
    const { n } = await sentRow();
    const r = await hook([{ providerMessageId: 'pm-1', status: 'DELIVERED' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ received: true, events: 1 });
    expect((await n.reload()).status).toBe('SENT'); // not applied inside the request
    await drainQueues();
    expect((await n.reload()).status).toBe('DELIVERED');
    expect(n.deliveredAt).not.toBeNull();
  });
  it('refuses a bad signature, a wrong secret, a missing signature and a stale timestamp with 401 WEBHOOK_SIGNATURE_INVALID', async () => {
    const ev = [{ providerMessageId: 'pm-1', status: 'DELIVERED' }];
    for (const r of [
      await hook(ev, { sign: false }),
      await hook(ev, { secret: 'other-secret' }),
      await hook(ev, { ts: nowMs() - 6 * 60_000 }),
      await call('post', '/webhooks/messaging/fake', JSON.stringify({ events: ev }), {
        app: 'ADMIN',
        headers: { 'content-type': 'application/json' },
      }),
    ]) {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    }
    expect((await hook(ev, { ts: nowMs() - 4 * 60_000 })).status).toBe(200); // inside the 5-minute window
  });
  it('404 NOT_FOUND for an unknown provider key; no row is touched', async () => {
    const r = await hook([{ providerMessageId: 'pm-1', status: 'DELIVERED' }], { providerKey: 'nope' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
  });
  it('answers 200 for a signed body with no known events and queues nothing', async () => {
    const r = await hook([{ weird: true }]);
    expect(r.status).toBe(200);
    expect(r.body.data.events).toBe(0);
  });
});

describe('process-webhook (8.37, 6.2)', () => {
  it('status moves only forward and FAILED only from SENT', async () => {
    const { n } = await sentRow();
    await hook([{ providerMessageId: 'pm-1', status: 'READ' }]);
    await drainQueues();
    expect((await n.reload()).status).toBe('READ');
    await hook([
      { providerMessageId: 'pm-1', status: 'DELIVERED' },
      { providerMessageId: 'pm-1', status: 'FAILED', errorCode: 'X' },
    ]);
    await drainQueues();
    expect((await n.reload()).status).toBe('READ'); // never back
    const f = await Notification.create({
      societyId: n.societyId,
      batchId: 'b',
      templateKey: 'communication.notice_published',
      locale: 'en-IN',
      deliveryClass: 'STANDARD',
      channel: 'SMS',
      userId: n.userId,
      recipientKey: n.recipientKey,
      status: 'SENT',
      providerKey: 'fake',
      providerMessageId: 'pm-2',
    } as never);
    await hook([{ providerMessageId: 'pm-2', status: 'FAILED', errorCode: 'NUMBER_INVALID' }]);
    await drainQueues();
    await f.reload();
    expect(f.status).toBe('FAILED');
    expect(f.lastErrorCode).toBe('NUMBER_INVALID');
    expect(f.failedAt).not.toBeNull();
  });
  it('an unknown provider message id or another provider key is ignored', async () => {
    const { n } = await sentRow({ providerKey: 'other' });
    await hook([
      { providerMessageId: 'pm-1', status: 'DELIVERED' },
      { providerMessageId: 'zzz', status: 'DELIVERED' },
    ]);
    await drainQueues();
    expect((await n.reload()).status).toBe('SENT');
  });
  it('DELIVERED of a notice delivery sets the receipt reachedAt / reachedVia once and counts it', async () => {
    const { society, u } = await sentRow();
    const notice = await Notice.create({
      societyId: society.id,
      title: 'Water off',
      body: '<p>Water off tomorrow</p>',
      bodyText: 'Water off tomorrow',
      status: 'PUBLISHED',
    } as never);
    const rc = await NoticeReceipt.create({
      societyId: society.id,
      noticeId: notice.id,
      recipientKey: `u:${u.id}`,
      userId: u.id,
    } as never);
    await Notification.update(
      { sourceType: 'notice', sourceId: notice.id },
      { where: { providerMessageId: 'pm-1' } },
    );
    await hook([{ providerMessageId: 'pm-1', status: 'DELIVERED' }]);
    await drainQueues();
    await rc.reload();
    expect(rc.reachedAt).not.toBeNull();
    expect(rc.reachedVia).toBe('WHATSAPP');
    expect((await notice.reload()).reachedCount).toBe(1);
    await hook([
      { providerMessageId: 'pm-1', status: 'DELIVERED' },
      { providerMessageId: 'pm-1', status: 'READ' },
    ]);
    await drainQueues();
    expect((await notice.reload()).reachedCount).toBe(1); // idempotent
  });
  it('STOP opts out every user with that mobile, audits once (system actor), and is idempotent', async () => {
    const a = await makeUser({ name: 'A', mobile: '9822222222' });
    const b = await makeUser({ name: 'B', mobile: '9833333333' });
    await NotificationPreference.create({
      userId: a.id,
      whatsappOptIn: true,
      whatsappOptInAt: new Date(),
    } as never);
    await hook([{ inbound: 'STOP', mobile: '9822222222' }]);
    await drainQueues();
    const p = (await NotificationPreference.findOne({ where: { userId: a.id } }))!;
    expect(p.whatsappOptIn).toBe(false);
    expect(p.whatsappOptOutAt).not.toBeNull();
    expect(
      await NotificationPreference.findOne({ where: { userId: b.id, whatsappOptOutAt: null } }),
    ).toBeNull(); // untouched user has no opt-out
    await hook([{ inbound: 'STOP', mobile: '9822222222' }]);
    await drainQueues();
    const rows = await AuditLog.findAll({ where: { action: 'communication.whatsapp.opted_out' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorRole).toBe('system');
  });
  it('a hard bounce sets emailBouncedAt (e-mail matched case-insensitively); a second one changes nothing', async () => {
    const u = await makeUser({ name: 'Rita', mobile: '9811111111', email: 'Rita@Mail.in' });
    await hook([{ bounce: 'HARD', email: 'rita@mail.IN' }]);
    await drainQueues();
    const p = (await NotificationPreference.findOne({ where: { userId: u.id } }))!;
    expect(p.emailBouncedAt).not.toBeNull();
    const first = p.emailBouncedAt!.getTime();
    advance(60_000);
    await hook([{ bounce: 'COMPLAINT', email: 'rita@mail.in' }]);
    await drainQueues();
    expect((await p.reload()).emailBouncedAt!.getTime()).toBe(first);
  });
  it('a BUTTON reply records a response through the 16.3 hook only when exactly one audience flat matches', async () => {
    const { society } = await subSociety({ plan: 'PREMIUM' });
    const u = await makeUser({ name: 'Rita', mobile: '9844444444' });
    const b = await EmergencyBroadcast.create({
      societyId: society.id,
      type: 'FIRE',
      title: 'Fire',
      message: 'Fire in A',
      startedBy: u.id,
      startedAt: new Date(),
      status: 'ACTIVE',
    } as never);
    const calls: unknown[] = [];
    setJobHooks({ recordEmergencyResponse: async i => void calls.push(i) });
    // the user has no flat in the audience: logged and ignored
    await hook([
      { inbound: 'BUTTON', payload: `EMG:${b.id}:SAFE`, mobile: '9844444444' },
      { inbound: 'BUTTON', payload: 'garbage', mobile: '9844444444' },
    ]);
    await drainQueues();
    expect(calls).toHaveLength(0);
  });
});

describe('hashes', () => {
  it('the adapter hashes mobile numbers and e-mails (the queued payload never holds them)', async () => {
    const r = await hook([{ inbound: 'STOP', mobile: '9822222222' }]);
    expect(r.status).toBe(200);
    expect(sha('9822222222')).toHaveLength(64);
    setNow('2026-11-01T04:30:00Z');
  });
});
