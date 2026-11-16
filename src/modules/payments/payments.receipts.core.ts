import { enqueueAfterCommit } from '../../lib/queue';
import type { Payment } from '../../models';
import { nextNumber } from '../../utils/numberSequences';
import { AUDIT, JOBS, PAYMENTS_QUEUE } from './payments.constants';
import { auditPayment, invalidState, n, setting } from './payments.shared';
import type { AnyCtx, Transaction } from './payments.types';

/**
 * Receipts (5.4): one gapless number per effective payment from `nextNumber(societyId, 'RECEIPT')`, inside the same
 * transaction as the payment becoming effective. A reversal or bounce cancels the receipt and keeps the number; a
 * reallocation bumps the revision. The PDF is rendered by the job `payments:render-receipt` (12.3).
 */

/** Queue the PDF render after commit (job id carries revision and status so every state renders once). */
export function enqueueReceiptRender(t: Transaction, p: Payment): void {
  enqueueAfterCommit(
    t,
    PAYMENTS_QUEUE,
    JOBS.renderReceipt,
    { paymentId: n(p.id), societyId: n(p.societyId) },
    { jobId: `rcpt:${p.id}:${p.receiptRevision}:${p.receiptStatus}` },
  );
}

/** BR-12-22: number the payment (`RCT/2026-27/000046`), revision 1, PDF pending. Idempotent: a numbered payment is left alone. */
export async function issueReceipt(ctx: AnyCtx, p: Payment, t: Transaction): Promise<Payment> {
  if (p.receiptNo) return p;
  const societyId = n(p.societyId);
  const prefix = String(await setting(societyId, 'billing.receiptPrefix'));
  const receiptNo = await nextNumber(societyId, 'RECEIPT', {
    date: p.paymentDate,
    prefix,
    transaction: t,
  });
  await p.update(
    {
      receiptNo,
      receiptDate: p.paymentDate,
      receiptStatus: 'ISSUED',
      receiptRevision: 1,
      receiptPdfStatus: 'PENDING',
    },
    { transaction: t },
  );
  await auditPayment(ctx, AUDIT.receiptIssued, p, null, t);
  enqueueReceiptRender(t, p);
  return p;
}

/** Reversal and bounce: `receiptStatus CANCELLED`, number kept, revision + 1, PDF re-rendered with the watermark. */
export async function cancelReceipt(ctx: AnyCtx, p: Payment, t: Transaction): Promise<void> {
  if (p.receiptStatus !== 'ISSUED') return;
  await p.update(
    { receiptStatus: 'CANCELLED', receiptRevision: n(p.receiptRevision) + 1, receiptPdfStatus: 'PENDING' },
    { transaction: t },
  );
  await auditPayment(ctx, AUDIT.receiptCancelled, p, null, t);
  enqueueReceiptRender(t, p);
}

/** BR-12-23: a reallocation keeps the number, bumps the revision and re-renders. */
export async function bumpReceiptRevision(p: Payment, t: Transaction): Promise<void> {
  if (p.receiptStatus === 'NONE') throw invalidState('This payment has no receipt');
  await p.update(
    { receiptRevision: n(p.receiptRevision) + 1, receiptPdfStatus: 'PENDING' },
    { transaction: t },
  );
  enqueueReceiptRender(t, p);
}
