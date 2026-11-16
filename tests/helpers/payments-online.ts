import { Collection, CollectionRequest, PaymentOrder, Society } from '../../src/models';
import { flushAcl } from '../../src/modules/access-control/access-control.cache';
import { idem, residentUser } from './residents';
import { mkInvoice, paymentsWorld, resetPayments } from './payments';
import type { FakePaymentGateway } from '../../src/adapters/payments/payment-gateway';
import type { RunSociety } from './billing-runs';

export { resetPayments, mkInvoice, idem };

export interface OnlineWorld {
  w: RunSociety;
  gw: FakePaymentGateway;
  /** A co-owner of flat A-101 with a resident login (sees every invoice of the flat). */
  payer: Awaited<ReturnType<typeof residentUser>>;
  unitId: number;
  /** A resident of A-102. */
  other: Awaited<ReturnType<typeof residentUser>>;
}

/** A PREMIUM society, a payer on A-101 and another resident on A-102. Call after `resetPayments()`. */
export async function onlineWorld(gw: FakePaymentGateway): Promise<OnlineWorld> {
  const w = await paymentsWorld({ flats: 2 });
  const payer = await residentUser(w.society, w.units[0]!.id, { name: 'Rohan Sharma', relation: 'CO_OWNER' });
  const other = await residentUser(w.society, w.units[1]!.id, { name: 'Priya Nair', relation: 'CO_OWNER' });
  return { w, gw, payer, unitId: w.units[0]!.id, other };
}

/** A published optional collection with one request on the unit. */
export async function mkRequest(
  w: RunSociety,
  unitId: number,
  o: {
    amountMode?: 'FIXED_PER_UNIT' | 'MIN_PER_UNIT' | 'VOLUNTARY';
    amountPaise?: number;
    minPaise?: number;
    title?: string;
  } = {},
) {
  const mode = o.amountMode ?? 'VOLUNTARY';
  const c = await Collection.create({
    societyId: w.society.id!,
    title: o.title ?? 'Ganesh Utsav 2026',
    kind: 'FESTIVAL',
    purpose: 'Festival celebration fund',
    amountMode: mode,
    amountPerUnitPaise: o.amountPaise ?? 110_000,
    minAmountPaise: o.minPaise ?? 0,
    isMandatory: false,
    audienceType: 'ALL',
    audienceIds: null,
    includeVacant: false,
    targetPaise: 1_000_000,
    dueDate: '2026-11-26',
    fundId: 1,
    payListVisibility: 'COUNT_ONLY',
    sendNotice: false,
    status: 'PUBLISHED',
    createdBy: null,
    updatedBy: null,
  } as never);
  const r = await CollectionRequest.create({
    societyId: w.society.id!,
    collectionId: c.id,
    unitId,
    billToResidentId: null,
    amountPaise: o.amountPaise ?? 110_000,
    minAmountPaise: o.minPaise ?? 0,
    paidPaise: 0,
    status: 'OPEN',
    invoiceId: null,
    createdBy: null,
    updatedBy: null,
  } as never);
  return { collection: c, request: r };
}

export const orderOf = (id: number): Promise<PaymentOrder | null> => PaymentOrder.findByPk(id);

/** Moves a society to ACTIVE, SUSPENDED or CLOSED the way module 05 does (cause columns included) and drops the cached access. */
export async function setSocietyStatus(
  societyId: number,
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED',
): Promise<void> {
  const patch =
    status === 'SUSPENDED'
      ? {
          status,
          suspendedAt: new Date(),
          suspensionCause: 'NON_PAYMENT',
          closedAt: null,
          closureReason: null,
        }
      : status === 'CLOSED'
        ? { status, closedAt: new Date(), closureReason: 'OTHER', suspensionCause: null }
        : { status, suspensionCause: null, suspendedAt: null, closedAt: null, closureReason: null };
  await Society.update(patch as never, { where: { id: societyId } });
  await flushAcl();
}
