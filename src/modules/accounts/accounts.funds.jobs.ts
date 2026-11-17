import { accountsPorts } from './accounts.ports';
import { fundTransferHooks } from './accounts.funds.transfer';

/** 13.2 registrations (no jobs): the `FUND_TRANSFER` approval type. Called from `registerAccountsJobs()`. */
export function registerFundJobs(): void {
  accountsPorts().approvals.registerType(fundTransferHooks);
}
