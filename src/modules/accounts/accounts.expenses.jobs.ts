import { accountsPorts } from './accounts.ports';
import { APPROVAL_TYPES } from './accounts.constants';
import {
  describeExpense,
  onExpenseApproved,
  onExpenseCancelled,
  onExpenseChangesRequested,
  onExpenseRejected,
} from './accounts.expenses.post';
import './accounts.expenses.templates';

/** Registered from `registerAccountsJobs()` (one line): the module 14 approval type `EXPENSE` (section 9.3). No jobs in 13.2a. */
export function registerExpenseJobs(): void {
  accountsPorts().approvals.registerType({
    type: APPROVAL_TYPES.expense,
    onApproved: onExpenseApproved,
    onRejected: onExpenseRejected,
    onChangesRequested: onExpenseChangesRequested,
    onCancelled: onExpenseCancelled,
    describe: describeExpense,
  });
}
