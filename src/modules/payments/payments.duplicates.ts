import { Op } from 'sequelize';
import { Payment } from '../../models';
import { ConflictError } from '../../utils/errors';
import { ERR, type PaymentMethod } from './payments.constants';
import { n } from './payments.shared';
import type { Transaction } from './payments.types';

/**
 * Duplicate detection (F22, BR-12-14, BR-12-26, BR-12-28). Pure helpers and reads; the offline and online parts call them.
 */

/** BR-12-26: `BANK:<UTR or UPI ref>` or `CHQ:<bank lower-cased, spaces removed>:<chequeNo>`; null for cash and online. */
export function referenceKeyOf(input: {
  method: PaymentMethod;
  referenceNo?: string | null;
  chequeBankName?: string | null;
}): string | null {
  const ref = input.referenceNo?.trim();
  if (!ref) return null;
  if (input.method === 'CHEQUE') {
    const bank = (input.chequeBankName ?? '').toLowerCase().replace(/\s+/g, '');
    return bank ? `CHQ:${bank}:${ref}` : null;
  }
  if (['NEFT', 'IMPS', 'RTGS', 'UPI_TO_BANK'].includes(input.method)) return `BANK:${ref.toUpperCase()}`;
  return null;
}

/** The live payment that already uses this reference key in the society, or null. */
export async function findDuplicateReference(
  societyId: number,
  referenceKey: string | null,
  t?: Transaction,
): Promise<{ id: number } | null> {
  if (!referenceKey) return null;
  const p = await Payment.findOne({ where: { societyId, referenceKey }, attributes: ['id'], transaction: t });
  return p ? { id: n(p.id) } : null;
}

/** BR-12-28: same unit, method, amount and `paymentDate` as a payment that is neither rejected nor failed. */
export async function findDuplicateSuspect(
  societyId: number,
  q: { unitId: number; method: PaymentMethod; amountPaise: number; paymentDate: string; excludeId?: number },
  t?: Transaction,
): Promise<{ id: number } | null> {
  const p = await Payment.findOne({
    where: {
      societyId,
      unitId: q.unitId,
      method: q.method,
      amountPaise: q.amountPaise,
      paymentDate: q.paymentDate,
      status: { [Op.notIn]: ['REJECTED', 'FAILED'] },
      ...(q.excludeId ? { id: { [Op.ne]: q.excludeId } } : {}),
    },
    attributes: ['id'],
    order: [['id', 'ASC']],
    transaction: t,
  });
  return p ? { id: n(p.id) } : null;
}

export async function assertNoDuplicateReference(
  societyId: number,
  referenceKey: string | null,
  t?: Transaction,
): Promise<void> {
  const d = await findDuplicateReference(societyId, referenceKey, t);
  if (d) throw new ConflictError(ERR.duplicateReference, 'This reference is already recorded');
}

/** `409 DUPLICATE_PAYMENT_SUSPECTED` unless `confirmDuplicate` (the caller audits a confirmed duplicate). Returns the other id. */
export async function checkDuplicateSuspect(
  societyId: number,
  q: Parameters<typeof findDuplicateSuspect>[1],
  confirmDuplicate: boolean,
  t?: Transaction,
): Promise<{ id: number } | null> {
  const d = await findDuplicateSuspect(societyId, q, t);
  if (d && !confirmDuplicate) {
    const err = new ConflictError(
      ERR.duplicatePaymentSuspected,
      'A payment with the same flat, method, amount and date is already recorded',
    );
    (err as { errors?: unknown }).errors = [
      { field: 'paymentId', message: 'Already recorded', paymentId: d.id },
    ];
    throw err;
  }
  return d;
}

/** BR-12-14: the first effective payment already recorded for an online order (for `duplicateOfPaymentId`). */
export async function firstPaymentOfOrder(orderId: number, t: Transaction): Promise<number | null> {
  const p = await Payment.findOne({
    where: { paymentOrderId: orderId, status: { [Op.notIn]: ['FAILED', 'REJECTED'] } },
    order: [['id', 'ASC']],
    attributes: ['id'],
    transaction: t,
  });
  return p ? n(p.id) : null;
}
