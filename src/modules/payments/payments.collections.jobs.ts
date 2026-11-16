import { Collection } from '../../models';
import { logger } from '../../lib/logger';
import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { systemCtx, type Ctx } from '../../types/context';
import { addDaysYmd } from '../billing/billing.calc.period';
import { societyToday } from '../billing/billing.runs.shared';
import { PAYMENTS_QUEUE } from './payments.constants';
import {
  closeCollection,
  registerCollectionApprovalType,
  remindCollection,
} from './payments.collections.workflow';

/**
 * Sub-module 12.5 start-up (`registerCollections()`, called by `registerPaymentJobs`): the `COLLECTION_PUBLISH` approval type,
 * and the jobs `collections:auto-close` (00:30 IST: optional collections
 * past their due date) and `collections:due-reminders` (09:30 IST: one automatic reminder the day before the due date).
 * Mandatory collections are never auto-closed: their invoices stay due. Idempotent.
 */
export const COLLECTION_JOBS = {
  autoClose: 'collections:auto-close',
  dueReminders: 'collections:due-reminders',
} as const;

const jobCtx = (societyId: number): Ctx => ({
  ...systemCtx('collections-job'),
  society: { id: societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});

/** Closes the optional published collections of every society whose due date is before the society's today. */
export async function runAutoClose(): Promise<number> {
  const rows = await Collection.findAll({
    where: { status: 'PUBLISHED', isMandatory: false },
    attributes: ['id', 'societyId', 'dueDate'],
  });
  let closed = 0;
  const todays = new Map<number, string>();
  for (const c of rows) {
    const sid = Number(c.societyId);
    if (!todays.has(sid)) todays.set(sid, await societyToday(sid));
    if (c.dueDate >= todays.get(sid)!) continue;
    try {
      await closeCollection(jobCtx(sid), Number(c.id), null, 'Due date passed');
      closed++;
    } catch (err) {
      logger.warn({ err, collectionId: c.id }, 'collection auto-close skipped');
    }
  }
  return closed;
}

/** Sends the automatic reminder for published collections due tomorrow (skips quietly when a limit applies). */
export async function runDueReminders(): Promise<number> {
  const rows = await Collection.findAll({
    where: { status: 'PUBLISHED' },
    attributes: ['id', 'societyId', 'dueDate'],
  });
  let sent = 0;
  const todays = new Map<number, string>();
  for (const c of rows) {
    const sid = Number(c.societyId);
    if (!todays.has(sid)) todays.set(sid, await societyToday(sid));
    if (c.dueDate !== addDaysYmd(todays.get(sid)!, 1)) continue;
    try {
      await remindCollection(jobCtx(sid), Number(c.id), null);
      sent++;
    } catch (err) {
      logger.info({ err, collectionId: c.id }, 'collection due reminder skipped');
    }
  }
  return sent;
}

export function registerCollections(): void {
  registerCollectionApprovalType();
  registerProcessor(PAYMENTS_QUEUE, COLLECTION_JOBS.autoClose, async () => {
    await runAutoClose();
  });
  registerRepeatable(PAYMENTS_QUEUE, COLLECTION_JOBS.autoClose, { dailyAtIst: '00:30' });
  registerProcessor(PAYMENTS_QUEUE, COLLECTION_JOBS.dueReminders, async () => {
    await runDueReminders();
  });
  registerRepeatable(PAYMENTS_QUEUE, COLLECTION_JOBS.dueReminders, { dailyAtIst: '09:30' });
}
