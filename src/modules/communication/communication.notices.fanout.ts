import { Op } from 'sequelize';
import { Notice, NoticeReceipt, Society, sequelize } from '../../models';
import { addHours, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { systemCtx, type Ctx } from '../../types/context';
import { isJobAllowed } from '../societies/societies.guard';
import { AUDIT, utilityLabel, ENTITY, NOTIFY, SETTING, type Channel } from './communication.constants';
import { resolveAudience } from './communication.audience';
import { notify } from './communication.core';
import { assertNoticeTransition } from './communication.state';
import { doPublish, notifyUsers, noticeLink } from './communication.notices.publish';
import { n, settingNum } from './communication.notices.shared';

/** Jobs of part 16.1 (9.1): `notice-fanout`, `ack-remind-notice`, and the sweepers 16.4 registers (`notice-scheduler`, `notice-expiry`, `ack-reminders`, `utility-reminders`). */
const sysCtx = (societyId: number): Ctx => ({
  ...systemCtx('notice-job'),
  society: { id: societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
  permissions: new Set<string>(),
});

const chunk = <T>(a: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
  return out;
};

/** `communication:notice-fanout` (BR-16-4): writes the recipient snapshot, then notifies. Exits when `fanoutCompletedAt` is set. */
export async function runNoticeFanout(
  payload: Record<string, unknown>,
): Promise<{ receipts: number } | null> {
  const noticeId = n(payload.noticeId);
  const societyId = n(payload.societyId);
  const notice = await Notice.findOne({ where: { id: noticeId, societyId } });
  if (!notice || notice.fanoutCompletedAt || notice.status !== 'PUBLISHED') return null;
  const resolved = await resolveAudience(societyId, {
    type: notice.audienceType,
    relation: notice.audienceRelation,
    ids: notice.audienceIds ?? undefined,
    roleKeys: notice.audienceRoleKeys ?? undefined,
  });
  const rows = new Map<string, Record<string, unknown>>();
  for (const p of resolved.people) {
    const recipientKey = p.userId ? `u:${p.userId}:${p.unitId ?? 0}` : `r:${p.residentId}:${p.unitId ?? 0}`;
    if (rows.has(recipientKey)) continue;
    rows.set(recipientKey, {
      societyId,
      noticeId,
      recipientKey,
      userId: p.userId,
      residentId: p.residentId,
      unitId: p.unitId,
      relation: p.relation,
      createdBy: notice.publishedBy,
    });
  }
  for (const part of chunk([...rows.values()], 500))
    await NoticeReceipt.bulkCreate(part as never[], { ignoreDuplicates: true });

  const userIds = [...new Set(resolved.people.filter(p => p.userId).map(p => p.userId!))];
  const mobiles = [...new Set(resolved.people.filter(p => !p.userId && p.mobile).map(p => p.mobile!))];
  const extra = notice.channels ?? [];
  const template = notice.requiresAck ? NOTIFY.noticeAckRequired : NOTIFY.noticePublished;
  const data = {
    noticeId,
    title: notice.title,
    link: noticeLink(noticeId),
    ...(notice.requiresAck && notice.ackDueAt ? { ackDueAt: notice.ackDueAt.toISOString() } : {}),
  };
  const common = {
    societyId,
    dedupeKey: `notice:${noticeId}`,
    sourceType: 'notice',
    sourceId: noticeId,
    locale: notice.locale,
    urgent: notice.priority === 'HIGH',
  };
  const stamp = now();
  if (userIds.length) {
    const channels = ['IN_APP', 'PUSH', ...extra] as Channel[];
    for (const part of chunk(userIds, 5000)) await notify(template, part, data, { ...common, channels });
    await NoticeReceipt.update({ reachedAt: stamp, reachedVia: 'IN_APP' } as never, {
      where: { noticeId, userId: { [Op.ne]: null }, reachedAt: { [Op.is]: null } },
    });
  }
  const phoneChannels = extra.filter(c => c === 'SMS' || c === 'WHATSAPP') as Channel[];
  if (mobiles.length && phoneChannels.length) {
    for (const part of chunk(mobiles, 5000))
      await notify(
        template,
        part.map(mobile => ({ mobile })),
        data,
        { ...common, channels: phoneChannels },
      );
    const [first] = phoneChannels;
    await NoticeReceipt.update({ reachedAt: stamp, reachedVia: first } as never, {
      where: { noticeId, userId: { [Op.is]: null }, reachedAt: { [Op.is]: null } },
    });
  }
  const [recipientCount, reachedCount, unitRows] = await Promise.all([
    NoticeReceipt.count({ where: { noticeId } }),
    NoticeReceipt.count({ where: { noticeId, reachedAt: { [Op.ne]: null } } }),
    NoticeReceipt.findAll({
      where: { noticeId, unitId: { [Op.ne]: null } },
      attributes: ['unitId'],
      group: ['unitId'],
    }),
  ]);
  await Notice.update(
    { recipientCount, unitCount: unitRows.length, reachedCount, fanoutCompletedAt: stamp } as never,
    { where: { id: noticeId, fanoutCompletedAt: { [Op.is]: null } } },
  );
  return { receipts: recipientCount };
}

/** Notifies the unacknowledged receipts of a notice (manual or automatic reminder) and marks the receipts. */
async function sendReminder(notice: Notice, reminderNo: number): Promise<number> {
  const societyId = n(notice.societyId);
  const pending = await NoticeReceipt.findAll({
    where: { noticeId: n(notice.id), userId: { [Op.ne]: null }, acknowledgedAt: { [Op.is]: null } },
    attributes: ['id', 'userId'],
  });
  const userIds = [...new Set(pending.map(r => n(r.userId)))];
  if (!userIds.length) return 0;
  await notifyUsers(
    societyId,
    NOTIFY.noticeAckReminder,
    userIds,
    {
      noticeId: n(notice.id),
      title: notice.title,
      link: noticeLink(n(notice.id)),
      ...(notice.ackDueAt ? { ackDueAt: notice.ackDueAt.toISOString() } : {}),
    },
    `ack-rem:${n(notice.id)}:${reminderNo}`,
  );
  await NoticeReceipt.update(
    { remindersSent: sequelize.literal('remindersSent + 1'), lastRemindedAt: now() } as never,
    { where: { id: { [Op.in]: pending.map(r => n(r.id)) } } },
  );
  return userIds.length;
}

/** `communication:ack-remind-notice` (manual remind, 8.13). */
export async function runAckRemindNotice(payload: Record<string, unknown>): Promise<number> {
  const notice = await Notice.findOne({
    where: { id: n(payload.noticeId), societyId: n(payload.societyId) },
  });
  if (!notice || notice.status !== 'PUBLISHED' || !notice.requiresAck) return 0;
  return sendReminder(notice, n(payload.reminderNo));
}

/** `communication:ack-reminders` (BR-16-12): automatic reminders, optionally for one society. Returns the number of notices reminded. */
export async function runAckReminders(o: { societyId?: number } = {}): Promise<number> {
  const at = now();
  const candidates = await Notice.findAll({
    where: {
      status: 'PUBLISHED',
      requiresAck: true,
      publishedAt: { [Op.ne]: null },
      ...(o.societyId ? { societyId: o.societyId } : {}),
    },
  });
  let done = 0;
  for (const notice of candidates) {
    const societyId = n(notice.societyId);
    if (notice.ackDueAt && notice.ackDueAt.getTime() <= at.getTime()) continue;
    const society = await Society.findByPk(societyId, { attributes: ['id', 'status'] });
    if (!society || !isJobAllowed(society.status as string, 'normal') || society.status === 'CLOSED')
      continue;
    const hours = await settingNum(societyId, SETTING.ackReminderHours);
    const max = await settingNum(societyId, SETTING.ackMaxReminders);
    if (n(notice.remindersSent) >= max) continue;
    const base = notice.lastRemindedAt ?? notice.publishedAt!;
    if (addHours(base, hours).getTime() > at.getTime()) continue;
    const reminderNo = n(notice.remindersSent) + 1;
    const [claimed] = await Notice.update({ remindersSent: reminderNo, lastRemindedAt: at } as never, {
      where: { id: notice.id, remindersSent: n(notice.remindersSent) },
    });
    if (!claimed) continue;
    await sendReminder(notice, reminderNo);
    done += 1;
  }
  return done;
}

/** Publishes one SCHEDULED notice that is due (hook `publishScheduledNotice` of 16.4's scheduler job). Returns false when it is no longer due. */
export async function publishScheduledNotice(
  societyId: number,
  noticeId: number,
  at: Date,
): Promise<boolean> {
  return sequelize.transaction(async t => {
    const notice = await Notice.findOne({
      where: { id: noticeId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (
      !notice ||
      notice.status !== 'SCHEDULED' ||
      !notice.scheduledAt ||
      notice.scheduledAt.getTime() > at.getTime()
    )
      return false;
    await doPublish(sysCtx(societyId), notice, t, { scheduler: true });
    return true;
  });
}

/** `communication:notice-scheduler` (every minute): SCHEDULED notices due now are published; societies refused by `isJobAllowed` wait. */
export async function runNoticeScheduler(): Promise<number> {
  const due = await Notice.findAll({
    where: { status: 'SCHEDULED', scheduledAt: { [Op.lte]: now() } },
    attributes: ['id', 'societyId'],
    order: [['scheduledAt', 'ASC']],
    limit: 200,
  });
  let published = 0;
  for (const d of due) {
    const societyId = n(d.societyId);
    const society = await Society.findByPk(societyId, { attributes: ['id', 'status'] });
    if (!society || !isJobAllowed(society.status as string, 'normal') || society.status === 'CLOSED')
      continue;
    const did = await publishScheduledNotice(societyId, n(d.id), now());
    if (did) published += 1;
  }
  return published;
}

/** `communication:notice-expiry` (every 15 minutes): PUBLISHED with `expiresAt` in the past become EXPIRED and unpinned. */
export async function runNoticeExpiry(): Promise<number> {
  const due = await Notice.findAll({
    where: { status: 'PUBLISHED', expiresAt: { [Op.lte]: now() } },
    attributes: ['id', 'societyId'],
    limit: 500,
  });
  let expired = 0;
  for (const d of due) {
    const societyId = n(d.societyId);
    const ok = await sequelize
      .transaction(async t => {
        const notice = await Notice.findOne({
          where: { id: d.id, societyId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (
          !notice ||
          notice.status !== 'PUBLISHED' ||
          !notice.expiresAt ||
          notice.expiresAt.getTime() > now().getTime()
        )
          return false;
        assertNoticeTransition(notice.status, 'expire');
        await notice.update(
          {
            status: 'EXPIRED',
            expiredAt: now(),
            isPinned: false,
            pinnedAt: null,
            version: n(notice.version) + 1,
          } as never,
          { transaction: t },
        );
        await audit(
          sysCtx(societyId),
          { action: AUDIT.noticeExpired, entityType: ENTITY.notice, entityId: n(notice.id), societyId },
          t,
        );
        return true;
      })
      .catch(err => {
        logger.error({ err, noticeId: n(d.id) }, 'notice expiry failed');
        return false;
      });
    if (ok) expired += 1;
  }
  return expired;
}

/** `communication:utility-reminders` (every 5 minutes, BR-16-16): one reminder 2 hours before the outage, if the notice was published more than 2 hours before it. */
export async function runUtilityReminders(): Promise<number> {
  const at = now();
  const soon = addHours(at, 2);
  const due = await Notice.findAll({
    where: {
      kind: 'UTILITY_SHUTDOWN',
      status: 'PUBLISHED',
      restoredAt: { [Op.is]: null },
      startReminderSentAt: { [Op.is]: null },
      outageStartsAt: { [Op.gt]: at, [Op.lte]: soon },
    },
    limit: 200,
  });
  let sent = 0;
  for (const notice of due) {
    if (!notice.publishedAt || addHours(notice.publishedAt, 2).getTime() > notice.outageStartsAt!.getTime()) {
      await Notice.update({ startReminderSentAt: at } as never, {
        where: { id: notice.id, startReminderSentAt: { [Op.is]: null } },
      });
      continue; // published less than 2 hours before the start: no reminder
    }
    const [claimed] = await Notice.update({ startReminderSentAt: at } as never, {
      where: { id: notice.id, startReminderSentAt: { [Op.is]: null } },
    });
    if (!claimed) continue;
    const societyId = n(notice.societyId);
    const userIds = [
      ...new Set(
        (
          await NoticeReceipt.findAll({
            where: { noticeId: n(notice.id), userId: { [Op.ne]: null } },
            attributes: ['userId'],
          })
        ).map(r => n(r.userId)),
      ),
    ];
    if (!userIds.length) continue;
    await notifyUsers(
      societyId,
      NOTIFY.utilityStarting,
      userIds,
      {
        noticeId: n(notice.id),
        title: notice.title,
        utilityType: utilityLabel(notice.utilityType),
        startsAt: notice.outageStartsAt!.toISOString(),
      },
      `util-start:${n(notice.id)}`,
    );
    sent += 1;
  }
  return sent;
}
