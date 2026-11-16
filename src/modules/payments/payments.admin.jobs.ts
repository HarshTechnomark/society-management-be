import { Op } from 'sequelize';
import { logger } from '../../lib/logger';
import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { Payment } from '../../models';
import { JOBS, PAYMENTS_QUEUE } from './payments.constants';
import { registerPaymentAlerts } from './payments.admin.alerts';
import { runIntegrityCheck } from './payments.admin.integrity';
import { registerSummaryCache } from './payments.admin.summary';
import { renderReceiptFor } from './payments.receipts.service';
import { n } from './payments.shared';

/**
 * Sub-module 12.3 start-up registrations: the processors of `payments:render-receipt` (replaces the foundation's no-op) and
 * `payments:integrity-check` (daily 03:30 IST), the summary cache clearing and the review alerts. Idempotent.
 */
export function registerAdminJobs(): void {
  registerProcessor(PAYMENTS_QUEUE, JOBS.renderReceipt, async data => {
    const id = Number(data.paymentId);
    if (!Number.isInteger(id) || id <= 0) return;
    const outcome = await renderReceiptFor(id, data.retry === true);
    logger.info({ paymentId: id, outcome }, 'payments:render-receipt done');
    return outcome;
  });
  registerProcessor(PAYMENTS_QUEUE, JOBS.integrityCheck, async () => {
    const issues = await runIntegrityCheck();
    if (issues.length) {
      logger.error({ issues }, 'payments:integrity-check found mismatches');
      throw new Error(
        `Payments integrity check failed: ${issues.map(i => `${i.check}=[${i.ids.join(',')}]`).join('; ')}`,
      );
    }
    return { issues: 0 };
  });
  registerRepeatable(PAYMENTS_QUEUE, JOBS.integrityCheck, { dailyAtIst: '03:30' });
  registerSummaryCache();
  registerPaymentAlerts();
}

/** `payments.successRate(since)` (8.26, module 07): CAPTURED ÷ (CAPTURED + FAILED) of online payments, percent with one decimal. */
export async function successRate(since: Date): Promise<number | null> {
  const [ok, failed] = await Promise.all([
    Payment.count({ where: { status: 'CAPTURED', createdAt: { [Op.gte]: since } } }),
    Payment.count({ where: { status: 'FAILED', createdAt: { [Op.gte]: since } } }),
  ]);
  const total = n(ok) + n(failed);
  return total === 0 ? null : Math.round((n(ok) * 1000) / total) / 10;
}
