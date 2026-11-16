import { primaryOwnerUserIds } from '../residents/residents.part3.shared';
import { QueryTypes } from 'sequelize';
import { addMinutes, now } from '../../lib/clock';
import { enqueue } from '../../lib/queue';
import { env } from '../../lib/env';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { Payment, Society, Unit, sequelize } from '../../models';
import type { Ctx } from '../../types/context';
import { AppError, NotFoundError, RateLimitedError } from '../../utils/errors';
import { placeholderFiles, societyPorts } from '../societies/societies.ports';
import { AUDIT, ERR, JOBS, NOTIFY, PAYMENTS_QUEUE } from './payments.constants';
import { paymentsPorts } from './payments.ports';
import { renderReceiptPdf, type ReceiptDocument } from './payments.receipts.pdf';
import { auditPayment, invalidState, n } from './payments.shared';

/**
 * Receipt PDF job `payments:render-receipt`, the download URL (8.5, 8.16) and the resend (8.16). The job renders once per
 * revision and status (`receiptPdfStatus` PENDING to READY; FAILED after 5 attempts, re-queued when somebody asks for the URL
 * at most every 5 minutes), stores the file with purpose `RECEIPT_PDF` and links it to the payment.
 */
export const PDF_ATTEMPTS = 5;
export const PDF_RETRY_MINUTES = 5;
export const RESEND_PER_DAY = 3;
const fileName = (no: string) => `${no.replace(/\//g, '-')}.pdf`;

const METHOD_LABEL: Record<string, string> = {
  UPI: 'UPI',
  CARD: 'Card',
  NETBANKING: 'Net banking',
  WALLET: 'Wallet',
  UPI_AUTOPAY: 'UPI AutoPay',
  ENACH: 'e-NACH',
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  NEFT: 'NEFT',
  IMPS: 'IMPS',
  RTGS: 'RTGS',
  UPI_TO_BANK: 'UPI to bank',
};

async function receiptLines(p: Payment): Promise<ReceiptDocument['lines']> {
  // an issued receipt shows what the payment holds now; a cancelled one shows what it was allocated to
  const live = p.receiptStatus === 'ISSUED';
  const rows = await sequelize.query<{
    targetType: string;
    invoiceNo: string | null;
    title: string | null;
    amountPaise: string;
  }>(
    `SELECT a.targetType, i.invoiceNo, c.title, a.amountPaise
       FROM payment_allocations a
       LEFT JOIN invoices i ON i.id = a.invoiceId
       LEFT JOIN collection_requests r ON r.id = a.collectionRequestId
       LEFT JOIN collections c ON c.id = r.collectionId
      WHERE a.paymentId = :id AND a.source = 'PAYMENT' AND a.amountPaise > 0
        ${live ? 'AND NOT EXISTS (SELECT 1 FROM payment_allocations x WHERE x.reversalOfId = a.id)' : ''}
      ORDER BY a.id`,
    { replacements: { id: n(p.id) }, type: QueryTypes.SELECT },
  );
  const lines: ReceiptDocument['lines'] = rows.map(r => ({
    description: r.targetType === 'INVOICE' ? `Bill ${r.invoiceNo}` : `Contribution: ${r.title}`,
    amountPaise: n(r.amountPaise),
  }));
  const advance = live ? n(p.toAdvancePaise) : 0;
  if (advance > 0) lines.push({ description: 'Advance credited to the flat', amountPaise: advance });
  if (!lines.length) lines.push({ description: 'Payment received', amountPaise: n(p.amountPaise) });
  return lines;
}

export async function documentOf(p: Payment): Promise<ReceiptDocument> {
  const [s, u] = await Promise.all([
    Society.findByPk(n(p.societyId)),
    Unit.findByPk(n(p.unitId), { attributes: ['label'] }),
  ]);
  return {
    receiptNo: p.receiptNo ?? '',
    receiptDate: String(p.receiptDate ?? p.paymentDate).slice(0, 10),
    revision: n(p.receiptRevision),
    cancelled: p.receiptStatus === 'CANCELLED',
    subjectToRealisation: p.method === 'CHEQUE' && (p.status === 'RECEIVED' || p.status === 'DEPOSITED'),
    society: {
      name: s?.legalName ?? s?.name ?? 'Society',
      address: [s?.addressLine1, s?.addressLine2, s?.city, s?.state, s?.pincode].filter(Boolean).join(', '),
      gstin: s?.gstin ?? null,
    },
    payerName: p.payerName,
    unitLabel: u?.label ?? '',
    methodLabel: METHOD_LABEL[p.method] ?? p.method,
    referenceNo: p.referenceNo,
    chequeBankName: p.chequeBankName,
    chequeDate: p.chequeDate ? String(p.chequeDate).slice(0, 10) : null,
    amountPaise: n(p.amountPaise),
    convenienceFeePaise: n(p.convenienceFeePaise),
    convenienceFeeGstPaise: n(p.convenienceFeeGstPaise),
    lines: await receiptLines(p),
  };
}

export type RenderOutcome = 'READY' | 'SKIPPED' | 'FAILED' | 'NOT_FOUND';

/** Body of the job. Returns what happened (the job logs it, tests assert it). */
export async function renderReceiptFor(paymentId: number, retry = false): Promise<RenderOutcome> {
  const row = await Payment.findByPk(paymentId);
  if (!row || row.receiptStatus === 'NONE' || !row.receiptNo) return 'NOT_FOUND';
  if (!(row.receiptPdfStatus === 'PENDING' || (retry && row.receiptPdfStatus === 'FAILED'))) return 'SKIPPED';
  const societyId = n(row.societyId);
  const revision = n(row.receiptRevision);
  const statusAtStart = row.receiptStatus;
  let last: unknown;
  for (let attempt = 1; attempt <= PDF_ATTEMPTS; attempt++) {
    try {
      const doc = await documentOf(row);
      const stored = await societyPorts().files.storeSystemFile({
        societyId,
        purpose: 'RECEIPT_PDF',
        content: renderReceiptPdf(doc),
        name: fileName(row.receiptNo),
        contentType: 'application/pdf',
        ownerUserId: null,
      });
      const replaced = await sequelize.transaction(async t => {
        const fresh = await Payment.findByPk(paymentId, { transaction: t, lock: t.LOCK.UPDATE });
        // a newer revision or status queued its own render: leave the row PENDING for that job
        if (!fresh || n(fresh.receiptRevision) !== revision || fresh.receiptStatus !== statusAtStart)
          return { stale: true as const, old: null };
        const old = fresh.receiptPdfFileId;
        await fresh.update(
          { receiptPdfFileId: stored.fileId, receiptPdfStatus: 'READY' },
          { transaction: t },
        );
        return { stale: false as const, old };
      });
      if (replaced.stale) {
        await societyPorts().files.deleteFile(stored.fileId);
        return 'SKIPPED';
      }
      if (replaced.old && replaced.old !== stored.fileId)
        await societyPorts()
          .files.deleteFile(replaced.old)
          .catch(() => undefined);
      return 'READY';
    } catch (err) {
      last = err;
      logger.warn({ err, paymentId, attempt }, 'receipt PDF render failed');
    }
  }
  await sequelize.transaction(async t => {
    const fresh = await Payment.findByPk(paymentId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!fresh || fresh.receiptPdfStatus === 'READY') return;
    await fresh.update({ receiptPdfStatus: 'FAILED' }, { transaction: t });
  });
  logger.error({ err: last, paymentId }, 'receipt PDF failed after all attempts');
  return 'FAILED';
}

/** Outside production the module 01 placeholder store lives in process memory: render again in place when the file is gone. */
async function ensureStoredOutsideProduction(p: Payment): Promise<Payment> {
  if (env().NODE_ENV === 'production' || p.receiptPdfStatus !== 'READY' || !p.receiptPdfFileId) return p;
  if (placeholderFiles.has(n(p.receiptPdfFileId))) return p;
  await p.update({ receiptPdfStatus: 'PENDING', receiptPdfFileId: null });
  await renderReceiptFor(n(p.id));
  return p.reload();
}

/** `{ url, expiresAt, fileName }` of the receipt PDF (5 minutes). The caller has already checked who may see the payment. */
export async function receiptUrlOf(p: Payment) {
  if (p.receiptStatus === 'NONE' || !p.receiptNo) throw invalidState('This payment has no receipt');
  const row = await ensureStoredOutsideProduction(p);
  if (row.receiptPdfStatus !== 'READY' || !row.receiptPdfFileId) {
    if (row.receiptPdfStatus === 'FAILED') {
      const retryAt = addMinutes(row.updatedAt, PDF_RETRY_MINUTES);
      if (retryAt <= now())
        await enqueue(
          PAYMENTS_QUEUE,
          JOBS.renderReceipt,
          { paymentId: n(row.id), societyId: n(row.societyId), retry: true },
          { jobId: `rcpt-retry:${row.id}:${Math.floor(now().getTime() / 60_000)}` },
        );
    } else if (row.receiptPdfStatus === 'PENDING' || row.receiptPdfStatus === 'NONE') {
      // the render job may have been lost: queue it again (the job id keeps it to one per revision and status)
      await enqueue(
        PAYMENTS_QUEUE,
        JOBS.renderReceipt,
        { paymentId: n(row.id), societyId: n(row.societyId) },
        { jobId: `rcpt:${row.id}:${row.receiptRevision}:${row.receiptStatus}` },
      ).catch(() => undefined);
    }
    throw new AppError(409, ERR.receiptNotReady, 'The receipt is not ready yet');
  }
  const link = await societyPorts().files.downloadUrl(n(row.receiptPdfFileId), 5);
  return { url: link.url, expiresAt: link.expiresAt.toISOString(), fileName: fileName(row.receiptNo ?? '') };
}

export async function adminReceiptUrl(societyId: number, id: number) {
  const p = await Payment.findOne({ where: { id, societyId } });
  if (!p) throw new NotFoundError(ERR.paymentNotFound, 'Payment not found');
  return receiptUrlOf(p);
}

/** 8.16 `POST /payments/:id/receipt/resend`: at most 3 per payment per day. */
export async function resendReceipt(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { channels: ('EMAIL' | 'WHATSAPP' | 'SMS' | 'PUSH')[] },
) {
  const p = await Payment.findOne({ where: { id, societyId } });
  if (!p) throw new NotFoundError(ERR.paymentNotFound, 'Payment not found');
  if (p.receiptStatus !== 'ISSUED' || !p.receiptNo) throw invalidState('This payment has no valid receipt');
  const hit = await kv().slidingWindowHit(`payments:resend:${id}`, 86_400_000, RESEND_PER_DAY);
  if (!hit.allowed) throw new RateLimitedError(hit.retryAfterSeconds);
  await sequelize.transaction(t =>
    auditPayment(ctx, AUDIT.receiptResent, p, null, t, `channels: ${input.channels.join(', ')}`),
  );
  // the payer when known (online); an offline entry has no payer account, so the flat's primary owners get it
  const recipients = p.payerUserId ? [n(p.payerUserId)] : await primaryOwnerUserIds(societyId, n(p.unitId));
  if (recipients.length)
    await paymentsPorts().notifications.send(NOTIFY.receiptIssued, recipients, {
      societyId,
      paymentId: n(p.id),
      receiptNo: p.receiptNo,
      amountPaise: n(p.amountPaise),
      channels: input.channels,
      resend: true,
    });
  return {
    sent: recipients.length ? input.channels.length : 0,
    recipients: recipients.length,
    channels: input.channels,
  };
}
