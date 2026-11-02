import { sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import type { Ctx } from '../../types/context';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { issuePeriod, PLATFORM_BILLING_QUEUE, RENDER_PDF_JOB } from './platform-billing.service';
import { runAutopayCharge } from './platform-billing.autopay-charge';
import { runDunning } from './platform-billing.dunning';
import { renderPdfFor } from './platform-billing.pdf';
import { runReconcileOrders, runRefundStatus } from './platform-billing.reconcile';
import {
  runTdsCertificateReminders,
  sendTdsCertificateReminder,
  TDS_REMINDER_ONE_JOB,
} from './platform-billing.tds';
import { todayIst } from './platform-billing.settlement';
import { PROCESS_WEBHOOK_JOB, processWebhookEvent } from './platform-billing.webhook';
import type { GatewayWebhookEvent } from '../../adapters/payments/payment-gateway';

/** Queue `platform-billing` (section 9.1, Asia/Kolkata). */
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

export const DUNNING_JOB = 'platform-billing:dunning';
export const RECONCILE_ORDERS_JOB = 'platform-billing:reconcile-orders';
export const REFUND_STATUS_JOB = 'platform-billing:refund-status';
export const AUTOPAY_CHARGE_JOB = 'platform-billing:autopay-charge';
export const TDS_CERTIFICATE_REMINDERS_JOB = 'platform-billing:tds-certificate-reminders';

export function registerPlatformBillingJobs(): void {
  registerQueue(PLATFORM_BILLING_QUEUE, 'Platform billing: invoices, payments, dunning', 5);
  registerProcessor(PLATFORM_BILLING_QUEUE, GENERATE_INVOICES_JOB, async () => runGenerateInvoices());
  registerProcessor(PLATFORM_BILLING_QUEUE, RENDER_PDF_JOB, async data => {
    const id = Number(data.invoiceId);
    if (Number.isInteger(id) && id > 0)
      logger.info({ invoiceId: id, outcome: await renderPdfFor(id) }, 'platform-billing:render-pdf done');
  });
  registerProcessor(PLATFORM_BILLING_QUEUE, PROCESS_WEBHOOK_JOB, async data => {
    const outcome = await processWebhookEvent(data.event as GatewayWebhookEvent);
    logger.info({ eventId: data.eventId, outcome }, 'platform-billing:process-webhook done');
  });
  registerProcessor(PLATFORM_BILLING_QUEUE, DUNNING_JOB, async () => runDunning());
  registerProcessor(PLATFORM_BILLING_QUEUE, RECONCILE_ORDERS_JOB, async () => runReconcileOrders());
  registerProcessor(PLATFORM_BILLING_QUEUE, REFUND_STATUS_JOB, async () => runRefundStatus());
  registerProcessor(PLATFORM_BILLING_QUEUE, AUTOPAY_CHARGE_JOB, async () => runAutopayCharge());
  // monthly on the 5th: the scheduler has a daily slot, the processor checks the day (`force` is for operators and tests)
  registerProcessor(PLATFORM_BILLING_QUEUE, TDS_CERTIFICATE_REMINDERS_JOB, async data =>
    data.force || todayIst().endsWith('-05') ? runTdsCertificateReminders() : { skipped: true },
  );
  registerProcessor(PLATFORM_BILLING_QUEUE, TDS_REMINDER_ONE_JOB, async data => {
    await sendTdsCertificateReminder(Number(data.claimId));
  });
  registerRepeatable(PLATFORM_BILLING_QUEUE, GENERATE_INVOICES_JOB, { dailyAtIst: '02:00' });
  registerRepeatable(PLATFORM_BILLING_QUEUE, AUTOPAY_CHARGE_JOB, { dailyAtIst: '06:00' });
  registerRepeatable(PLATFORM_BILLING_QUEUE, DUNNING_JOB, { dailyAtIst: '09:00' });
  registerRepeatable(PLATFORM_BILLING_QUEUE, TDS_CERTIFICATE_REMINDERS_JOB, { dailyAtIst: '10:00' });
  registerRepeatable(PLATFORM_BILLING_QUEUE, RECONCILE_ORDERS_JOB, { everyMs: 15 * 60_000 });
  registerRepeatable(PLATFORM_BILLING_QUEUE, REFUND_STATUS_JOB, { hourlyAtMinute: 0 });
}
