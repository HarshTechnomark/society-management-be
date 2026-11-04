import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';
import { formatRupees } from '../../lib/money';

/**
 * Notification templates of sub-module 11.3 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later. Data
 * never holds another resident's name or flat.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});

registerTemplates({
  'billing.invoice_issued': t(['PUSH', 'EMAIL'], d => ({
    sms: `Your maintenance bill ${d.invoiceNo} for ${d.periodLabel} is ${formatRupees(Number(d.amountPaise))}, due ${d.dueDate}.`,
    email: {
      subject: `Bill ${d.invoiceNo} for ${d.periodLabel}`,
      text: `Your bill ${d.invoiceNo} for ${d.periodLabel} is ${formatRupees(Number(d.amountPaise))}. Please pay by ${d.dueDate}.`,
    },
  })),
  'billing.run_issued': t(['EMAIL'], d => ({
    email: {
      subject: `Billing run ${d.runLabel} issued`,
      text: `${d.issuedCount} bills were issued for ${d.runLabel}, ${formatRupees(Number(d.totalPaise))} in all.`,
    },
  })),
  'billing.run_failed': t(['EMAIL'], d => ({
    email: {
      subject: `Billing run ${d.runLabel} failed`,
      text: `The billing run ${d.runLabel} could not be computed: ${d.reason}`,
    },
  })),
});
