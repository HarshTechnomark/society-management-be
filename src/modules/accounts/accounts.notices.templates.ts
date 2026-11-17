import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';
import { NOTIFY } from './accounts.constants';

/**
 * Notification templates of the remaining accounts keys (section 10) for the temporary `lib/notify.ts`; module 16 owns them later.
 * Without them `notify()` logs "unknown template" and nothing reaches the dev inbox. Amounts arrive formatted, never account numbers.
 */
const t = (
  channels: NotifyChannel[],
  subject: string,
  text: (d: Record<string, any>) => string,
): Template => ({
  channels,
  critical: false,
  render: d => ({ email: { subject, text: text(d) }, sms: text(d).slice(0, 160) }),
});

registerTemplates({
  [NOTIFY.bankAccountChanged]: t(
    ['EMAIL'],
    'A bank account was changed',
    d =>
      `Bank account ${d.displayName} (${d.maskedNumber ?? ''}) was changed: ${d.change ?? 'details updated'}.`,
  ),
  [NOTIFY.bankAccountVerified]: t(
    ['EMAIL'],
    'A bank account was verified',
    d => `Bank account ${d.displayName} is verified and can receive collections.`,
  ),
  [NOTIFY.settlementMismatch]: t(
    ['EMAIL'],
    'A gateway settlement does not match',
    d =>
      `Settlement ${d.gatewaySettlementId ?? d.settlementId} has ${d.unmatched ?? 0} item(s) that match no payment. Open Accounts, Settlements to resolve them.`,
  ),
  [NOTIFY.clearingAged]: t(
    ['EMAIL'],
    'Money has stayed in gateway clearing',
    d =>
      `Money has waited in gateway clearing for more than ${d.days ?? ''} days. Open Accounts, Settlements.`,
  ),
  [NOTIFY.statementImported]: t(['EMAIL'], 'Your bank statement import has finished', d =>
    d.errorMessage
      ? `The statement import failed: ${d.errorMessage}`
      : `The statement import is ${String(d.status ?? 'done').toLowerCase()}: ${d.lineCount ?? 0} lines, ${d.duplicateCount ?? 0} duplicates skipped.`,
  ),
  [NOTIFY.balanceDrift]: t(
    ['EMAIL'],
    'The books need a check',
    d => `The daily check found ${d.ledgers ?? 0} ledger balance(s) that differ from their entries.`,
  ),
  [NOTIFY.periodLocked]: t(
    ['EMAIL'],
    'Accounting period locked',
    d => `Entries up to ${d.lockedThrough} are now locked.`,
  ),
  [NOTIFY.periodUnlocked]: t(
    ['EMAIL'],
    'Accounting period unlocked for a while',
    d => `Entries from ${d.fromDate} are open for correction until ${d.until}.`,
  ),
  [NOTIFY.yearClosed]: t(
    ['EMAIL'],
    'Financial year closed',
    d => `The books of ${d.financialYear} are closed.`,
  ),
  [NOTIFY.depositReceived]: t(
    ['SMS', 'EMAIL'],
    'Deposit received',
    d => `We received your deposit of ${d.amount} (${d.title}).`,
  ),
  [NOTIFY.depositDeducted]: t(
    ['SMS', 'EMAIL'],
    'A deduction was made from your deposit',
    d => `${d.amount} was deducted from your deposit: ${d.reason}.`,
  ),
  [NOTIFY.depositRefunded]: t(
    ['SMS', 'EMAIL'],
    'Deposit refunded',
    d => `Your deposit refund of ${d.amount} was paid.`,
  ),
});
