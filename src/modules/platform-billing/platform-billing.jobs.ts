import { sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import type { Ctx } from '../../types/context';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { issuePeriod, PLATFORM_BILLING_QUEUE, RENDER_PDF_JOB } from './platform-billing.service';
import { todayIst } from './platform-billing.settlement';

/** Queue `platform-billing` (section 9.1, Asia/Kolkata). This task registers the invoice jobs; payments and dunning come later. */
export const GENERATE_INVOICES_JOB = 'platform-billing:generate-invoices';
const SYSTEM: Ctx = { requestId: 'job', ip: '', userAgent: '' };
const ATTEMPTS_PER_ITEM = 3;

export interface GenerateResult {
  due: number;
  issued: number;
  existing: number;
  nothingToInvoice: number;
  failed: number;
}

/**
 * 6.7: one transaction per subscription due (module 04 `listDueForInvoicing`, which also renews periods that ended).
 * Idempotent through `dedupeKey`: a rerun finds the invoices already issued and does nothing. Each item is retried a
 * few times (deadlocks, a duplicate key from a concurrent worker); a failing item never stops the others.
 */
export async function runGenerateInvoices(today: string = todayIst()): Promise<GenerateResult> {
  const r: GenerateResult = { due: 0, issued: 0, existing: 0, nothingToInvoice: 0, failed: 0 };
  const due = await subscriptions.listDueForInvoicing(today);
  r.due = due.length;
  for (const item of due) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ITEM; attempt++) {
      try {
        // closes the previous usage months in their own transactions before the society row is locked
        await subscriptions.getBillingSnapshot(item.subscriptionId, item.periodStart);
        const outcome = await sequelize.transaction(t => issuePeriod(SYSTEM, item, t));
        if (outcome.created) r.issued += 1;
        else if (outcome.invoice) r.existing += 1;
        else r.nothingToInvoice += 1;
        break;
      } catch (err) {
        if (attempt === ATTEMPTS_PER_ITEM) {
          r.failed += 1;
          logger.error({ err, ...item }, 'platform invoice generation failed');
        }
      }
    }
  }
  logger.info(r, 'platform-billing:generate-invoices done');
  return r;
}

/**
 * Placeholder for `platform-billing:render-pdf` (the template and the files service come in a later task): the
 * document keeps `pdfStatus = PENDING`.
 */
export async function renderPdfPlaceholder(data: { invoiceId?: unknown }): Promise<void> {
  logger.debug({ invoiceId: data.invoiceId }, 'platform invoice PDF rendering is not built yet');
}

export function registerPlatformBillingJobs(): void {
  registerQueue(PLATFORM_BILLING_QUEUE, 'Platform billing: invoices, payments, dunning', 5);
  registerProcessor(PLATFORM_BILLING_QUEUE, GENERATE_INVOICES_JOB, async () => runGenerateInvoices());
  registerProcessor(PLATFORM_BILLING_QUEUE, RENDER_PDF_JOB, data => renderPdfPlaceholder(data));
  registerRepeatable(PLATFORM_BILLING_QUEUE, GENERATE_INVOICES_JOB, { dailyAtIst: '02:00' });
}
