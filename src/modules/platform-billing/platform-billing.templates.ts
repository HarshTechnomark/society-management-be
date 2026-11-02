import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';
import { formatRupees } from '../../lib/money';

/**
 * Notification templates of module 06 (section 10) for the temporary `lib/notify.ts`. In-app and platform bell
 * channels are not delivered by the stand-in, so only the email part renders.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});
const mail = (subject: string, text: string) => ({ email: { subject, text } });
const rs = (v: unknown): string => formatRupees(Number(v ?? 0));

registerTemplates({
  'platform_billing.payment_received': t(['EMAIL'], d =>
    mail(
      `Payment of ${rs(d.amountPaise)} received`,
      `We received ${rs(d.amountPaise)} for ${d.societyName}${d.invoiceNo ? ` against ${d.invoiceNo}` : ''}. Thank you.`,
    ),
  ),
  'platform_billing.payment_failed': t(['EMAIL'], d =>
    mail(
      'Your SocietyApp payment did not go through',
      `The payment of ${rs(d.amountPaise)} for ${d.invoiceNo ?? 'your invoice'} failed. You can try again from Settings, Subscription.`,
    ),
  ),
  'platform_billing.credit_granted': t(['EMAIL'], d =>
    mail(
      `A credit of ${rs(d.amountPaise)} was added`,
      `A credit of ${rs(d.amountPaise)} was added to ${d.societyName}. It is applied to your open invoices.`,
    ),
  ),
  'platform_billing.refund_processed': t(['EMAIL'], d =>
    mail(
      `Refund of ${rs(d.amountPaise)} processed`,
      `A refund of ${rs(d.amountPaise)} was processed for ${d.societyName}.`,
    ),
  ),
  'platform_billing.tds_rejected': t(['EMAIL'], d =>
    mail(
      `TDS claim on ${d.invoiceNo} was rejected`,
      `The TDS claim of ${rs(d.amountPaise)} on ${d.invoiceNo} was rejected: ${d.reason}. The amount is due again.`,
    ),
  ),
  'platform_billing.approval_pending': t(['EMAIL'], d =>
    mail(
      `Approval needed: ${d.what}`,
      `${d.what} (${rs(d.amountPaise)}) for ${d.societyName} needs approval.`,
    ),
  ),
  'platform_billing.payment_mismatch': t(['EMAIL'], d =>
    mail(
      'Payment amount mismatch',
      `The gateway reported ${rs(d.gatewayAmountPaise)} for order ${d.orderId}, expected ${rs(d.amountPaise)}. Nothing was settled. Record it manually after checking.`,
    ),
  ),
  'platform_billing.refund_failed': t(['EMAIL'], d =>
    mail(
      'A gateway refund failed',
      `The refund of ${rs(d.amountPaise)} for ${d.societyName} failed. The balance was restored.`,
    ),
  ),
  'platform_billing.invoice_issued': t(['EMAIL'], d =>
    mail(
      `Invoice ${d.invoiceNo} for ${rs(d.totalPaise)}`,
      `A SocietyApp invoice ${d.invoiceNo} of ${rs(d.totalPaise)} was issued to ${d.societyName}. It is due on ${d.dueDate}. View or pay it from Settings, Subscription and billing.`,
    ),
  ),
  'platform_billing.credit_note_issued': t(['EMAIL'], d =>
    mail(
      `Credit note ${d.invoiceNo} for ${rs(d.totalPaise)}`,
      `A credit note ${d.invoiceNo} of ${rs(d.totalPaise)} was issued to ${d.societyName} against ${d.originalInvoiceNo}. View it from Settings, Subscription and billing.`,
    ),
  ),
  'platform_billing.payment_reminder': t(['EMAIL'], d =>
    mail(
      d.manual ? `Reminder: invoice ${d.invoiceNo}` : `Payment reminder for invoice ${d.invoiceNo}`,
      `Invoice ${d.invoiceNo} of ${d.societyName} has ${rs(d.amountDuePaise)} due on ${d.dueDate}. Pay from Settings, Subscription and billing.${d.note ? ` Note: ${d.note}` : ''}`,
    ),
  ),
  'platform_billing.suspension_warning': t(
    ['EMAIL', 'SMS', 'WHATSAPP'],
    d => ({
      ...mail(
        `Your SocietyApp service will be suspended on ${d.suspendOn}`,
        `Invoice ${d.invoiceNo} of ${d.societyName} has ${rs(d.amountDuePaise)} overdue (due ${d.dueDate}). Service will be suspended on ${d.suspendOn} unless it is paid.`,
      ),
      sms: `SocietyApp: ${rs(d.amountDuePaise)} overdue on ${d.invoiceNo}. Service is suspended on ${d.suspendOn} unless paid.`,
    }),
    true,
  ),
  'platform_billing.past_due': t(['EMAIL'], d =>
    mail(
      `${d.societyName} is past due`,
      `Invoice ${d.invoiceNo} (${rs(d.amountDuePaise)}) is overdue. Please pay it before ${d.suspendOn} to avoid suspension.`,
    ),
  ),
  'platform_billing.suspended': t(
    ['EMAIL', 'SMS', 'WHATSAPP'],
    d => ({
      ...mail(
        `${d.societyName} is suspended`,
        `Service for ${d.societyName} was suspended for non-payment. Pay the overdue invoices to restore it.`,
      ),
      sms: `SocietyApp: service for ${d.societyName} is suspended for non-payment. Pay the overdue invoices to restore it.`,
    }),
    true,
  ),
  'platform_billing.grace_extended': t(['EMAIL'], d =>
    mail(
      `More time to pay invoice ${d.invoiceNo}`,
      `The suspension date of invoice ${d.invoiceNo} was moved from ${d.suspendOnBefore} to ${d.suspendOnAfter}.`,
    ),
  ),
  'platform_billing.tds_certificate_due': t(['EMAIL'], d =>
    mail(
      `TDS certificate needed for ${d.invoiceNo}`,
      `The TDS claim of ${rs(d.amountPaise)} on ${d.invoiceNo} has no certificate yet. Please upload it from Settings, Subscription and billing.`,
    ),
  ),
});
