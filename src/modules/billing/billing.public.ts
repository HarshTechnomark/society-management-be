/**
 * The module 11 functions other modules may import (section 8.24) and the start-up hook `registerBilling()`.
 * Modules 08, 09, 12, 13, 15, 18, 19, 21, 23, 24 and 25 reach billing only through this file. Section 8.24 names are fixed:
 * `unitLedger.post|balance`, `invoices.applyAllocation|reverseAllocation|createAdHoc|listOpen|billedForMonth|
 * registerFundResolver|get|setDisputed|requestCancel|creditBySource|cancelBySource` and `meterSources.register`.
 * Bodies live in `billing.ledger.service.ts` and `billing.invoices.service.ts` (placeholders until the sub-modules fill them).
 */
import { registerQueue } from '../../lib/queue';
import {
  registerExportProvider,
  registerPurgeHandler,
  registerRetentionExpiryHandler,
} from '../societies/societies.public';
import { BILLING_QUEUE } from './billing.constants';
import { billingExportProvider } from './billing.exports';
import { assertBillingPortsReady, registerMeterSource } from './billing.ports';
import { PURGE_TABLES, deleteRetainedBilling, purgeBilling } from './billing.purge';
import { invoices } from './billing.invoices.service';
import { unitLedger } from './billing.ledger.service';
import { registerBillingRuns } from './billing.runs.jobs';
// 11.1: charge heads, rules, split and late fee policy configuration
import { chargeHeads } from './billing.heads.service';
import { policyFor } from './billing.latefee-policy.service';
import { versionEffectiveOn } from './billing.rules.service';
import { registerSetupApprovals } from './billing.rules.approvals-hook';
import { registerLedgerHooks } from './billing.ledger.hooks';

export { unitLedger, invoices };
export { chargeHeads };
/** 11.1 readers for the calculator (11.3) and the late fee job (11.5). */
export const billingSetup = { policyFor, versionEffectiveOn };
export { splitPaise, splitWeight } from './billing.split';
/** Module 21 registers its readings here at start-up (BR-11-17). */
export const meterSources = { register: registerMeterSource };

export { setBillingPorts } from './billing.ports';
export type { BillingPorts } from './billing.ports';
export type {
  CreateAdHocInput,
  InvoiceBalanceDto,
  InvoiceDto,
  InvoiceLineDto,
  LedgerPostInput,
  MeterConsumption,
  MeterSource,
  OpenInvoiceDto,
} from './billing.types';
export type { LedgerEntryType, LedgerRefType } from './billing.constants';

/**
 * Start-up hook (call after `registerSocieties()`, `registerSocietySetup()` and `registerResidents()`; done in `server.ts`,
 * `worker.ts` and `npm run seed`): the production check of the placeholder ports (section 1.1), the module 05 export
 * provider, purge handler and retention expiry handler, and the `billing` queue. Sub-modules add their approval types,
 * module 08 hooks, jobs and templates here.
 */
export function registerBilling(): void {
  assertBillingPortsReady();
  registerExportProvider(billingExportProvider);
  registerPurgeHandler({ module: 'billing', order: 110, tables: PURGE_TABLES, purge: purgeBilling });
  registerRetentionExpiryHandler({ module: 'billing', order: 110, deleteRetained: deleteRetainedBilling });
  registerQueue(BILLING_QUEUE, 'Billing: runs, issue, PDFs, late fees, reminders', 4);
  registerBillingRuns(); // 11.3: compute and issue jobs, BILLING_RUN_PUBLISH approval type
  registerSetupApprovals(); // 11.1: BILLING_RULE_CHANGE and LATE_FEE_POLICY_CHANGE
  // 11.2: real unitLedger.balance for module 09 duesPaise, module 08 BILLING check and UNIT_HAS_BALANCE guard
  registerLedgerHooks();
}
