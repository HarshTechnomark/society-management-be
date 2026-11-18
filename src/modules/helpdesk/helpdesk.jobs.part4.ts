import { Op } from 'sequelize';
import { Society, Ticket, TicketComment, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { enqueue, registerProcessor, registerRepeatable } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { systemCtx, type Ctx } from '../../types/context';
import { isJobAllowed } from '../societies/societies.guard';
import type { JobTag } from '../societies/societies.types';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { ENT, HELPDESK_QUEUE, JOBS, NON_TERMINAL, NOTIFY, SETTING } from './helpdesk.constants';
import { evaluateTicketSla } from './helpdesk.escalation';
import { runFanout, type FanoutPayload } from './helpdesk.fanout';
import { adminLink, editorIds, residentLink, sendTo, ticketData } from './helpdesk.notify';
import {
  enqueueEscalationNotify,
  registerHelpdeskNotifications,
  runEscalationNotify,
} from './helpdesk.notify.listener';
import { ensureSeededOnce } from './helpdesk.seed';
import { addTimeline, lockTicket, setting, systemActor } from './helpdesk.shared';
import { transitionTicket } from './helpdesk.tickets.transition';

/** Section 9.1: the jobs of queue `helpdesk`. Tickets change only through the core (`transitionTicket` as the system actor, `evaluateTicketSla`). */

const HOUR = 3_600_000;
const SWEEP_LIMIT = 500;
export const FIFTEEN_MINUTES = 15 * 60_000;

/** The context of a job working for one society (actor `system`). */
export const jobCtx = (societyId: number, requestId = 'helpdesk-job'): Ctx => ({
  ...systemCtx(requestId),
  society: { id: societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});

async function statusMap(ids?: number[]): Promise<Map<number, string>> {
  const rows = await Society.findAll({
    attributes: ['id', 'status'],
    ...(ids ? { where: { id: { [Op.in]: ids } } } : {}),
  });
  return new Map(rows.map(r => [r.id!, String(r.status)]));
}

/** Societies a job with this tag may touch (BR-05-14): suspended and closed societies are skipped for `normal` jobs. */
export async function allowedSocieties(tag: JobTag = 'normal'): Promise<number[]> {
  return [...(await statusMap())].filter(([, s]) => isJobAllowed(s, tag)).map(([id]) => id);
}
export async function societyAllowed(societyId: number, tag: JobTag): Promise<boolean> {
  const s = (await statusMap([societyId])).get(societyId);
  return s !== undefined && isJobAllowed(s, tag);
}

// ------------------------------------------------------------------ sla-sweep (6.4)
let sweeping = false;
export async function runSlaSweep(
  at: Date = now(),
): Promise<{ checked: number; skipped: number; fired: number }> {
  if (sweeping) return { checked: 0, skipped: 0, fired: 0 };
  sweeping = true;
  try {
    const due = await Ticket.findAll({
      where: { nextSlaCheckAt: { [Op.lte]: at } },
      attributes: ['id', 'societyId'],
      order: [['nextSlaCheckAt', 'ASC']],
      limit: SWEEP_LIMIT,
    });
    const status = await statusMap([...new Set(due.map(d => d.societyId))]);
    let checked = 0;
    let skipped = 0;
    let fired = 0;
    for (const d of due) {
      if (!isJobAllowed(status.get(d.societyId) ?? 'CLOSED', 'normal')) {
        skipped += 1;
        continue;
      }
      try {
        const f = await evaluateTicketSla(d.id, at);
        checked += 1;
        fired += f.length;
        if (f.length) await enqueueEscalationNotify(d.id, d.societyId);
      } catch (err) {
        logger.error({ err, ticketId: d.id }, 'helpdesk:sla-sweep failed for a ticket');
      }
    }
    return { checked, skipped, fired };
  } finally {
    sweeping = false;
  }
}

// ------------------------------------------------------------------ auto-close (BR-15-40)
export async function runAutoClose(at: Date = now(), societyIds?: number[]): Promise<number> {
  let closed = 0;
  for (const societyId of societyIds ?? (await allowedSocieties())) {
    try {
      if (!(await isFeatureOn(societyId, ENT.autoClose))) continue;
      const hours = await setting<number>(societyId, SETTING.autoCloseHours);
      const rows = await Ticket.findAll({
        where: {
          societyId,
          status: 'RESOLVED',
          resolvedAt: { [Op.lte]: new Date(at.getTime() - hours * HOUR) },
        },
        attributes: ['id'],
        order: [['resolvedAt', 'ASC']],
        limit: 500,
      });
      const ctx = jobCtx(societyId, 'helpdesk-auto-close');
      for (const r of rows) {
        try {
          const done = await sequelize.transaction(async t => {
            const ticket = await lockTicket(societyId, r.id, t);
            if (ticket.status !== 'RESOLVED') return false; // closed or reopened meanwhile (BR-01-14)
            await transitionTicket(ctx, r.id, systemActor(ctx), { action: 'CLOSE' }, t);
            return true;
          });
          if (done) closed += 1;
        } catch (err) {
          logger.error({ err, ticketId: r.id }, 'helpdesk:auto-close failed for a ticket');
        }
      }
    } catch (err) {
      logger.error({ err, societyId }, 'helpdesk:auto-close failed for a society');
    }
  }
  return closed;
}

// ------------------------------------------------------------------ waiting-followup (BR-15-44)
export async function runWaitingFollowup(
  at: Date = now(),
  societyIds?: number[],
): Promise<{ reminded: number; resolved: number; expired: number }> {
  const out = { reminded: 0, resolved: 0, expired: 0 };
  for (const societyId of societyIds ?? (await allowedSocieties())) {
    try {
      const [reminderH, autoDays] = await Promise.all([
        setting<number>(societyId, SETTING.waitingReminderHours),
        setting<number>(societyId, SETTING.waitingAutoResolveDays),
      ]);
      const ctx = jobCtx(societyId, 'helpdesk-waiting-followup');
      const waiting = await Ticket.findAll({
        where: {
          societyId,
          status: 'WAITING_ON_RESIDENT',
          slaPausedAt: { [Op.ne]: null, [Op.lte]: new Date(at.getTime() - reminderH * HOUR) },
        },
        attributes: ['id'],
        limit: 500,
      });
      for (const w of waiting) {
        try {
          const result = await sequelize.transaction(async t => {
            const ticket = await lockTicket(societyId, w.id, t);
            if (ticket.status !== 'WAITING_ON_RESIDENT' || !ticket.slaPausedAt) return null; // re-check under lock
            const waitedMs = at.getTime() - ticket.slaPausedAt.getTime();
            if (waitedMs >= autoDays * 24 * HOUR) {
              if (ticket.waitingReason === 'ESTIMATE_APPROVAL') {
                await Ticket.update(
                  { chargeStatus: 'REJECTED', chargeDecidedAt: at },
                  { where: { id: ticket.id }, transaction: t },
                );
                await transitionTicket(
                  ctx,
                  ticket.id,
                  systemActor(ctx),
                  { action: 'RESUME', note: 'Estimate expired' },
                  t,
                );
                return 'expired' as const;
              }
              if (ticket.chargeStatus === 'APPROVED') return null; // a final charge is needed: the assignee resolves it
              await transitionTicket(
                ctx,
                ticket.id,
                systemActor(ctx),
                {
                  action: 'RESOLVE',
                  note: `Resolved automatically: no response from the resident in ${autoDays} days`,
                },
                t,
              );
              return 'resolved' as const;
            }
            if (ticket.waitingReminderSentAt) return null;
            const [n] = await Ticket.update(
              { waitingReminderSentAt: at },
              { where: { id: ticket.id, waitingReminderSentAt: null }, transaction: t },
            );
            return n ? ('reminded' as const) : null;
          });
          if (!result) continue;
          out[result === 'reminded' ? 'reminded' : result] += 1;
          const ticket = await Ticket.findByPk(w.id);
          if (!ticket) continue;
          const base = await ticketData(ticket);
          if (result === 'reminded' && ticket.requesterUserId)
            await sendTo(NOTIFY.waitingReminder, [ticket.requesterUserId], {
              ...base,
              link: residentLink(ticket.id),
            });
          if (result === 'expired')
            await sendTo(
              NOTIFY.estimateDecided,
              [
                ...new Set([
                  ...(ticket.assigneeUserId ? [ticket.assigneeUserId] : []),
                  ...(await editorIds(societyId)),
                ]),
              ],
              { ...base, decision: 'expired', link: adminLink(ticket.id) },
            );
        } catch (err) {
          logger.error({ err, ticketId: w.id }, 'helpdesk:waiting-followup failed for a ticket');
        }
      }
    } catch (err) {
      logger.error({ err, societyId }, 'helpdesk:waiting-followup failed for a society');
    }
  }
  return out;
}

// ------------------------------------------------------------------ unassigned-reminder (9.1)
export async function runUnassignedReminder(at: Date = now(), societyIds?: number[]): Promise<number> {
  let sent = 0;
  for (const societyId of societyIds ?? (await allowedSocieties())) {
    try {
      const minutes = await setting<number>(societyId, SETTING.unassignedReminderMinutes);
      const rows = await Ticket.findAll({
        where: {
          societyId,
          status: { [Op.in]: ['OPEN', 'REOPENED'] },
          assigneeUserId: null,
          currentAssignmentId: null,
          slaStartAt: { [Op.lte]: new Date(at.getTime() - minutes * 60_000) },
        },
        attributes: ['id'],
        limit: 500,
      });
      const ctx = jobCtx(societyId, 'helpdesk-unassigned');
      for (const r of rows) {
        try {
          const claimed = await sequelize.transaction(async t => {
            const ticket = await lockTicket(societyId, r.id, t);
            if (!['OPEN', 'REOPENED'].includes(ticket.status) || ticket.assigneeUserId) return false;
            const prior = await TicketComment.findAll({
              where: {
                ticketId: ticket.id,
                kind: 'SYSTEM',
                visibility: 'INTERNAL',
                slaCycle: ticket.slaCycle,
              },
              attributes: ['metadata'],
              transaction: t,
            });
            if (prior.some(p => (p.metadata as Record<string, unknown> | null)?.reminder === 'UNASSIGNED'))
              return false;
            await addTimeline(
              societyId,
              ticket.id,
              systemActor(ctx),
              {
                kind: 'SYSTEM',
                visibility: 'INTERNAL',
                body: `Reminder sent: no assignee after ${minutes} minutes`,
                slaCycle: ticket.slaCycle,
                metadata: { reminder: 'UNASSIGNED' },
              },
              t,
            );
            return true;
          });
          if (!claimed) continue;
          const ticket = await Ticket.findByPk(r.id);
          if (!ticket) continue;
          const base = await ticketData(ticket);
          await sendTo(NOTIFY.unassignedReminder, await editorIds(societyId), {
            ...base,
            minutes,
            link: adminLink(ticket.id),
          });
          sent += 1;
        } catch (err) {
          logger.error({ err, ticketId: r.id }, 'helpdesk:unassigned-reminder failed for a ticket');
        }
      }
    } catch (err) {
      logger.error({ err, societyId }, 'helpdesk:unassigned-reminder failed for a society');
    }
  }
  return sent;
}

// ------------------------------------------------------------------ daily-digest (9.1)
export async function runDailyDigest(societyId: number, localDate: string): Promise<boolean> {
  const live = { societyId, status: { [Op.in]: [...NON_TERMINAL] } };
  const open = await Ticket.count({ where: live });
  if (!open) return false;
  const [breached, unassigned, p1Rows] = await Promise.all([
    Ticket.count({ where: { ...live, [Op.or]: [{ responseBreached: true }, { resolutionBreached: true }] } }),
    Ticket.count({ where: { societyId, status: { [Op.in]: ['OPEN', 'REOPENED'] }, assigneeUserId: null } }),
    Ticket.findAll({
      where: { ...live, priority: 'P1' },
      attributes: ['ticketNo', 'title'],
      order: [['id', 'ASC']],
      limit: 10,
    }),
  ]);
  const p1 = await Ticket.count({ where: { ...live, priority: 'P1' } });
  await sendTo(NOTIFY.dailyDigest, await editorIds(societyId), {
    date: localDate,
    open,
    breached,
    unassigned,
    p1,
    p1List: p1Rows.map(r => `${r.ticketNo} ${r.title}`),
    link: '/admin/issues',
  });
  return true;
}

/** 09:00 tick: one digest job per society and local date (`digest:<societyId>:<localDate>`). */
export async function enqueueDigests(at: Date = now()): Promise<number> {
  const date = istDate(at);
  const ids = await allowedSocieties();
  for (const societyId of ids)
    await enqueue(
      HELPDESK_QUEUE,
      JOBS.dailyDigest,
      { societyId, date },
      { jobId: `digest:${societyId}:${date}` },
    );
  return ids.length;
}

/** `helpdesk:seed` on the first helpdesk call of a society (the services also seed lazily). */
export const enqueueSeed = (societyId: number): Promise<void> =>
  enqueue(HELPDESK_QUEUE, JOBS.seed, { societyId }, { jobId: `seed:${societyId}` });

export function registerHelpdeskJobsPart4(): void {
  registerHelpdeskNotifications();
  registerProcessor(HELPDESK_QUEUE, JOBS.slaSweep, async () => void (await runSlaSweep()));
  registerRepeatable(HELPDESK_QUEUE, JOBS.slaSweep, { everyMs: 60_000 });
  registerProcessor(HELPDESK_QUEUE, JOBS.autoClose, async () => void (await runAutoClose()));
  registerRepeatable(HELPDESK_QUEUE, JOBS.autoClose, { everyMs: FIFTEEN_MINUTES });
  registerProcessor(HELPDESK_QUEUE, JOBS.waitingFollowup, async () => void (await runWaitingFollowup()));
  registerRepeatable(HELPDESK_QUEUE, JOBS.waitingFollowup, { everyMs: FIFTEEN_MINUTES });
  registerProcessor(
    HELPDESK_QUEUE,
    JOBS.unassignedReminder,
    async () => void (await runUnassignedReminder()),
  );
  registerRepeatable(HELPDESK_QUEUE, JOBS.unassignedReminder, { everyMs: FIFTEEN_MINUTES });
  registerProcessor(HELPDESK_QUEUE, JOBS.fanout, async data => {
    const p = data as unknown as FanoutPayload;
    if (await societyAllowed(Number(p.societyId), 'safety')) await runFanout(p); // runs for suspended societies (tag safety)
  });
  registerProcessor(HELPDESK_QUEUE, JOBS.escalationNotify, async data => {
    if (await societyAllowed(Number(data.societyId), 'normal'))
      await runEscalationNotify({ ticketId: Number(data.ticketId), commentId: Number(data.commentId) });
  });
  registerProcessor(HELPDESK_QUEUE, JOBS.dailyDigest, async data => {
    if (data.societyId === undefined) return void (await enqueueDigests()); // the 09:00 repeatable
    if (await societyAllowed(Number(data.societyId), 'normal'))
      await runDailyDigest(Number(data.societyId), String(data.date ?? istDate()));
  });
  registerRepeatable(HELPDESK_QUEUE, JOBS.dailyDigest, { dailyAtIst: '09:00' });
  registerProcessor(HELPDESK_QUEUE, JOBS.seed, async data => {
    await ensureSeededOnce(Number(data.societyId));
  });
}
