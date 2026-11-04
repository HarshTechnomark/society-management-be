import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';
import { formatRupees } from '../../lib/money';

/**
 * Notification templates of sub-module 11.5 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later. They
 * carry the invoice number, amount and due date only: never another resident's name or flat.
 */
const t = (channels: NotifyChannel[], render: Template['render']): Template => ({
  channels,
  critical: false,
  render,
});

registerTemplates({
  'billing.invoice_due_soon': t(['PUSH', 'WHATSAPP', 'SMS'], d => ({
    sms: `Reminder: bill ${d.invoiceNo} of ${formatRupees(Number(d.amountPaise))} is due on ${d.dueDate}.`,
    whatsappParams: [String(d.invoiceNo), formatRupees(Number(d.amountPaise)), String(d.dueDate)],
  })),
  'billing.invoice_overdue': t(['PUSH', 'WHATSAPP', 'SMS'], d => ({
    sms: `Overdue: bill ${d.invoiceNo}, ${formatRupees(Number(d.amountPaise))} was due on ${d.dueDate}. Please pay now.`,
    whatsappParams: [String(d.invoiceNo), formatRupees(Number(d.amountPaise)), String(d.dueDate)],
  })),
  'billing.invoice_reminder': t(['PUSH', 'WHATSAPP'], d => ({
    sms: `Reminder from your society: bill ${d.invoiceNo}, ${formatRupees(Number(d.amountPaise))} is pending (due ${d.dueDate}).`,
    whatsappParams: [String(d.invoiceNo), formatRupees(Number(d.amountPaise)), String(d.dueDate)],
  })),
});
