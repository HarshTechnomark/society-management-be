import { Op } from 'sequelize';
import { Society, SocietyLifecycleEvent, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import type { Ctx } from '../../types/context';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { setting } from './societies.ports';
import { JOBS, QUEUE } from './societies.types';
import { lockSociety, transition, writeEvent } from './societies.lifecycle';
import { groups, notifyAfterCommit, send } from './societies.notify';
import { buildExport, expireExports } from './societies.exports';
import { expireDue, expireOne, flushRequestCounts } from './societies.support-access';
import { runFinancialRetention, runPurge } from './societies.purge';
import { runComputeHealth } from './societies.health';

/** Jobs of section 9.1 (queue `societies`). Every processor re-reads the rows and exits when the work is done. */

const JOB: Ctx = { requestId: 'job', ip: '', userAgent: '' };
const DAY = 86_400_000;

/** `societies:expire-trials`: TRIAL past `trialEndsAt` without a paid subscription → SUSPENDED (TRIAL_EXPIRED). */
export async function expireTrials(): Promise<number> {
  const rows = await Society.findAll({
    where: { status: 'TRIAL', trialEndsAt: { [Op.lte]: now() } },
    attributes: ['id'],
  });
  let n = 0;
  for (const r of rows)
    await sequelize.transaction(async t => {
      const s = await lockSociety(r.id!, t);
      if (s.status !== 'TRIAL' || !s.trialEndsAt || s.trialEndsAt > now()) return;
      if (await subscriptions.hasPaidSubscription(s.id!, t)) return;
      if (
        await transition(
          JOB,
          s,
          {
            to: 'SUSPENDED',
            triggerSource: 'SYSTEM_JOB',
            triggerCode: 'TRIAL_EXPIRED',
            manual: false,
            suspensionCause: 'TRIAL_EXPIRED',
          },
          t,
        )
      )
        n++;
    });
  return n;
}

/** `societies:trial-reminders` (daily 10:00): 7, 3 and 1 days left; one reminder per society and day count. */
export async function trialReminders(): Promise<number> {
  const today = istDate(now());
  const rows = await Society.findAll({ where: { status: 'TRIAL', trialEndsAt: { [Op.gt]: now() } } });
  let n = 0;
  for (const s of rows) {
    const daysLeft = Math.round((Date.parse(istDate(s.trialEndsAt!)) - Date.parse(today)) / DAY);
    if (![7, 3, 1].includes(daysLeft)) continue;
    const hit = await kv().slidingWindowHit(`trial-reminder:${s.id}:${daysLeft}`, 3 * DAY, 1);
    if (!hit.allowed) continue;
    await send('societies.trial_ending', await groups.billingAdmins(s.id!), {
      societyName: s.name,
      daysLeft,
      trialEndsAt: s.trialEndsAt!.toISOString(),
    });
    n++;
  }
  return n;
}

/** `societies:auto-close` (daily 03:00): BR-05-19 warnings 7 and 1 days ahead, then closure. MANUAL is never auto-closed. */
export async function autoClose(): Promise<{ warned: number; closed: number }> {
  const days = await setting('lifecycle.autoCloseSuspendedDays');
  if (days <= 0) return { warned: 0, closed: 0 };
  const rows = await Society.findAll({
    where: { status: 'SUSPENDED', suspensionCause: { [Op.in]: ['NON_PAYMENT', 'TRIAL_EXPIRED'] } },
    attributes: ['id'],
  });
  let warned = 0;
  let closed = 0;
  for (const r of rows)
    await sequelize.transaction(async t => {
      const s = await lockSociety(r.id!, t);
      if (s.status !== 'SUSPENDED' || !s.suspendedAt || s.suspensionCause === 'MANUAL') return;
      const closeAt = s.suspendedAt.getTime() + days * DAY;
      const left = Math.ceil((closeAt - now().getTime()) / DAY);
      if (left <= 0) {
        const ok = await transition(
          JOB,
          s,
          {
            to: 'CLOSED',
            triggerSource: 'SYSTEM_JOB',
            triggerCode: 'AUTO_CLOSE',
            manual: false,
            closureReason: s.suspensionCause === 'TRIAL_EXPIRED' ? 'TRIAL_NOT_CONVERTED' : 'NON_PAYMENT',
            reasonCategory: s.suspensionCause === 'TRIAL_EXPIRED' ? 'TRIAL_NOT_CONVERTED' : 'NON_PAYMENT',
          },
          t,
        );
        if (ok) closed++;
        return;
      }
      if (left !== 7 && left !== 1) return;
      const events = await SocietyLifecycleEvent.findAll({
        where: { societyId: s.id!, eventType: 'AUTO_CLOSE_WARNED', createdAt: { [Op.gte]: s.suspendedAt } },
        transaction: t,
      });
      if (events.some(e => (e.metadata as { daysLeft?: number } | null)?.daysLeft === left)) return;
      await writeEvent(
        JOB,
        s.id!,
        {
          eventType: 'AUTO_CLOSE_WARNED',
          fromStatus: 'SUSPENDED',
          toStatus: 'SUSPENDED',
          triggerSource: 'SYSTEM_JOB',
          triggerCode: 'AUTO_CLOSE',
          metadata: { daysLeft: left },
        },
        t,
      );
      const sid = s.id!;
      notifyAfterCommit(t, 'societies.auto_close_warning', () => groups.committee(sid), {
        societyName: s.name,
        daysLeft: left,
      });
      warned++;
    });
  return { warned, closed };
}

let registered = false;
export function registerSocietyJobs(): void {
  if (registered) return;
  registered = true;
  registerQueue(QUEUE, 'Society lifecycle, support access, exports, purge and health', 2);
  const run =
    (name: string, fn: (data: Record<string, unknown>) => Promise<unknown>) =>
    async (data: Record<string, unknown>) => {
      const r = await fn(data);
      logger.info({ job: name, result: r }, 'societies job done');
      return r;
    };
  registerProcessor(QUEUE, JOBS.expireTrials, run(JOBS.expireTrials, expireTrials));
  registerProcessor(QUEUE, JOBS.trialReminders, run(JOBS.trialReminders, trialReminders));
  registerProcessor(QUEUE, JOBS.autoClose, run(JOBS.autoClose, autoClose));
  registerProcessor(QUEUE, JOBS.purgeClosed, run(JOBS.purgeClosed, runPurge));
  registerProcessor(QUEUE, JOBS.buildExport, async data => buildExport(Number(data.exportId)));
  registerProcessor(QUEUE, JOBS.expireExports, run(JOBS.expireExports, expireExports));
  registerProcessor(QUEUE, JOBS.endSupportGrant, async data => expireOne(Number(data.grantId)));
  registerProcessor(
    QUEUE,
    JOBS.expireSupportGrants,
    run(JOBS.expireSupportGrants, async () => ({
      expired: await expireDue(),
      flushed: await flushRequestCounts(),
    })),
  );
  registerProcessor(
    QUEUE,
    JOBS.expireSupportConsents,
    run(JOBS.expireSupportConsents, () => expireDue()),
  );
  // yearly on 1 April 02:00 IST: the scheduler has no yearly cadence, so it runs daily and acts on 1 April only
  // (or when started by hand with `{ force: true }`, e.g. a retry from module 07)
  registerProcessor(
    QUEUE,
    JOBS.expireFinancialRetention,
    run(JOBS.expireFinancialRetention, async data =>
      data.force || istDate(now()).endsWith('-04-01') ? runFinancialRetention() : { skipped: true },
    ),
  );
  registerProcessor(QUEUE, JOBS.computeHealth, run(JOBS.computeHealth, runComputeHealth));

  registerRepeatable(QUEUE, JOBS.expireTrials, { everyMs: 15 * 60_000 });
  registerRepeatable(QUEUE, JOBS.trialReminders, { dailyAtIst: '10:00' });
  registerRepeatable(QUEUE, JOBS.autoClose, { dailyAtIst: '03:00' });
  registerRepeatable(QUEUE, JOBS.purgeClosed, { dailyAtIst: '03:30' });
  registerRepeatable(QUEUE, JOBS.expireExports, { hourlyAtMinute: 5 });
  registerRepeatable(QUEUE, JOBS.expireSupportGrants, { everyMs: 60_000 });
  registerRepeatable(QUEUE, JOBS.expireSupportConsents, { everyMs: 5 * 60_000 });
  registerRepeatable(QUEUE, JOBS.expireFinancialRetention, { dailyAtIst: '02:00' });
  registerRepeatable(QUEUE, JOBS.computeHealth, { dailyAtIst: '04:00' });
}
