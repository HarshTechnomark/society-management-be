import { logger } from '../../lib/logger';
import { registerProcessor } from '../../lib/queue';
import { systemCtx } from '../../types/context';
import { moneyTx } from './payments.shared';
import { JOBS, PAYMENTS_QUEUE } from './payments.constants';
import { applyAdvancesForUnit } from './payments.advances';
import { registerCollections } from './payments.collections.jobs';
import { refreshCollectionTotals } from './payments.alloc.totals';

/**
 * Registry of the jobs of queue `payments` (section 9.1). The foundation registers the two jobs its core needs
 * (`payments:apply-advances`, `collections:refresh-totals`) and a no-op `payments:render-receipt` that 12.3 replaces.
 * Each part adds ONE line to `registerPaymentJobs()` that calls its own `register...Jobs()`.
 */
export function registerPaymentJobs(): void {
  registerProcessor(PAYMENTS_QUEUE, JOBS.applyAdvances, async data => {
    const societyId = Number(data.societyId);
    const unitId = Number(data.unitId);
    const r = await moneyTx(t => applyAdvancesForUnit(systemCtx('job'), societyId, unitId, t));
    return r;
  });
  registerProcessor(PAYMENTS_QUEUE, JOBS.refreshCollectionTotals, async data =>
    refreshCollectionTotals(Number(data.collectionId)),
  );
  // 12.3 replaces this placeholder with the PDF renderer (`payments.receipts.jobs.ts`)
  registerProcessor(PAYMENTS_QUEUE, JOBS.renderReceipt, async data => {
    logger.debug({ paymentId: data.paymentId }, 'payments:render-receipt placeholder (12.3 renders the PDF)');
  });
  // parts add their registration here, one line each:
  registerCollections(); // 12.5
}
