import { APPROVAL_TYPES } from './accounts.constants';
import { accountsPorts, type ApprovalTypeHooks } from './accounts.ports';
import {
  describeJournal,
  onJournalApproved,
  onJournalCancelled,
  onJournalChangesRequested,
  onJournalRejected,
} from './accounts.journal.service';

/** Approval type `MANUAL_JOURNAL` (entity `journal_entry`): registers the module 14 callbacks (decisions come from the inbox). */
export function registerJournalApprovalType(): void {
  const hooks: ApprovalTypeHooks = {
    type: APPROVAL_TYPES.manualJournal,
    onApproved: onJournalApproved,
    onRejected: onJournalRejected,
    onChangesRequested: onJournalChangesRequested,
    onCancelled: onJournalCancelled,
    describe: describeJournal,
  };
  accountsPorts().approvals.registerType(hooks);
}
