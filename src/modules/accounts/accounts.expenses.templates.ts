import { registerTemplates } from '../../lib/notify';

/** Notification template of 13.2a (section 10) for the temporary `lib/notify.ts`; module 16 owns it later. Amounts are formatted rupees, never account numbers. */
registerTemplates({
  'accounts.expense_reversed': {
    channels: ['EMAIL'],
    critical: false,
    render: d => ({
      email: {
        subject: `Expense ${d.displayId} was reversed`,
        text: `${d.displayId} (${d.payee}, ${d.amount}) was reversed by ${d.reversedByName}.\nReason: ${d.reason}\nVoucher: ${d.reversalVoucherNo}`,
      },
    }),
  },
});
