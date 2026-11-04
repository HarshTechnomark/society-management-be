import { BillingNote, Invoice, InvoiceLine, Society, sequelize } from '../../models';
import { enqueue } from '../../lib/queue';
import { addMinutes, now } from '../../lib/clock';
import { env } from '../../lib/env';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/errors';
import { usersWithPermission } from '../access-control/access-control.public';
import { societyPorts } from '../societies/societies.ports';
import { BILLING_QUEUE, INVOICE_PDF_PURPOSE, JOBS, PERMISSIONS } from './billing.constants';
import { periodLabelOfInvoice, invoiceNotFound, noteNotFound } from './billing.invoices.shared';
import { renderBillingPdf, type PdfDocument } from './billing.pdf.render';
import { billingPorts } from './billing.ports';

/**
 * The bill PDF (BR-11-67, 9.1 `billing:render-pdf`, 8.13). The job renders once (`pdfStatus` PENDING to READY; FAILED after 5
 * attempts, then `billing.document_pdf_failed` goes to the members who can edit billing), stores the file with purpose
 * `INVOICE_PDF` through the module 01 placeholder file store and links it to the row. A FAILED document is rendered again when
 * somebody asks for its URL (at most once every 5 minutes).
 */
export const PDF_ATTEMPTS = 5;
export const PDF_RETRY_MINUTES = 5;
const fileName = (no: string) => `${no.replace(/\//g, '-')}.pdf`;

async function societyBlock(societyId: number) {
  const s = await Society.findByPk(societyId);
  return {
    name: s?.legalName ?? s?.name ?? 'Society',
    address: [s?.addressLine1, s?.addressLine2, s?.city, s?.state, s?.pincode].filter(Boolean).join(', '),
    gstin: s?.gstin ?? null,
  };
}

async function documentOfInvoice(inv: Invoice): Promise<PdfDocument> {
  const lines = await InvoiceLine.findAll({ where: { invoiceId: inv.id! }, order: [['lineNo', 'ASC']] });
  return {
    kind: 'INVOICE',
    documentNo: inv.invoiceNo,
    society: await societyBlock(Number(inv.societyId)),
    billToName: inv.billToName,
    unitLabel: inv.unitLabel,
    date: inv.invoiceDate,
    dueDate: inv.dueDate,
    periodLabel: periodLabelOfInvoice(inv),
    lines: lines.map(l => ({
      lineNo: l.lineNo,
      lineKind: l.lineKind,
      description: l.description,
      amountPaise: Number(l.amountPaise),
    })),
    subtotalPaise: Number(inv.subtotalPaise),
    totalPaise: Number(inv.totalPaise),
    taxed: Number(inv.taxPaise) > 0,
    previousDuesPaise: Number(inv.previousDuesPaise),
    outstandingPaise: Number(inv.outstandingPaise),
    payLink: `${env().appOrigins[0] ?? ''}/pay/invoices/${inv.id}`,
  };
}

async function documentOfNote(n: BillingNote): Promise<PdfDocument> {
  const inv = await Invoice.findByPk(n.invoiceId);
  const lines = await InvoiceLine.findAll({ where: { billingNoteId: n.id! }, order: [['lineNo', 'ASC']] });
  return {
    kind: n.noteType === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
    documentNo: n.noteNo ?? '',
    society: await societyBlock(Number(n.societyId)),
    billToName: n.billToName,
    unitLabel: inv?.unitLabel ?? '',
    date: n.noteDate ?? '',
    invoiceNo: inv?.invoiceNo,
    reason: n.reasonCode,
    remarks: n.remarks,
    lines: lines.map(l => ({
      lineNo: l.lineNo,
      lineKind: l.lineKind,
      description: l.description,
      amountPaise: Number(l.amountPaise),
    })),
    subtotalPaise: Number(n.subtotalPaise),
    totalPaise: Number(n.totalPaise),
    taxed: Number(n.taxPaise) > 0,
  };
}

export type RenderOutcome = 'READY' | 'SKIPPED' | 'FAILED' | 'NOT_FOUND';

/** `billing:render-pdf`: returns what happened (the job logs it, tests assert it). */
export async function renderPdfFor(
  kind: 'invoice' | 'note',
  id: number,
  retry = false,
): Promise<RenderOutcome> {
  const row = kind === 'invoice' ? await Invoice.findByPk(id) : await BillingNote.findByPk(id);
  if (!row || (kind === 'note' && (row as BillingNote).status !== 'ISSUED')) return 'NOT_FOUND';
  if (!(row.pdfStatus === 'PENDING' || (retry && row.pdfStatus === 'FAILED'))) return 'SKIPPED';
  const societyId = Number(row.societyId);
  const no = kind === 'invoice' ? (row as Invoice).invoiceNo : ((row as BillingNote).noteNo ?? '');
  let last: unknown;
  for (let attempt = 1; attempt <= PDF_ATTEMPTS; attempt++) {
    try {
      const doc =
        kind === 'invoice'
          ? await documentOfInvoice(row as Invoice)
          : await documentOfNote(row as BillingNote);
      const stored = await societyPorts().files.storeSystemFile({
        societyId,
        purpose: INVOICE_PDF_PURPOSE,
        content: renderBillingPdf(doc),
        name: fileName(no),
        contentType: 'application/pdf',
        ownerUserId: null,
      });
      await sequelize.transaction(async t => {
        const m = kind === 'invoice' ? Invoice : BillingNote;
        const fresh = await (m as typeof Invoice).findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!fresh || fresh.pdfStatus === 'READY') return;
        fresh.pdfFileId = stored.fileId;
        fresh.pdfStatus = 'READY';
        await fresh.save({ transaction: t });
      });
      return 'READY';
    } catch (err) {
      last = err;
      logger.warn({ err, kind, id, attempt }, 'billing PDF render failed');
    }
  }
  await sequelize.transaction(async t => {
    const m = kind === 'invoice' ? Invoice : BillingNote;
    const fresh = await (m as typeof Invoice).findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!fresh || fresh.pdfStatus === 'READY') return;
    fresh.pdfStatus = 'FAILED';
    await fresh.save({ transaction: t });
  });
  logger.error({ err: last, kind, id }, 'billing PDF failed after all attempts');
  try {
    const to = await usersWithPermission(societyId, PERMISSIONS.edit);
    if (to.length)
      await billingPorts().notifications.send('billing.document_pdf_failed', to, { documentNo: no });
  } catch (err) {
    logger.error({ err }, 'billing PDF failure notice failed');
  }
  return 'FAILED';
}

async function urlFor(
  kind: 'invoice' | 'note',
  row: { id?: number; pdfStatus: string; pdfFileId: number | null; updatedAt?: Date },
  no: string,
) {
  if (row.pdfStatus !== 'READY' || !row.pdfFileId) {
    if (row.pdfStatus === 'FAILED') {
      const retryAt = addMinutes(row.updatedAt ?? now(), PDF_RETRY_MINUTES);
      if (retryAt <= now())
        await enqueue(
          BILLING_QUEUE,
          JOBS.renderPdf,
          { kind, id: Number(row.id), retry: true },
          { jobId: `pdf-retry:${kind}:${row.id}:${Math.floor(now().getTime() / 60_000)}` },
        );
      throw new AppError(409, 'PDF_NOT_READY', 'The PDF is not ready yet', [
        { field: 'pdf', message: 'Rendering failed; it will be tried again', retryAt: retryAt.toISOString() },
      ]);
    }
    throw new AppError(409, 'PDF_NOT_READY', 'The PDF is not ready yet');
  }
  const link = await societyPorts().files.downloadUrl(row.pdfFileId, 5);
  return { url: link.url, expiresAt: link.expiresAt.toISOString(), fileName: fileName(no) };
}

/** 8.13: `GET /invoices/:id/pdf-url`. */
export async function invoicePdfUrl(societyId: number, id: number) {
  const inv = await Invoice.findOne({ where: { id, societyId } });
  if (!inv) throw invoiceNotFound();
  return urlFor('invoice', inv, inv.invoiceNo);
}

/** 8.13: `GET /billing/notes/:id/pdf-url`. */
export async function notePdfUrl(societyId: number, id: number) {
  const n = await BillingNote.findOne({ where: { id, societyId } });
  if (!n || n.status !== 'ISSUED') throw noteNotFound();
  return urlFor('note', n, n.noteNo ?? '');
}
