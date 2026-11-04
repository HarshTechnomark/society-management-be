import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';
import { formatRupees } from '../../lib/money';

/**
 * Notification templates of sub-module 11.4 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later. Data
 * never holds another resident's name or flat. `billing.invoice_issued` is registered by 11.3.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});

registerTemplates({
  'billing.debit_note_issued': t(['PUSH', 'EMAIL'], d => ({
    sms: `Debit note ${d.noteNo} of ${formatRupees(Number(d.amountPaise))} was added to your bill ${d.invoiceNo}.`,
    email: {
      subject: `Debit note ${d.noteNo}`,
      text: `Debit note ${d.noteNo} of ${formatRupees(Number(d.amountPaise))} was added to your bill ${d.invoiceNo}.`,
    },
  })),
  'billing.credit_note_issued': t(['PUSH', 'EMAIL'], d => ({
    sms: `Credit note ${d.noteNo} of ${formatRupees(Number(d.amountPaise))} was applied to your bill ${d.invoiceNo}.`,
    email: {
      subject: `Credit note ${d.noteNo}`,
      text: `Credit note ${d.noteNo} of ${formatRupees(Number(d.amountPaise))} was applied to your bill ${d.invoiceNo}.`,
    },
  })),
  'billing.invoice_cancelled': t(['EMAIL'], d => ({
    email: {
      subject: `Bill ${d.invoiceNo} cancelled`,
      text: `Your bill ${d.invoiceNo} was cancelled. Nothing is due on it any more.`,
    },
  })),
  'billing.document_pdf_failed': t(['EMAIL'], d => ({
    email: {
      subject: `PDF of ${d.documentNo} could not be created`,
      text: `The PDF of ${d.documentNo} failed after several attempts. Open the document and ask for it again.`,
    },
  })),
});
