/**
 * Helpers shared by the payment, TDS, credit and refund services: lock order (BR-06-23), maker-checker checks
 * (BR-06-30), settlement after money moved (BR-06-24, BR-06-26, BR-06-40) and the payment view.
 */
import { type Transaction } from 'sequelize';
import { PlatformInvoice, PlatformPayment, Society } from '../../models';
import type { PaymentMethod } from '../../models/platform-payment.model';
import { AppError, ConflictError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { emitAfterCommit } from '../societies/societies.notify';
import { OPEN_STATUSES } from './pricing';
import {
  afterSettlement,
  applyCredits,
  lockSociety,
  postCredit,
  settleInvoice,
} from './platform-billing.settlement';

export const num = (v: unknown): number => Number(v ?? 0);
export const actorId = (ctx: Ctx): number | null => ctx.user?.id ?? null;
export const SYSTEM_CTX = (requestId: string): Ctx => ({ requestId, ip: '', userAgent: '' });

export const paymentNotFound = () =>
  new NotFoundError('PLATFORM_PAYMENT_NOT_FOUND', 'Payment, TDS claim or refund not found');
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
export const staleVersion = () =>
  new ConflictError('STALE_VERSION', 'Someone else changed this. Reload to see the change.');
export const makerChecker = () =>
  new ConflictError('MAKER_CHECKER_VIOLATION', 'A second person must approve this');
export const validationFailed = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [{ field, message }]);

/** Pending item checks in the order of section 8: state, version, maker. */
export function assertDecidable(
  ctx: Ctx,
  row: { status: string; version: number; createdBy: number | null },
  pending: string,
  version: number,
  what: string,
): void {
  if (row.status !== pending) throw invalidState(`This ${what} is not waiting for a decision`);
  if (row.version !== version) throw staleVersion();
  if (!ctx.user || row.createdBy === ctx.user.id) throw makerChecker();
}

export const isOpenInvoice = (inv: PlatformInvoice): boolean =>
  inv.documentType === 'INVOICE' && OPEN_STATUSES.includes(inv.status) && num(inv.amountDuePaise) > 0;

export interface PaymentLock {
  society: Society;
  invoice: PlatformInvoice | null;
  payment: PlatformPayment;
}

/**
 * BR-06-23: society, then the invoice, then the payment. `societyId` makes a payment of another society a 404
 * (society routes); `kind` narrows the row type.
 */
export async function lockPayment(
  paymentId: number,
  t: Transaction,
  o: { societyId?: number; kind?: PlatformPayment['kind'] } = {},
): Promise<PaymentLock> {
  const pre = await PlatformPayment.findByPk(paymentId, {
    attributes: ['id', 'societyId', 'invoiceId', 'kind'],
    transaction: t,
  });
  if (!pre || (o.societyId !== undefined && pre.societyId !== o.societyId) || (o.kind && pre.kind !== o.kind))
    throw paymentNotFound();
  const society = await lockSociety(pre.societyId, t);
  const invoice = pre.invoiceId
    ? await PlatformInvoice.findByPk(pre.invoiceId, { transaction: t, lock: t.LOCK.UPDATE })
    : null;
  const payment = await PlatformPayment.findByPk(paymentId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!payment) throw paymentNotFound();
  return { society, invoice, payment };
}

/** BR-06-26 then BR-06-40 when credit settled anything or an invoice became paid. */
export async function settleAfterCredit(
  ctx: Ctx,
  societyId: number,
  t: Transaction,
  alsoPaid: PlatformInvoice[] = [],
): Promise<void> {
  const r = await applyCredits(ctx, societyId, t);
  if (r.applied > 0 || alsoPaid.length) await afterSettlement(ctx, societyId, [...alsoPaid, ...r.paid], t);
}

/**
 * BR-06-24: `applied = min(amount, amountDue)` on an open invoice (0 otherwise), the rest becomes a PAYMENT_EXCESS
 * credit, then BR-06-26 and BR-06-40. Marks the payment CAPTURED (the caller sets the method and other columns first).
 */
export async function applyCapturedPayment(
  ctx: Ctx,
  p: PlatformPayment,
  inv: PlatformInvoice | null,
  capturedAt: Date,
  t: Transaction,
): Promise<{ applied: number; excess: number }> {
  const amount = num(p.amountPaise);
  const applied = inv && isOpenInvoice(inv) ? Math.min(amount, num(inv.amountDuePaise)) : 0;
  const paid: PlatformInvoice[] = [];
  if (applied > 0 && inv) {
    const r = await settleInvoice(ctx, inv, { paidPaise: applied }, t);
    if (r.becamePaid) paid.push(inv);
  }
  const excess = amount - applied;
  if (excess > 0)
    await postCredit(
      ctx,
      { societyId: p.societyId, entryType: 'PAYMENT_EXCESS', amountPaise: excess, paymentId: p.id! },
      t,
    );
  p.set({
    status: 'CAPTURED',
    appliedPaise: applied,
    capturedAt,
    updatedBy: actorId(ctx),
    version: p.version + 1,
  });
  await p.save({ transaction: t });
  await settleAfterCredit(ctx, p.societyId, t, paid);
  return { applied, excess };
}

const METHODS: Record<string, PaymentMethod> = {
  upi: 'UPI',
  card: 'CARD',
  netbanking: 'NETBANKING',
  wallet: 'WALLET',
  emandate: 'EMANDATE',
  upi_autopay: 'UPI_AUTOPAY',
};
/** Gateway method text to the stored enum; anything else stays NULL (no card or VPA data is kept). */
export const gatewayMethod = (m: string | undefined | null): PaymentMethod | null =>
  m ? (METHODS[m.toLowerCase()] ?? null) : null;

export const emitPaymentUpdated = (t: Transaction, p: PlatformPayment): void => {
  if (p.createdBy)
    emitAfterCommit(t, [
      {
        userId: p.createdBy,
        event: 'platform_billing.payment.updated',
        payload: { paymentId: p.id!, status: p.status, invoiceId: p.invoiceId },
      },
    ]);
};

/** Item of 8.7 (society view), with `invoiceNo` filled by the caller. */
export function paymentItem(p: PlatformPayment, invoiceNo: string | null) {
  return {
    id: p.id!,
    kind: p.kind,
    status: p.status,
    method: p.method,
    amountPaise: num(p.amountPaise),
    appliedPaise: num(p.appliedPaise),
    invoiceId: p.invoiceId,
    invoiceNo,
    bankReference: p.bankReference,
    receivedOn: p.receivedOn,
    capturedAt: p.capturedAt ? p.capturedAt.toISOString() : null,
    tdsSection: p.tdsSection,
    deductedOn: p.deductedOn,
    hasCertificate: p.tdsCertificateFileId !== null,
    createdAt: p.createdAt?.toISOString() ?? null,
    version: p.version,
  };
}

/** Platform view of a payment: the item plus the fields the society never sees. */
export function paymentDetail(p: PlatformPayment, invoiceNo: string | null) {
  return {
    ...paymentItem(p, invoiceNo),
    societyId: p.societyId,
    origin: p.origin,
    gatewayOrderId: p.gatewayOrderId,
    gatewayPaymentId: p.gatewayPaymentId,
    gatewayRefundId: p.gatewayRefundId,
    sourcePaymentId: p.sourcePaymentId,
    bankRefKey: p.bankRefKey,
    payerBankName: p.payerBankName,
    payeeReference: p.payeeReference,
    tdsRatePct: p.tdsRatePct === null ? null : String(p.tdsRatePct),
    notes: p.notes,
    reason: p.reason,
    failureReason: p.failureReason,
    rejectedReason: p.rejectedReason,
    approvedBy: p.approvedBy,
    approvedAt: p.approvedAt?.toISOString() ?? null,
    decidedBy: p.decidedBy,
    completedAt: p.completedAt?.toISOString() ?? null,
    createdBy: p.createdBy,
  };
}
