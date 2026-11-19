import { Op } from 'sequelize';
import { EmergencyBroadcast, InboxItem, Survey, SurveyResponse, sequelize } from '../../models';
import { addHours, now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { isJobAllowed } from '../societies/societies.guard';
import { AUDIT, ENTITY, NOTIFY, RT } from './communication.constants';
import { notify } from './communication.core';
import { resolveAudience } from './communication.audience';
import { assertSurveyTransition, resolveReminderDue, surveyReminderDue } from './communication.state';
import { SYSTEM_ACTOR, jobCtx, societyStatuses } from './communication.jobs.common';
import type { NoticeAudience } from './communication.types';

const BATCH = 200;

// ------------------------------------------------------------------ emergency-resolve-reminder (every 5 minutes, tag `safety`, BR-16-43)
export async function runEmergencyResolveReminder(at: Date = now()): Promise<{ reminded: number }> {
  const active = await EmergencyBroadcast.findAll({ where: { status: 'ACTIVE' }, limit: BATCH });
  const states = await societyStatuses([...new Set(active.map(a => a.societyId))]);
  let reminded = 0;
  for (const b of active) {
    const st = states.get(b.societyId);
    if (!st || !isJobAllowed(st.status, 'safety')) continue;
    if (!resolveReminderDue(b, at)) continue;
    const [affected] = await EmergencyBroadcast.update(
      { lastResolveReminderAt: at },
      {
        where: {
          id: b.id,
          status: 'ACTIVE',
          lastResolveReminderAt: b.lastResolveReminderAt === null ? null : b.lastResolveReminderAt,
        },
      },
    );
    if (!affected) continue;
    try {
      await notify(
        NOTIFY.emergencyResolveReminder,
        [b.startedBy],
        { broadcastId: b.id, title: b.title },
        {
          societyId: b.societyId,
          dedupeKey: `emergency:${b.id}:resolve-reminder:${at.getTime()}`,
          sourceType: ENTITY.emergency,
          sourceId: b.id,
        },
      );
      reminded += 1;
    } catch (err) {
      logger.error({ err, broadcastId: b.id }, 'resolve reminder failed');
    }
  }
  return { reminded };
}

// ------------------------------------------------------------------ survey-close (every 5 minutes)
const audienceOf = (s: Survey): NoticeAudience => ({
  type: s.audienceType as NoticeAudience['type'],
  relation: s.audienceRelation,
  ids: s.audienceIds ?? undefined,
});

async function closeSurvey(id: number, at: Date): Promise<Survey | null> {
  return sequelize.transaction(async t => {
    const s = await Survey.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!s || s.status !== 'OPEN' || !s.closesAt || s.closesAt.getTime() > at.getTime()) return null;
    assertSurveyTransition('OPEN', 'close');
    await s.update({ status: 'CLOSED', closedAt: at, version: s.version + 1 }, { transaction: t });
    await audit(
      jobCtx(s.societyId),
      {
        action: AUDIT.surveyClosed,
        entityType: ENTITY.survey,
        entityId: s.id,
        societyId: s.societyId,
        actor: SYSTEM_ACTOR,
        after: { status: 'CLOSED', responseCount: s.responseCount, automatic: true },
      },
      t,
    );
    t.afterCommit(() =>
      emitToRoom(`society:${s.societyId}:admin`, RT.surveyResponseCount, {
        surveyId: s.id,
        responseCount: s.responseCount,
      }),
    );
    return s;
  });
}

/** Users to remind: named surveys skip people with a response, anonymous ones skip people whose survey inbox item is read (anonymity: no response link exists). */
async function reminderUsers(s: Survey): Promise<number[]> {
  const aud = await resolveAudience(s.societyId, audienceOf(s));
  if (!aud.userIds.length) return [];
  if (!s.isAnonymous) {
    const done = await SurveyResponse.findAll({
      where: { surveyId: s.id, userId: { [Op.in]: aud.userIds } },
      attributes: ['userId'],
      group: ['userId'],
    });
    const skip = new Set(done.map(d => d.userId));
    return aud.userIds.filter(u => !skip.has(u));
  }
  const read = await InboxItem.findAll({
    where: {
      userId: { [Op.in]: aud.userIds },
      templateKey: NOTIFY.surveyPublished,
      deepLink: `/surveys/${s.id}`,
      readAt: { [Op.ne]: null },
    },
    attributes: ['userId'],
  });
  const skip = new Set(read.map(r => r.userId));
  return aud.userIds.filter(u => !skip.has(u));
}

export async function runSurveyClose(at: Date = now()): Promise<{ closed: number; reminded: number }> {
  let closed = 0;
  let reminded = 0;
  const due = await Survey.findAll({ where: { status: 'OPEN', closesAt: { [Op.lte]: at } }, limit: BATCH });
  const states = await societyStatuses([...new Set(due.map(d => d.societyId))]);
  for (const d of due) {
    const st = states.get(d.societyId);
    if (!st || !isJobAllowed(st.status, 'normal')) continue;
    const s = await closeSurvey(d.id, at);
    if (!s) continue;
    closed += 1;
    if (!s.isAnonymous && s.resultsVisibility !== 'ADMINS') {
      const rows = await SurveyResponse.findAll({
        where: { surveyId: s.id, userId: { [Op.ne]: null } },
        attributes: ['userId'],
        group: ['userId'],
      });
      const userIds = rows.map(r => r.userId!);
      if (userIds.length)
        await notify(
          NOTIFY.surveyClosed,
          userIds,
          { surveyId: s.id, title: s.title },
          {
            societyId: s.societyId,
            dedupeKey: `survey:${s.id}:closed`,
            sourceType: ENTITY.survey,
            sourceId: s.id,
          },
        ).catch(err => logger.error({ err, surveyId: s.id }, 'survey closed notification failed'));
    }
  }
  const soon = await Survey.findAll({
    where: { status: 'OPEN', reminderSentAt: null, closesAt: { [Op.gt]: at, [Op.lte]: addHours(at, 24) } },
    limit: BATCH,
  });
  const states2 = await societyStatuses([...new Set(soon.map(d => d.societyId))]);
  for (const s of soon) {
    const st = states2.get(s.societyId);
    if (!st || !isJobAllowed(st.status, 'normal')) continue;
    if (!surveyReminderDue({ closesAt: s.closesAt!, reminderSentAt: s.reminderSentAt }, at)) continue;
    const [affected] = await Survey.update(
      { reminderSentAt: at },
      { where: { id: s.id, status: 'OPEN', reminderSentAt: null } },
    );
    if (!affected) continue;
    try {
      const userIds = await reminderUsers(s);
      if (userIds.length)
        await notify(
          NOTIFY.surveyReminder,
          userIds,
          { surveyId: s.id, title: s.title, closesAt: s.closesAt! },
          {
            societyId: s.societyId,
            dedupeKey: `survey:${s.id}:reminder`,
            sourceType: ENTITY.survey,
            sourceId: s.id,
          },
        );
      reminded += 1;
    } catch (err) {
      logger.error({ err, surveyId: s.id }, 'survey reminder failed');
    }
  }
  return { closed, reminded };
}
