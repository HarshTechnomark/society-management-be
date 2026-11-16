import { Op } from 'sequelize';
import { istDate, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { Payment } from '../../models';
import { usersWithPermission } from '../access-control/access-control.public';
import { addDaysYmd } from '../billing/billing.calc.period';
import { JOBS, NOTIFY, PAYMENTS_QUEUE, PERM } from './payments.constants';
import { paymentsPorts } from './payments.ports';

/**
 * `payments:cheque-reminder` (9.1): daily 09:00 IST. For each society with cheques `RECEIVED` whose `chequeDate` is at least two
 * days past, one `payments.cheque_deposit_due` notification to the members with `finance.payments.edit` (one per society per day).
 */
export async function runChequeReminders(today = istDate(now())): Promise<number> {
  const rows = await Payment.findAll({
    where: { method: 'CHEQUE', status: 'RECEIVED', chequeDate: { [Op.lte]: addDaysYmd(today, -2) } },
    attributes: ['societyId', 'amountPaise'],
  });
  const bySociety = new Map<number, { count: number; totalPaise: number }>();
  for (const r of rows) {
    const s = bySociety.get(Number(r.societyId)) ?? { count: 0, totalPaise: 0 };
    s.count += 1;
    s.totalPaise += Number(r.amountPaise);
    bySociety.set(Number(r.societyId), s);
  }
  let sent = 0;
  for (const [societyId, s] of bySociety) {
    try {
      const to = await usersWithPermission(societyId, PERM.paymentsEdit);
      if (!to.length) continue;
      await paymentsPorts().notifications.send(NOTIFY.chequeDepositDue, to, {
        societyId,
        count: s.count,
        totalPaise: s.totalPaise,
        date: today,
      });
      sent += 1;
    } catch (err) {
      logger.error({ err, societyId }, 'cheque reminder failed');
    }
  }
  return sent;
}

export function registerChequeJobs(): void {
  registerProcessor(PAYMENTS_QUEUE, JOBS.chequeReminder, async data => {
    await runChequeReminders(typeof data.today === 'string' ? data.today : undefined);
  });
  registerRepeatable(PAYMENTS_QUEUE, JOBS.chequeReminder, { dailyAtIst: '09:00' });
}
