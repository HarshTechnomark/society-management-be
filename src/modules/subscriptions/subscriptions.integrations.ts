import type { Transaction } from 'sequelize';
import { Society } from '../../models';
import type { Ctx } from '../../types/context';
import { addDaysYmd, periodValue as periodValueImpl } from './pricing';

/**
 * Functions module 04 calls in modules 05, 06 and 14 (section 8.9). Until those modules exist, these are recording stubs:
 * every call is appended to `integrationCalls` so tests can assert it, and the return values follow the contract.
 * The owning module replaces them with `setSubscriptionIntegrations({...})` at start-up.
 */
export interface PlatformInvoiceDto {
  id: number;
  invoiceNo: string;
  totalPaise: number;
  dueDate: string;
}
export interface ProrationItem {
  label?: string;
  planVersionId?: number;
  addonKey?: string;
  fromPeriodValuePaise: number;
  toPeriodValuePaise: number;
}
export interface TaxPreview {
  mode: 'INTRA_STATE' | 'INTER_STATE';
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}
export interface SocietyStatusInfo {
  status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CLOSED';
  cause?: string | null;
}

export interface SubscriptionIntegrations {
  /** Module 06 (§9.3 of module 06). */
  billing: {
    issuePeriodInvoice(
      ctx: Ctx,
      input: { subscriptionId: number; periodStart: string },
      t: Transaction,
    ): Promise<PlatformInvoiceDto | null>;
    /** Returns null when the subtotal is <= 0. */
    issueProrationInvoice(
      ctx: Ctx,
      input: { subscriptionId: number; changeRef: string; effectiveDate: string; items: ProrationItem[] },
      t: Transaction,
    ): Promise<PlatformInvoiceDto | null>;
    issueOneTimeInvoice(
      ctx: Ctx,
      input: {
        subscriptionId: number;
        purchaseRef: string;
        addonKey: string;
        label: string;
        quantity: number;
        unitPricePaise: number;
        lineType?: 'ADDON' | 'OVERAGE';
      },
      t: Transaction,
    ): Promise<PlatformInvoiceDto | null>;
    periodValue(flats: number, pricePerFlatPerMonthPaise: number, months: number, freeMonths: number): number;
    /** null while module 06 is not built. */
    previewTax(societyId: number, subtotalPaise: number): Promise<TaxPreview | null>;
    /** Add-on revenue this month for the platform add-on list; 0 while module 06 is not built. */
    addonRevenueThisMonth(addonCode: string): Promise<number>;
  };
  /** Module 05 (§8.25 of module 05). */
  lifecycle: {
    closeForSubscriptionCancellation(
      societyId: number,
      subscriptionId: number,
      t: Transaction,
    ): Promise<void>;
    getStatusInfo(societyId: number): Promise<SocietyStatusInfo>;
  };
  /** Module 14: approval type `SUBSCRIPTION_CANCEL`; module 14 calls `applyCancellation` when it is approved. */
  approvals: {
    createRequest(
      ctx: Ctx,
      input: {
        type: 'SUBSCRIPTION_CANCEL';
        societyId: number;
        subscriptionId: number;
        requestedBy: number;
        reason: string;
        approverPermission: 'settings.subscription.edit';
      },
      t: Transaction,
    ): Promise<{ approvalRequestId: number }>;
  };
}

export interface IntegrationCall {
  fn: string;
  input: unknown;
  /** The transaction the call ran in (tests check it is the caller's). */
  t?: Transaction;
}
/** Every stub call, in order (tests read and clear it). */
export const integrationCalls: IntegrationCall[] = [];
let seq = 0;
const stubInvoice = (totalPaise: number, issuedOn: string): PlatformInvoiceDto => {
  seq += 1;
  return { id: 900000 + seq, invoiceNo: `STUB/${seq}`, totalPaise, dueDate: addDaysYmd(issuedOn, 7) };
};

export const stubIntegrations: SubscriptionIntegrations = {
  billing: {
    issuePeriodInvoice: async (_ctx, input, t) => {
      integrationCalls.push({ fn: 'issuePeriodInvoice', input, t });
      return stubInvoice(0, input.periodStart);
    },
    issueProrationInvoice: async (_ctx, input, t) => {
      integrationCalls.push({ fn: 'issueProrationInvoice', input, t });
      const net = input.items.reduce((a, i) => a + i.toPeriodValuePaise - i.fromPeriodValuePaise, 0);
      return net > 0 ? stubInvoice(net, input.effectiveDate) : null;
    },
    issueOneTimeInvoice: async (_ctx, input, t) => {
      integrationCalls.push({ fn: 'issueOneTimeInvoice', input, t });
      return stubInvoice(input.quantity * input.unitPricePaise, '2000-01-01');
    },
    periodValue: periodValueImpl,
    previewTax: async () => null,
    addonRevenueThisMonth: async () => 0,
  },
  lifecycle: {
    closeForSubscriptionCancellation: async (societyId, subscriptionId, t) => {
      integrationCalls.push({
        fn: 'closeForSubscriptionCancellation',
        input: { societyId, subscriptionId },
        t,
      });
    },
    getStatusInfo: async societyId => {
      const s = await Society.findByPk(societyId, { attributes: ['id', 'status'] });
      return { status: (s?.status ?? 'ACTIVE') as SocietyStatusInfo['status'], cause: null };
    },
  },
  approvals: {
    createRequest: async (_ctx, input, t) => {
      integrationCalls.push({ fn: 'approvals.createRequest', input, t });
      seq += 1;
      return { approvalRequestId: 700000 + seq };
    },
  },
};

let current: SubscriptionIntegrations = stubIntegrations;
export const integrations = (): SubscriptionIntegrations => current;

/** Replace some functions (modules 05, 06 and 14 at start-up, or tests). Pass nothing to restore the stubs. */
export function setSubscriptionIntegrations(p?: {
  [K in keyof SubscriptionIntegrations]?: Partial<SubscriptionIntegrations[K]>;
}): void {
  if (!p) {
    current = stubIntegrations;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as SubscriptionIntegrations;
}
