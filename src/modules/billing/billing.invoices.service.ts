import { applyAllocation, reverseAllocation, setDisputed } from './billing.invoices.alloc';
import { createAdHoc } from './billing.invoices.adhoc';
import { billedForMonth, getInvoice, listOpen } from './billing.invoices.detail';
import { fundResolvers } from './billing.invoices.funds';
import { cancelBySource, creditBySource, requestCancel } from './billing.notes.cancel';

/**
 * `invoices.*` of section 8.24 (re-exported unchanged by `billing.public.ts`). The bodies live in `billing.invoices.alloc.ts`
 * (allocation, disputed flag), `billing.invoices.adhoc.ts` (`createAdHoc`), `billing.invoices.detail.ts` (readers) and
 * `billing.notes.cancel.ts` (cancellation, credit and cancel by source).
 */
export { fundResolvers };

export const invoices = {
  // shared contract (Part B)
  applyAllocation,
  reverseAllocation,
  createAdHoc,
  // for module 12
  listOpen,
  billedForMonth,
  /** Module 12 registers `collection_request` → the collection's fund (BR-11-49a). */
  registerFundResolver: (
    refType: string,
    resolve: (societyId: number, refId: number) => Promise<number | null>,
  ): void => {
    fundResolvers.set(refType, resolve);
  },
  // for modules 09, 15, 23, 24, 25
  get: getInvoice,
  setDisputed,
  requestCancel,
  creditBySource,
  cancelBySource,
};
