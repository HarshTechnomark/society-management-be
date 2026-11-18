import { Op } from 'sequelize';
import { Notice, NoticeReceipt, sequelize } from '../../models';
import { addHours, now } from '../../lib/clock';
import { env } from '../../lib/env';
import { enqueueAfterCommit } from '../../lib/queue';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { isJobAllowed } from '../societies/societies.guard';
import { settings } from '../society-setup/society-setup.public';
import { AUDIT, COMMUNICATION_QUEUE, ENTITY, JOBS, NOTIFY, RT, SETTING } from './communication.constants';
import { notify } from './communication.core';
import { assertNoticeTransition } from './communication.state';
import { SYSTEM_ACTOR, jobCtx, jobHooks, localHour, societyStatuses } from './communication.jobs.common';

/** Section 9.1 jobs of notices: scheduler, expiry, automatic and manual acknowledgement reminders, utility start reminders. Notices change status only through `assertNoticeTransition`. */
const BATCH = 200;
const noticeLink = (id: number) => `${env().appOrigins[0] ?? ''}/notices/${id}`;

function emitNotice(n: Notice): void {
  emitToRoom(`society:${n.societyId}:admin`, RT.noticeUpdated, {
    noticeId: n.id,
    status: n.status,
    readCount: n.readCount,
    ackCount: n.ackCount,
    reachedCount: n.reachedCount,
  });
}

// ------------------------------------------------------------------ notice-scheduler (every minute)
export async function runNoticeScheduler(at: Date = now()): Promise<{ published: number; skipped: number }> {
  const due = await Notice.findAll({
    where: { status: 'SCHEDULED', scheduledAt: { [Op.lte]: at } },
    attributes: ['id', 'societyId'],
    order: [['scheduledAt', 'ASC']],
    limit: BATCH,
  });
  const states = await societyStatuses([...new Set(due.map(d => d.societyId))]);
  let published = 0;
  let skipped = 0;
  for (const d of due) {
    const st = states.get(d.societyId);
    if (!st || !isJobAllowed(st.status, 'normal')) {
      skipped += 1;
      continue;
    }
    try {
      const ok = jobHooks.publishScheduledNotice
        ? await jobHooks.publishScheduledNotice(d.societyId, d.id, at)
        : await publishScheduledDefault(d.id, at);
      if (ok) published += 1;
    } catch (err) {
      logger.error({ err, noticeId: d.id }, 'scheduled notice could not be published');
    }
  }
  return { published, skipped };
}

async function publishScheduledDefault(noticeId: number, at: Date): Promise<boolean> {
  return sequelize.transaction(async t => {
    const n = await Notice.findByPk(noticeId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!n || n.status !== 'SCHEDULED' || !n.scheduledAt || n.scheduledAt.getTime() > at.getTime())
      return false;
    assertNoticeTransition('SCHEDULED', 'publish');
    await n.update({ status: 'PUBLISHED', publishedAt: at, version: n.version + 1 }, { transaction: t });
    await audit(
      jobCtx(n.societyId),
      {
        action: AUDIT.noticePublished,
        entityType: ENTITY.notice,
        entityId: n.id,
        societyId: n.societyId,
        actor: SYSTEM_ACTOR,
        after: { status: 'PUBLISHED', scheduled: true },
      },
      t,
    );
    enqueueAfterCommit(t, COMMUNICATION_QUEUE, JOBS.noticeFanout, { noticeId: n.id, societyId: n.societyId });
    t.afterCommit(() => emitNotice(n));
    return true;
  });
}

// ------------------------------------------------------------------ notice-expiry (every 15 minutes)
export async function runNoticeExpiry(at: Date = now()): Promise<{ expired: number }> {
  const due = await Notice.findAll({
    where: { status: 'PUBLISHED', expiresAt: { [Op.lte]: at } },
    attributes: ['id', 'societyId'],
    limit: BATCH,
  });
  const states = await societyStatuses([...new Set(due.map(d => d.societyId))]);
  let expired = 0;
  for (const d of due) {
    const st = states.get(d.societyId);
    if (!st || !isJobAllowed(st.status, 'normal')) continue;
    const done = await sequelize.transaction(async t => {
      const n = await Notice.findByPk(d.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!n || n.status !== 'PUBLISHED' || !n.expiresAt || n.expiresAt.getTime() > at.getTime()) return null;
      assertNoticeTransition('PUBLISHED', 'expire');
      await n.update(
        { status: 'EXPIRED', expiredAt: at, isPinned: false, pinnedAt: null, version: n.version + 1 },
        { transaction: t },
      );
      await audit(
        jobCtx(n.societyId),
        {
          action: AUDIT.noticeExpired,
          entityType: ENTITY.notice,
          entityId: n.id,
          societyId: n.societyId,
          actor: SYSTEM_ACTOR,
          after: { status: 'EXPIRED' },
        },
        t,
      );
      t.afterCommit(() => emitNotice(n));
      return n;
    });
    if (done) expired += 1;
  }
  return { expired };
}

// ------------------------------------------------------------------ reminders (BR-16-12)
/** Sends one acknowledgement reminder to every receipt holder with a login that has not acknowledged (idempotent through the dedupe key of the reminder number). */
export async function sendAckReminder(noticeId: number, reminderNo: number): Promise<number> {
  const n = await Notice.findByPk(noticeId);
  if (!n || n.status !== 'PUBLISHED' || !n.requiresAck) return 0;
  const receipts = await NoticeReceipt.findAll({
    where: { noticeId, userId: { [Op.ne]: null }, acknowledgedAt: null },
    attributes: ['id', 'userId'],
  });
  const userIds = [...new Set(receipts.map(r => r.userId!))];
  if (!userIds.length) return 0;
  await notify(
    NOTIFY.noticeAckReminder,
    userIds,
    {
      noticeId: n.id,
      title: n.title,
      link: noticeLink(n.id),
      ackDueAt: n.ackDueAt ?? new Date(n.publishedAt ?? now()),
    },
    {
      societyId: n.societyId,
      dedupeKey: `notice:${n.id}:remind:${reminderNo}`,
      sourceType: ENTITY.notice,
      sourceId: n.id,
    },
  );
  await NoticeReceipt.update(
    { remindersSent: sequelize.literal('remindersSent + 1') as never, lastRemindedAt: now() },
    { where: { id: { [Op.in]: receipts.map(r => r.id) } } },
  );
  return userIds.length;
}

/** `communication:ack-remind-notice`: the manual "remind unacknowledged" (16.1 counted it and enqueues this with the reminder number). */
export async function runAckRemindNotice(data: Record<string, unknown>): Promise<{ queuedFor: number }> {
  const noticeId = Number(data.noticeId);
  const reminderNo = Number(data.reminderNo ?? data.remindersSent ?? 1);
  if (!Number.isInteger(noticeId)) return { queuedFor: 0 };
  return { queuedFor: await sendAckReminder(noticeId, reminderNo) };
}

/**
 * `communication:ack-reminders`: the hourly dispatcher; for each active society whose local time is 10:00 it reminds the notices that are due
 * (`ackReminderHours` after publish or the last reminder, at most `ackMaxReminders`, never after `ackDueAt`). The counters are compared in the UPDATE.
 */
export async function runAckReminders(
  at: Date = now(),
  opts: { forceHour?: boolean } = {},
): Promise<{ reminded: number }> {
  const states = await societyStatuses();
  let reminded = 0;
  for (const [societyId, st] of states) {
    if (!isJobAllowed(st.status, 'normal')) continue;
    if (!opts.forceHour && localHour(at, st.tz) !== 10) continue;
    const hours =
      Number(await settings.get(societyId, SETTING.ackReminderHours as never).catch(() => 48)) || 48;
    const max = Number(await settings.get(societyId, SETTING.ackMaxReminders as never).catch(() => 3)) || 3;
    const notices = await Notice.findAll({
      where: {
        societyId,
        status: 'PUBLISHED',
        requiresAck: true,
        remindersSent: { [Op.lt]: max },
        publishedAt: { [Op.ne]: null },
        [Op.or]: [{ ackDueAt: null }, { ackDueAt: { [Op.gt]: at } }],
      },
      limit: BATCH,
    });
    for (const n of notices) {
      const since = n.lastRemindedAt ?? n.publishedAt!;
      if (addHours(since, hours).getTime() > at.getTime() + 60_000) continue; // 10:00 slot tolerance of one minute
      const [affected] = await Notice.update(
        { remindersSent: n.remindersSent + 1, lastRemindedAt: at },
        { where: { id: n.id, status: 'PUBLISHED', remindersSent: n.remindersSent } },
      );
      if (!affected) continue;
      try {
        await sendAckReminder(n.id, n.remindersSent + 1);
        await audit(jobCtx(societyId), {
          action: AUDIT.noticeReminded,
          entityType: ENTITY.notice,
          entityId: n.id,
          societyId,
          actor: SYSTEM_ACTOR,
          after: { reminderNo: n.remindersSent + 1, automatic: true },
        });
        reminded += 1;
      } catch (err) {
        logger.error({ err, noticeId: n.id }, 'acknowledgement reminder failed');
      }
    }
  }
  return { reminded };
}

// ------------------------------------------------------------------ utility-reminders (every 5 minutes, BR-16-16)
export async function runUtilityReminders(at: Date = now()): Promise<{ sent: number }> {
  const due = await Notice.findAll({
    where: {
      status: 'PUBLISHED',
      kind: 'UTILITY_SHUTDOWN',
      startReminderSentAt: null,
      restoredAt: null,
      outageStartsAt: { [Op.gt]: at, [Op.lte]: addHours(at, 2) },
    },
    limit: BATCH,
  });
  const states = await societyStatuses([...new Set(due.map(d => d.societyId))]);
  let sent = 0;
  for (const n of due) {
    const st = states.get(n.societyId);
    if (!st || !isJobAllowed(st.status, 'normal')) continue;
    // published more than 2 hours before the start (BR-16-16)
    if (
      n.publishedAt &&
      n.outageStartsAt &&
      n.publishedAt.getTime() > n.outageStartsAt.getTime() - 2 * 3_600_000
    )
      continue;
    const [affected] = await Notice.update(
      { startReminderSentAt: at },
      { where: { id: n.id, startReminderSentAt: null, status: 'PUBLISHED' } },
    );
    if (!affected) continue;
    const receipts = await NoticeReceipt.findAll({
      where: { noticeId: n.id, userId: { [Op.ne]: null } },
      attributes: ['userId'],
    });
    const userIds = [...new Set(receipts.map(r => r.userId!))];
    if (userIds.length)
      await notify(
        NOTIFY.utilityStarting,
        userIds,
        {
          noticeId: n.id,
          title: n.title,
          utilityType: n.utilityType ?? 'UTILITY',
          startsAt: n.outageStartsAt!,
        },
        {
          societyId: n.societyId,
          dedupeKey: `notice:${n.id}:utility-start`,
          sourceType: ENTITY.notice,
          sourceId: n.id,
        },
      );
    sent += 1;
  }
  return { sent };
}
