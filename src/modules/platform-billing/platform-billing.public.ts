/**
 * The module 06 functions other modules may import (section 9.3), and the start-up hook `registerPlatformBilling()`.
 */
import { setSubscriptionIntegrations } from '../subscriptions/subscriptions.public';
import { setSocietyPorts } from '../societies/societies.public';
import * as svc from './platform-billing.service';
import { getOutstanding, hasOverdueInvoice } from './platform-billing.settlement';
import { periodValue } from './pricing';
import { registerPlatformBillingJobs } from './platform-billing.jobs';
import { registerBillingRetention } from './platform-billing.retention';
import { getMrrSeries, getMrrSummary } from './platform-billing.reports';

export const platformBilling = {
  issuePeriodInvoice: svc.issuePeriodInvoice,
  issueProrationInvoice: svc.issueProrationInvoice,
  issueOneTimeInvoice: svc.issueOneTimeInvoice,
  hasOverdueInvoice,
  getOutstanding,
  periodValue,
  previewTax: svc.previewTax,
  getMrrSummary,
  getMrrSeries,
};
export { setBillingSettingsSource } from './platform-billing.settings';
export type { PlatformInvoiceDto } from './platform-billing.types';

/**
 * Start-up hook (call after `registerSubscriptions()` and `registerSocieties()`; done in `server.ts` and `worker.ts`):
 * replaces module 04's recording billing stubs with the real issue functions, `periodValue`, `previewTax` (quotes
 * now carry GST) and `addonRevenueThisMonth`; gives module 05 the real `hasOverdueInvoice`; registers the jobs.
 */
export function registerPlatformBilling(): void {
  setSubscriptionIntegrations({
    billing: {
      issuePeriodInvoice: svc.issuePeriodInvoice,
      issueProrationInvoice: svc.issueProrationInvoice,
      issueOneTimeInvoice: svc.issueOneTimeInvoice,
      periodValue,
      previewTax: svc.previewTax,
      addonRevenueThisMonth: svc.addonRevenueThisMonth,
    },
  });
  setSocietyPorts({ billing: { hasOverdueInvoice } });
  registerBillingRetention();
  registerPlatformBillingJobs();
}
