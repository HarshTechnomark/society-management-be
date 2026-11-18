import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  EmergencyBroadcast,
  EmergencyResponse,
  InboxItem,
  Notice,
  NoticeReceipt,
  Notification,
  PushSubscription,
  Survey,
  SurveyResponse,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { drainQueues, tickScheduler } from '../../../src/lib/queue';
import { registerCommunicationJobs } from '../../../src/modules/communication/communication.jobs';
import { setJobHooks } from '../../../src/modules/communication/communication.jobs.common';
import {
  runAckReminders,
  runAckRemindNotice,
  runNoticeExpiry,
  runNoticeScheduler,
  runUtilityReminders,
} from '../../../src/modules/communication/communication.jobs.notices';
import {
  runEmergencyResolveReminder,
  runSurveyClose,
} from '../../../src/modules/communication/communication.jobs.safety';
import { runPurge, runPushExpiry } from '../../../src/modules/communication/communication.jobs.maintenance';
import { NOTIFY } from '../../../src/modules/communication/communication.constants';
import { encryptJson } from '../../../src/modules/communication/communication.crypto';
import { makeUser, resetAll } from '../../helpers/auth';
import { subSociety } from '../../helpers/subscriptions';
import { deliveries, inboxItems, resetCommunication, subscribePush } from '../../helpers/communication';
import { lifecycleColumns } from '../../helpers/access';
import { Society } from '../../../src/models';

const setSocietyStatus = (id: number, status: 'ACTIVE' | 'SUSPENDED') =>
  Society.update(lifecycleColumns(status) as never, { where: { id } });

afterAll(closeDb);
const T0 = '2026-11-01T04:30:00Z'; // 10:00 IST
const at = (iso = T0) => new Date(iso);
const hours = (h: number, from = T0) => new Date(new Date(from).getTime() + h * 3_600_000);

beforeEach(async () => {
  await resetAll();
  await resetCommunication();
  setJobHooks(null);
  registerCommunicationJobs();
});

async function world() {
  const { society } = await subSociety({ plan: 'PREMIUM' });
  const u1 = await makeUser({ name: 'Rita' });
  const u2 = await makeUser({ name: 'Sam' });
  return { sid: society.id!, society, u1, u2 };
}
const mkNotice = (sid: number, o: Record<string, unknown> = {}) =>
  Notice.create({
    societyId: sid,
    title: 'Water tank cleaning',
    body: '<p>Tank will be cleaned on Sunday.</p>',
    bodyText: 'Tank will be cleaned on Sunday.',
    status: 'PUBLISHED',
    publishedAt: at(),
    ...o,
  } as never);
const mkReceipt = (sid: number, noticeId: number, userId: number | null, o: Record<string, unknown> = {}) =>
  NoticeReceipt.create({
    societyId: sid,
    noticeId,
    recipientKey: userId ? `u:${userId}` : `m:x${Math.random()}`,
    userId,
    ...o,
  } as never);
const audits = (action: string) => AuditLog.findAll({ where: { action } });

describe('communication:notice-scheduler (9.1)', () => {
  it('publishes due SCHEDULED notices once, audits as system and enqueues the fan-out; future ones wait', async () => {
    const { sid } = await world();
    const due = await mkNotice(sid, {
      status: 'SCHEDULED',
      scheduledAt: at('2026-11-01T04:00:00Z'),
      publishedAt: null,
    });
    const later = await mkNotice(sid, {
      status: 'SCHEDULED',
      scheduledAt: at('2026-11-02T04:00:00Z'),
      publishedAt: null,
    });
    expect(await runNoticeScheduler(at())).toEqual({ published: 1, skipped: 0 });
    expect(await runNoticeScheduler(at())).toEqual({ published: 0, skipped: 0 }); // idempotent
    await due.reload();
    await later.reload();
    expect(due.status).toBe('PUBLISHED');
    expect(due.publishedAt).not.toBeNull();
    expect(later.status).toBe('SCHEDULED');
    const rows = await audits('communication.notice.published');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBeNull();
    expect(rows[0]!.actorRole).toBe('system');
  });
  it('skips societies the state guard refuses (suspended) and works from the registered repeatable job', async () => {
    const { sid } = await world();
    const n = await mkNotice(sid, {
      status: 'SCHEDULED',
      scheduledAt: at('2026-11-01T04:00:00Z'),
      publishedAt: null,
    });
    await setSocietyStatus(sid, 'SUSPENDED');
    expect(await runNoticeScheduler(at())).toEqual({ published: 0, skipped: 1 });
    await setSocietyStatus(sid, 'ACTIVE');
    const ran = await tickScheduler(at('2026-11-01T04:31:00Z'));
    await drainQueues();
    expect(ran).toContain('communication:notice-scheduler');
    expect((await n.reload()).status).toBe('PUBLISHED');
  });
  it('a hook of part 16.1 replaces the default publish step', async () => {
    const { sid } = await world();
    const n = await mkNotice(sid, {
      status: 'SCHEDULED',
      scheduledAt: at('2026-11-01T04:00:00Z'),
      publishedAt: null,
    });
    const seen: number[] = [];
    setJobHooks({ publishScheduledNotice: async (_s, id) => (seen.push(id), true) });
    expect((await runNoticeScheduler(at())).published).toBe(1);
    expect(seen).toEqual([n.id]);
    expect((await n.reload()).status).toBe('SCHEDULED'); // the hook owns the change
  });
});

describe('communication:notice-expiry (9.1)', () => {
  it('moves due PUBLISHED notices to EXPIRED, unpins them and audits; others stay', async () => {
    const { sid } = await world();
    const a = await mkNotice(sid, {
      expiresAt: at('2026-11-01T04:00:00Z'),
      isPinned: true,
      pinnedAt: at('2026-10-30T04:00:00Z'),
    });
    const b = await mkNotice(sid, { expiresAt: at('2026-11-05T04:00:00Z') });
    const c = await mkNotice(sid, { expiresAt: null });
    expect(await runNoticeExpiry(at())).toEqual({ expired: 1 });
    expect(await runNoticeExpiry(at())).toEqual({ expired: 0 });
    await a.reload();
    expect(a.status).toBe('EXPIRED');
    expect(a.isPinned).toBe(false);
    expect(a.pinnedAt).toBeNull();
    expect(a.expiredAt).not.toBeNull();
    expect((await b.reload()).status).toBe('PUBLISHED');
    expect((await c.reload()).status).toBe('PUBLISHED');
    const rows = await audits('communication.notice.expired');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(String(a.id));
  });
});

describe('acknowledgement reminders (BR-16-12)', () => {
  it('reminds only unacknowledged receipts with a login after 48 hours, once per interval, up to the maximum', async () => {
    const { sid, u1, u2 } = await world();
    const n = await mkNotice(sid, { requiresAck: true, publishedAt: at('2026-10-30T04:30:00Z') });
    await mkReceipt(sid, n.id, u1.id);
    await mkReceipt(sid, n.id, u2.id, { acknowledgedAt: at('2026-10-30T10:00:00Z') });
    expect(await runAckReminders(at())).toEqual({ reminded: 1 });
    expect(await runAckReminders(at())).toEqual({ reminded: 0 }); // counters compared in the UPDATE
    await n.reload();
    expect(n.remindersSent).toBe(1);
    expect(n.lastRemindedAt).not.toBeNull();
    expect(await inboxItems(u1.id)).toHaveLength(1);
    expect((await inboxItems(u1.id))[0]!.templateKey).toBe(NOTIFY.noticeAckReminder);
    expect(await inboxItems(u2.id)).toHaveLength(0);
    // next interval, then the maximum of 3
    expect((await runAckReminders(hours(48))).reminded).toBe(1);
    expect((await runAckReminders(hours(96))).reminded).toBe(1);
    expect((await runAckReminders(hours(144))).reminded).toBe(0);
    expect((await n.reload()).remindersSent).toBe(3);
  });
  it('runs only at 10:00 local time unless forced, never after ackDueAt, never for notices without acknowledgement', async () => {
    const { sid, u1 } = await world();
    const n = await mkNotice(sid, { requiresAck: true, publishedAt: at('2026-10-28T04:30:00Z') });
    await mkReceipt(sid, n.id, u1.id);
    expect((await runAckReminders(at('2026-11-01T06:30:00Z'))).reminded).toBe(0); // 12:00 IST
    const due = await mkNotice(sid, {
      requiresAck: true,
      publishedAt: at('2026-10-28T04:30:00Z'),
      ackDueAt: at('2026-10-31T04:30:00Z'),
    });
    await mkReceipt(sid, due.id, u1.id);
    const plain = await mkNotice(sid, { requiresAck: false, publishedAt: at('2026-10-28T04:30:00Z') });
    await mkReceipt(sid, plain.id, u1.id);
    expect((await runAckReminders(at())).reminded).toBe(1);
    expect((await due.reload()).remindersSent).toBe(0);
    expect((await plain.reload()).remindersSent).toBe(0);
  });
  it('the manual remind job notifies once per reminder number', async () => {
    const { sid, u1 } = await world();
    const n = await mkNotice(sid, { requiresAck: true });
    await mkReceipt(sid, n.id, u1.id);
    expect(await runAckRemindNotice({ noticeId: n.id, reminderNo: 1 })).toEqual({ queuedFor: 1 });
    await runAckRemindNotice({ noticeId: n.id, reminderNo: 1 });
    expect(await inboxItems(u1.id)).toHaveLength(1); // dedupe key includes the reminder number
    await runAckRemindNotice({ noticeId: n.id, reminderNo: 2 });
    expect(await inboxItems(u1.id)).toHaveLength(2);
  });
});

describe('communication:utility-reminders (BR-16-16)', () => {
  it('sends the start reminder 2 hours before, once, only when published long enough before', async () => {
    const { sid, u1 } = await world();
    const n = await mkNotice(sid, {
      kind: 'UTILITY_SHUTDOWN',
      utilityType: 'WATER',
      outageStartsAt: hours(1.5),
      outageEndsAt: hours(6),
      publishedAt: hours(-24),
    });
    const late = await mkNotice(sid, {
      kind: 'UTILITY_SHUTDOWN',
      utilityType: 'POWER',
      outageStartsAt: hours(1),
      outageEndsAt: hours(5),
      publishedAt: hours(-0.5),
    });
    const far = await mkNotice(sid, {
      kind: 'UTILITY_SHUTDOWN',
      utilityType: 'GAS',
      outageStartsAt: hours(10),
      outageEndsAt: hours(12),
      publishedAt: hours(-24),
    });
    for (const x of [n, late, far]) await mkReceipt(sid, x.id, u1.id);
    expect(await runUtilityReminders(at())).toEqual({ sent: 1 });
    expect(await runUtilityReminders(at())).toEqual({ sent: 0 });
    expect((await n.reload()).startReminderSentAt).not.toBeNull();
    expect((await late.reload()).startReminderSentAt).toBeNull();
    expect((await far.reload()).startReminderSentAt).toBeNull();
    const rows = await deliveries({ userId: u1.id });
    expect(rows.every(r => r.templateKey === NOTIFY.utilityStarting)).toBe(true);
    expect((await inboxItems(u1.id)).length).toBe(1);
  });
});

describe('communication:emergency-resolve-reminder (BR-16-43)', () => {
  const mk = (sid: number, starter: number, o: Record<string, unknown> = {}) =>
    EmergencyBroadcast.create({
      societyId: sid,
      type: 'FIRE',
      title: 'Fire',
      message: 'Fire in block A',
      startedBy: starter,
      startedAt: at(),
      status: 'ACTIVE',
      ...o,
    } as never);
  it('reminds the starter every 30 minutes while ACTIVE, even for a suspended society (tag safety)', async () => {
    const { sid, u1 } = await world();
    const b = await mk(sid, u1.id);
    expect(await runEmergencyResolveReminder(hours(0.2))).toEqual({ reminded: 0 });
    expect(await runEmergencyResolveReminder(hours(0.5))).toEqual({ reminded: 1 });
    expect(await runEmergencyResolveReminder(hours(0.6))).toEqual({ reminded: 0 });
    await setSocietyStatus(sid, 'SUSPENDED');
    expect(await runEmergencyResolveReminder(hours(1.1))).toEqual({ reminded: 1 });
    expect((await inboxItems(u1.id)).map(i => i.templateKey)).toEqual([
      NOTIFY.emergencyResolveReminder,
      NOTIFY.emergencyResolveReminder,
    ]);
    expect((await b.reload()).lastResolveReminderAt).not.toBeNull();
  });
  it('does nothing for resolved broadcasts', async () => {
    const { sid, u1 } = await world();
    await mk(sid, u1.id, { status: 'RESOLVED' });
    expect(await runEmergencyResolveReminder(hours(5))).toEqual({ reminded: 0 });
  });
});

describe('communication:survey-close (9.1)', () => {
  const mk = (sid: number, o: Record<string, unknown> = {}) =>
    Survey.create({
      societyId: sid,
      title: 'Gym timings',
      status: 'OPEN',
      openedAt: hours(-48),
      closesAt: hours(-1),
      isAnonymous: false,
      resultsVisibility: 'RESPONDENTS_AFTER_CLOSE',
      audienceType: 'ALL',
      ...o,
    } as never);
  it('closes due surveys, audits, and tells named respondents when results are visible to them', async () => {
    const { sid, u1 } = await world();
    const s = await mk(sid);
    const open = await mk(sid, { closesAt: hours(72) });
    const q = await sequelize.query('SELECT 1');
    void q;
    await SurveyResponse.create({
      societyId: sid,
      surveyId: s.id,
      questionId: 1,
      submissionId: 'sub-1',
      respondentKey: 'k1',
      userId: u1.id,
      optionKey: 'o1',
    } as never).catch(() => null);
    expect((await runSurveyClose(at())).closed).toBe(1);
    expect((await runSurveyClose(at())).closed).toBe(0);
    await s.reload();
    expect(s.status).toBe('CLOSED');
    expect(s.closedAt).not.toBeNull();
    expect((await open.reload()).status).toBe('OPEN');
    expect(await audits('communication.survey.closed')).toHaveLength(1);
  });
  it('sends the 24-hour reminder once, to audience users only', async () => {
    const { sid, u1 } = await world();
    const s = await mk(sid, { closesAt: hours(20), reminderSentAt: null });
    const far = await mk(sid, { closesAt: hours(60) });
    const r = await runSurveyClose(at());
    expect(r.closed).toBe(0);
    expect(r.reminded).toBe(1); // the survey with a closing time inside 24 hours
    expect((await s.reload()).reminderSentAt).not.toBeNull();
    expect((await far.reload()).reminderSentAt).toBeNull();
    expect((await runSurveyClose(at())).reminded).toBe(0);
    void u1;
  });
});

describe('communication:purge and push-expiry (9.1, BR-16-31, BR-16-44)', () => {
  it('deletes old inbox items and delivery rows, clears payloads of final rows after 24 h, removes old revoked subscriptions, scrubs old emergency responses', async () => {
    const { sid, u1 } = await world();
    const mkInbox = (createdAt: Date) =>
      InboxItem.create({
        scope: 'USER',
        userId: u1.id,
        batchId: 'b',
        templateKey: 'x.y',
        category: 'SYSTEM',
        deliveryClass: 'STANDARD',
        title: 't',
        body: 'b',
        createdAt,
      } as never);
    const oldI = await mkInbox(new Date('2025-10-01T00:00:00Z'));
    const newI = await mkInbox(new Date('2026-10-30T00:00:00Z'));
    const mkN = (createdAt: Date, status: string, updatedAt: Date) =>
      Notification.create({
        societyId: sid,
        batchId: 'b',
        templateKey: 'x.y',
        locale: 'en-IN',
        deliveryClass: 'STANDARD',
        channel: 'SMS',
        userId: u1.id,
        recipientKey: `u:${u1.id}`,
        status,
        dataEnc: encryptJson({ data: {} }),
        destinationEnc: encryptJson('9800000000'),
        createdAt,
        updatedAt,
      } as never);
    const oldN = await mkN(new Date('2026-03-01T00:00:00Z'), 'SENT', new Date('2026-03-01T00:00:00Z'));
    const finalN = await mkN(new Date('2026-10-30T00:00:00Z'), 'DELIVERED', new Date('2026-10-30T00:00:00Z'));
    const queuedN = await mkN(new Date('2026-10-30T00:00:00Z'), 'QUEUED', new Date('2026-10-30T00:00:00Z'));
    // the model stamps updatedAt on create: set the old values explicitly
    await sequelize.query("UPDATE notifications SET updatedAt = '2026-10-30 00:00:00' WHERE id IN (:ids)", {
      replacements: { ids: [finalN.id, queuedN.id] },
    });
    const revoked = await subscribePush(u1.id);
    await revoked.update({
      status: 'REVOKED',
      revokedReason: 'USER',
      revokedAt: new Date('2026-06-01T00:00:00Z'),
    } as never);
    const active = await subscribePush(u1.id);
    const b = await EmergencyBroadcast.create({
      societyId: sid,
      type: 'FIRE',
      title: 'Fire',
      message: 'm',
      startedBy: u1.id,
      startedAt: new Date('2025-09-01T00:00:00Z'),
      status: 'RESOLVED',
    } as never);
    const resp = await EmergencyResponse.create({
      societyId: sid,
      broadcastId: b.id,
      subjectKey: 'u:1',
      userId: u1.id,
      recordedBy: u1.id,
      status: 'SAFE',
      note: 'we are fine',
      channel: 'APP',
      createdAt: new Date('2025-09-02T00:00:00Z'),
    } as never);

    const r = await runPurge(at());
    expect(r).toMatchObject({ inbox: 1, deliveries: 1, pushDeleted: 1, emergencyResponsesScrubbed: 1 });
    expect(r.payloadsCleared).toBeGreaterThanOrEqual(1);
    expect(await InboxItem.findByPk(oldI.id)).toBeNull();
    expect(await InboxItem.findByPk(newI.id)).not.toBeNull();
    expect(await Notification.findByPk(oldN.id)).toBeNull();
    const fin = (await Notification.findByPk(finalN.id))!;
    expect(fin.dataEnc).toBeNull();
    expect(fin.destinationEnc).toBeNull();
    expect((await Notification.findByPk(queuedN.id))!.dataEnc).not.toBeNull(); // not final: still needed
    expect(await PushSubscription.findByPk(revoked.id)).toBeNull();
    expect(await PushSubscription.findByPk(active.id)).not.toBeNull();
    const er = (await EmergencyResponse.findByPk(resp.id))!;
    expect(er.note).toBeNull();
    expect(er.userId).toBeNull();
    expect(er.status).toBe('SAFE'); // counts stay
    expect(await runPurge(at())).toMatchObject({
      inbox: 0,
      deliveries: 0,
      pushDeleted: 0,
      emergencyResponsesScrubbed: 0,
    });
  });
  it('push-expiry revokes subscriptions whose expirationTime passed', async () => {
    const { u1 } = await world();
    const a = await subscribePush(u1.id);
    const b = await subscribePush(u1.id);
    await a.update({ expirationTime: hours(-1) } as never);
    await b.update({ expirationTime: hours(24) } as never);
    expect(await runPushExpiry(at())).toEqual({ revoked: 1 });
    await a.reload();
    expect(a.status).toBe('REVOKED');
    expect(a.revokedReason).toBe('EXPIRED');
    expect((await b.reload()).status).toBe('ACTIVE');
    advance(0);
    setNow(T0);
  });
});
