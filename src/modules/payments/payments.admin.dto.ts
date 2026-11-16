import type { Payment } from '../../models';
import { receiptDebitAccount } from './payments.journal';
import { n } from './payments.shared';

/** Payment shapes of section 8.1: the admin item, the resident item (no admin fields) and the "lands in" hint. */
export const dateOnly = (v: unknown): string | null =>
  v == null ? null : typeof v === 'string' ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10);
export const isoOrNull = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

type WithUnit = Payment & { Unit?: { label?: string } | null };

export function residentItem(p: Payment, unitLabel: string) {
  return {
    id: n(p.id),
    unitId: n(p.unitId),
    unitLabel,
    payerName: p.payerName,
    source: p.source,
    method: p.method,
    status: p.status,
    amountPaise: n(p.amountPaise),
    convenienceFeePaise: n(p.convenienceFeePaise),
    convenienceFeeGstPaise: n(p.convenienceFeeGstPaise),
    grossAmountPaise: n(p.grossAmountPaise),
    toInvoicesPaise: n(p.toInvoicesPaise),
    toCollectionsPaise: n(p.toCollectionsPaise),
    toAdvancePaise: n(p.toAdvancePaise),
    refundedPaise: n(p.refundedPaise),
    paymentDate: dateOnly(p.paymentDate),
    capturedAt: isoOrNull(p.capturedAt),
    receiptNo: p.receiptNo,
    receiptStatus: p.receiptStatus,
    referenceNo: p.referenceNo,
    version: n(p.version),
  };
}

export function adminItem(p: WithUnit, unitLabel?: string) {
  return {
    ...residentItem(p, unitLabel ?? p.Unit?.label ?? ''),
    needsReview: Boolean(p.needsReview),
    isDuplicateSuspect: Boolean(p.isDuplicateSuspect),
  };
}

/** Where the money lands in the books: a hint for the screen (the journal account of the receipt). */
export const landsIn = (p: Pick<Payment, 'source' | 'method' | 'status'>): string => receiptDebitAccount(p);
