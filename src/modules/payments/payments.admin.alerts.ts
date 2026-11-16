import { logger } from '../../lib/logger';
import { Payment } from '../../models';
import { onAuditCommitted } from '../../utils/audit';
import { usersWithPermission } from '../access-control/access-control.public';
import { AUDIT, NOTIFY, PERM } from './payments.constants';
import { paymentsPorts } from './payments.ports';
import { n } from './payments.shared';

/**
 * `payments.needs_review` and `payments.duplicate_payment` (section 10): when a capture is committed with a review flag, the
 * treasurers (finance.payments.edit) are told; a duplicate suspect also tells the payer. Driven by the committed audit row of
 * the capture, so no core file changes. Never throws.
 */
export async function alertForPayment(societyId: number, paymentId: number): Promise<void> {
  const p = await Payment.findOne({ where: { id: paymentId, societyId } });
  if (!p || (!p.needsReview && !p.isDuplicateSuspect)) return;
  const staff = await usersWithPermission(societyId, PERM.paymentsEdit);
  const data = {
    societyId,
    paymentId,
    receiptNo: p.receiptNo,
    amountPaise: n(p.amountPaise),
    reviewReason: p.reviewReason,
  };
  if (p.needsReview && staff.length)
    await paymentsPorts().notifications.send(NOTIFY.needsReview, staff, data);
  if (p.isDuplicateSuspect) {
    const to = [...new Set([...(p.payerUserId ? [n(p.payerUserId)] : []), ...staff])];
    if (to.length) await paymentsPorts().notifications.send(NOTIFY.duplicatePayment, to, data);
  }
}

const onAudit = (row: {
  societyId: number | null;
  action: string;
  entityType: string;
  entityId: string;
}): void => {
  if (!row.societyId || row.entityType !== 'payment' || row.action !== AUDIT.paymentCaptured) return;
  alertForPayment(row.societyId, Number(row.entityId)).catch(err =>
    logger.error({ err }, 'payment review alert failed'),
  );
};

export const registerPaymentAlerts = (): void => onAuditCommitted(onAudit);
