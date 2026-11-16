/**
 * The module 12 functions other modules may import (section 8.26) and the start-up hook `registerPayments()`. Other modules
 * reach payments only through this file. The core (advances, hooks for module 11, duplicate helpers, settle and reverse) is real;
 * functions marked "part" throw `501 NOT_IMPLEMENTED_IN_FOUNDATION` until their part fills the body (see README).
 */
import { Payment, PaymentOrder } from '../../models';
import { registerQueue } from '../../lib/queue';
import {
  registerExportProvider,
  registerPurgeHandler,
  registerRetentionExpiryHandler,
} from '../societies/societies.public';
import { PAYMENTS_QUEUE } from './payments.constants';
import { advanceBalance, creditOpeningAdvance, queueAdvanceApply } from './payments.advances';
import {
  chequeReturnCount,
  chequeReturnCounts,
  listAllocationsForInvoice,
  registerBillingHooks,
} from './payments.billing-hooks';
import { collectionEfficiency, getCollectionForOtherModules } from './payments.collections.read';
import { paymentsExportProvider } from './payments.exports';
import { registerPaymentJobs } from './payments.jobs';
import { assertPaymentsPortsReady } from './payments.ports';
import { PURGE_TABLES, deleteRetainedPayments, purgePayments } from './payments.purge';
import { onInvoiceCancelled } from './payments.reverse.core';
import { cancelAllForSociety, cancelMandatesForUnitLink } from './payments.autopay.service';
import { registerOrderHook } from './payments.settle';
import { successRate } from './payments.admin.jobs';
import { createModuleOrder, type CreateOrderInput } from './payments.orders.create';
import { orderDto } from './payments.orders.gateway';
import { cancelOrdersForUnitLink } from './payments.orders.service';
import type { PaymentOrderDto } from './payments.orders.types';
import type { AnyCtx, Transaction } from './payments.types';

export { paymentsReports } from './payments.reports';
export { setPaymentsPorts } from './payments.ports';
export type { PaymentsPorts } from './payments.ports';

/** 8.26 `findByGatewayPaymentId` (module 13 settlement matching). */
async function findByGatewayPaymentId(societyId: number, gatewayPaymentId: string): Promise<Payment | null> {
  const p = await Payment.findOne({ where: { societyId, gatewayPaymentId } });
  return p;
}

export const payments = {
  // ---- real (foundation)
  queueAdvanceApply,
  onInvoiceCancelled: (ctx: AnyCtx, invoiceId: number, t: Transaction) =>
    onInvoiceCancelled(ctx, invoiceId, t),
  creditOpeningAdvance,
  listAllocationsForInvoice,
  advanceBalance: (societyId: number, unitId: number) => advanceBalance(societyId, unitId),
  chequeReturnCount,
  chequeReturnCounts,
  findByGatewayPaymentId,
  registerOrderHook,
  // ---- parts
  /** Part 12.1: 8.26 `createOrder` for other modules. */
  createOrder: (ctx: AnyCtx, input: CreateOrderInput) => createModuleOrder(ctx, input),
  /** Part 12.1. */
  getOrder: async (societyId: number, orderId: number): Promise<PaymentOrderDto | null> => {
    const o = await PaymentOrder.findOne({ where: { id: orderId, societyId } });
    return o ? orderDto(o) : null;
  },
  /** Part 12.1 (orders, `cancelOrdersForUnitLink`) and 12.4 (mandates, `cancelMandatesForUnitLink`). */
  onUnitLinkEnded: async (ctx: AnyCtx, unitId: number, userId: number, t: Transaction): Promise<void> => {
    await cancelOrdersForUnitLink(ctx, unitId, userId, t);
    await cancelMandatesForUnitLink(ctx, unitId, userId, t);
  },
  /** Part 12.3. */
  successRate,
  /** Part 12.4. */
  autopay: {
    cancelAllForSociety: (societyId: number, t: Transaction): Promise<number> =>
      cancelAllForSociety(societyId, t),
  },
  /** Part 12.5. */
  collections: {
    efficiency: (societyId: number, month: string): Promise<number | null> =>
      collectionEfficiency(societyId, month),
    get: (societyId: number, id: number) => getCollectionForOtherModules(societyId, id),
  },
};

/**
 * Start-up hook (call after `registerSocieties()`, `registerSocietySetup()`, `registerResidents()` and `registerBilling()`; done in
 * `server.ts`, `worker.ts` and `npm run seed`): the production check of the placeholder ports, module 05 export provider and purge
 * handlers, the `payments` queue and its jobs, and the module 11 hooks (advances, invoice cancel, allocations, fund resolver).
 * Parts add their approval types, routes' jobs and hooks inside the sub-registrations listed in the README.
 */
export function registerPayments(): void {
  assertPaymentsPortsReady();
  registerExportProvider(paymentsExportProvider);
  registerPurgeHandler({ module: 'payments', order: 120, tables: PURGE_TABLES, purge: purgePayments });
  registerRetentionExpiryHandler({ module: 'payments', order: 120, deleteRetained: deleteRetainedPayments });
  registerQueue(PAYMENTS_QUEUE, 'Payments: webhooks, reconcile, receipts, advances, refunds, AutoPay', 10);
  registerPaymentJobs();
  registerBillingHooks();
}
