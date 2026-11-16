import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';
import { formatRupees } from '../../lib/money';

/** Templates of part 12.1 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later. */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});

registerTemplates({
  'payments.payment_failed': t(
    ['PUSH'],
    d => ({
      sms: `Your payment of order PO-${d.orderId} did not go through. You can try again from the Pay tab.`,
    }),
    true,
  ),
  'payments.checkout_abandoned': t(['PUSH'], d => ({
    sms: `You have an unfinished payment of ${formatRupees(Number(d.grossAmountPaise))}. Finish it from the Pay tab.`,
  })),
  'payments.payment_link': t(
    ['SMS', 'EMAIL', 'WHATSAPP'],
    d => ({
      sms: `Pay ${formatRupees(Number(d.amountPaise))} for ${d.unitLabel}: ${d.url}`,
      email: {
        subject: `Payment link for ${d.unitLabel}`,
        text: `Pay ${formatRupees(Number(d.amountPaise))} for ${d.unitLabel} using this link: ${d.url}`,
      },
    }),
    true,
  ),
  'payments.needs_review': t(['EMAIL'], d => ({
    email: {
      subject: 'A payment needs your review',
      text: `A payment needs review (${d.reason}). Open Money, Payments to check it.`,
    },
  })),
  'payments.duplicate_payment': t(['PUSH'], () => ({
    sms: 'A second payment arrived for an order that was already paid. The money is kept as advance; ask for a refund if needed.',
  })),
});
