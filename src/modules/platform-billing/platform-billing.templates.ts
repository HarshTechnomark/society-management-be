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
});
