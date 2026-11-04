import { registerProcessor } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { BILLING_QUEUE, JOBS } from './billing.constants';
import { registerNoteApprovalTypes } from './billing.notes.approvals-hook';
import { renderPdfFor } from './billing.pdf.service';
import './billing.invoices.templates';

/**
 * Sub-module 11.4 start-up registrations (sections 9.1 and 9.2): the processor of `billing:render-pdf` and the approval types
 * `CREDIT_NOTE`, `WRITE_OFF` and `INVOICE_CANCEL`. Idempotent: `registerBilling()` calls it and tests call it again.
 */
export function registerBillingInvoices(): void {
  registerProcessor(BILLING_QUEUE, JOBS.renderPdf, async data => {
    const id = Number(data.id);
    const kind = data.kind === 'note' ? 'note' : 'invoice';
    if (Number.isInteger(id) && id > 0)
      logger.info(
        { kind, id, outcome: await renderPdfFor(kind, id, data.retry === true) },
        'billing:render-pdf done',
      );
  });
  registerNoteApprovalTypes();
}
