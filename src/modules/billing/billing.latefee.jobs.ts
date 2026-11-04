import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { istDate, now } from '../../lib/clock';
import { BILLING_QUEUE, JOBS } from './billing.constants';
import { runLateFeesAll } from './billing.latefee.service';
import { runDueRemindersAll, sendBulkReminders } from './billing.reminders.service';
import { runReconcileAll } from './billing.reconcile.service';
import './billing.reminders.templates';

/**
 * Sub-module 11.5 start-up registrations (section 9.1): `billing:late-fees` (02:00 IST daily tick that acts on day 1 of the month
 * only, so the month window is closed), `billing:due-reminders` (09:00), `billing:send-reminders` (on demand) and
 * `billing:reconcile` (03:00). Idempotent: `registerBilling()` calls it and tests call it again.
 */
export function registerBillingDues(): void {
  registerProcessor(BILLING_QUEUE, JOBS.lateFees, async data => {
    const today = typeof data.today === 'string' ? data.today : istDate(now());
    if (!data.force && today.slice(8, 10) !== '01') return;
    await runLateFeesAll(today);
  });
  registerRepeatable(BILLING_QUEUE, JOBS.lateFees, { dailyAtIst: '02:00' });
  registerProcessor(BILLING_QUEUE, JOBS.dueReminders, async () => {
    await runDueRemindersAll();
  });
  registerRepeatable(BILLING_QUEUE, JOBS.dueReminders, { dailyAtIst: '09:00' });
  registerProcessor(BILLING_QUEUE, JOBS.sendReminders, async data => {
    await sendBulkReminders(
      Number(data.societyId),
      data.buildingId === null || data.buildingId === undefined ? null : Number(data.buildingId),
      data.requestedBy === null || data.requestedBy === undefined ? null : Number(data.requestedBy),
    );
  });
  registerProcessor(BILLING_QUEUE, JOBS.reconcile, async () => {
    await runReconcileAll();
  });
  registerRepeatable(BILLING_QUEUE, JOBS.reconcile, { dailyAtIst: '03:00' });
}
