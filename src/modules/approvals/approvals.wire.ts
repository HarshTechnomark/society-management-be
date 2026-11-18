import { setAccessPorts } from '../access-control/access-control.public';
import { setCommitteePorts } from '../committee/committee.public';
import { setPart2Ports, setResidentPart3Ports } from '../residents/residents.public';
import { createHandoverDelegation } from './approvals.delegations.service';
import { onMemberEnded } from './approvals.engine.member';
import { realPart2Approvals, realPart3Approvals } from './approvals.port.residents';

/**
 * 14.3: switches the modules that still have a placeholder approvals port to the real engine. Production only: `server.ts`,
 * `worker.ts` and `scripts/seed.ts` call it BEFORE `registerResidents()` (which registers its approval types through the port).
 *
 * Modules 11, 12 and 13 need no line here: their `approvals` port defaults to the engine (`engineApprovals` of
 * `billing.ports.ts`), in production and in tests, so `registerBilling()`, `registerPayments()` and `registerAccounts()` register
 * `EXPENSE`, `MANUAL_JOURNAL`, `FUND_TRANSFER`, `DEPOSIT_REFUND`, `PERIOD_UNLOCK` and the billing and payments types with the
 * real registry. Module 09 keeps its auto-approving placeholders in its own unit tests (`approvalStub`, `approvalStore`).
 */
export function wireApprovalsPorts(): void {
  setPart2Ports({ approvals: realPart2Approvals });
  setResidentPart3Ports({ approvals: realPart3Approvals });
  setCommitteePorts({ approvals: { createHandoverDelegation } });
  setAccessPorts({ approvals: { onMemberEnded } });
}
