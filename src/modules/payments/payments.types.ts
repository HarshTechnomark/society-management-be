import type { Transaction } from 'sequelize';
import type { Ctx, SystemCtx } from '../../types/context';
import type {
  AdvanceEntryType,
  AllocReason,
  AllocationMode,
  FeeMethod,
  ItemType,
  PaymentMethod,
  PaymentSource,
} from './payments.constants';

export type { Ctx, SystemCtx, Transaction };
/** `YYYY-MM-DD`. */
export type YmdString = string;
export type AnyCtx = Ctx | SystemCtx;

/** One line of the `payment_orders.items` snapshot (section 7.1). */
export interface OrderItem {
  itemType: ItemType;
  itemId: number | null;
  label: string;
  amountPaise: number;
}

/** A target the allocation engine may fill. */
export interface OpenTarget {
  targetType: 'INVOICE' | 'COLLECTION_REQUEST';
  id: number;
  label: string;
  dueDate: YmdString;
  issueDate: YmdString;
  outstandingPaise: number;
}

/** One planned allocation line of an allocation plan (BR-12-15, BR-12-16). */
export interface PlanLine {
  targetType: 'INVOICE' | 'COLLECTION_REQUEST';
  id: number;
  label: string;
  amountPaise: number;
}
export interface AllocationPlan {
  lines: PlanLine[];
  /** Money above what the lines take: goes to `unit_advances` (`PAYMENT_EXCESS`). */
  advancePaise: number;
}

/** What the capture or the offline approval hands to the core to turn into an effective payment. */
export interface SettleInput {
  societyId: number;
  unitId: number;
  source: PaymentSource;
  method: PaymentMethod;
  /** Status the payment takes: CAPTURED online, CONFIRMED offline, RECEIVED for cheque. */
  status: 'CAPTURED' | 'CONFIRMED' | 'RECEIVED';
  payerUserId: number | null;
  payerName: string;
  amountPaise: number;
  convenienceFeePaise?: number;
  convenienceFeeGstPaise?: number;
  paymentDate: YmdString;
  paymentOrderId?: number | null;
  gatewayAccountId?: number | null;
  gatewayPaymentId?: string | null;
  gatewayMethodDetail?: string | null;
  referenceNo?: string | null;
  referenceKey?: string | null;
  chequeBankName?: string | null;
  chequeDate?: YmdString | null;
  approvalRequestId?: number | null;
  approvedBy?: number | null;
  notes?: string | null;
  needsReview?: boolean;
  reviewReason?: string | null;
  isDuplicateSuspect?: boolean;
  duplicateOfPaymentId?: number | null;
  createdBy?: number | null;
  /** Allocation: oldest first for `duesPaise`, or the chosen items. */
  mode: AllocationMode;
  selected?: { targetType: 'INVOICE' | 'COLLECTION_REQUEST'; id: number; amountPaise: number }[];
  /** `OLDEST_FIRST`: money to put against dues oldest first; the rest of `amountPaise` is advance. */
  duesPaise?: number;
  /** Everything goes to advance (mismatch, duplicate, cancelled order: BR-12-13, BR-12-14). */
  advanceOnly?: boolean;
  /** Payer for `listOpen` visibility (tenants see only their invoices). */
  visibilityUserId?: number;
}

export interface AdvanceEntryInput {
  entryType: AdvanceEntryType;
  amountPaise: number;
  paymentId?: number | null;
  refundId?: number | null;
  invoiceId?: number | null;
  dedupeKey: string;
  narration: string;
}

export interface ReverseOptions {
  reasonCode: AllocReason;
  /** `newestFirst` for refunds freeing money (BR-12-35); default reverses everything live. */
  limitPaise?: number;
  newestFirst?: boolean;
  /** Reversed money goes to advance (`ALLOCATION_RELEASED`) when true (reallocate, refund, invoice cancel); lost when false (bounce/reverse). */
  releaseToAdvance: boolean;
}

export interface PaymentToAudit {
  id: number;
  unitId: number;
  status: string;
  amountPaise: number;
  method: string;
  receiptNo: string | null;
}

export type { FeeMethod };
