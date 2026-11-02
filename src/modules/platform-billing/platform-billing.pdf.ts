/**
 * Invoice and credit note PDF (job `platform-billing:render-pdf`, section 9.1; template of section 16 step 8): A4,
 * supplier, buyer with GSTIN, place of supply, SAC, lines, tax table, amount in words, "Computer-generated invoice" and
 * the payment note. Rendered from the stored snapshot, stored through the billing files port (PRIVATE, purpose
 * `PLATFORM_INVOICE_PDF`), then `pdfStatus = READY`. Skips when READY; after 5 failed attempts the status is FAILED.
 */
import { PlatformInvoice, PlatformInvoiceLine, sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { formatRupees } from '../../lib/money';
import { audit } from '../../utils/audit';
import { billingPorts } from './platform-billing.ports';
import { fmtDate, fmtRange } from './pricing';
import { PAGE_H, PAGE_W, PdfDoc } from './platform-billing.pdf-writer';
import { SYSTEM_CTX, num } from './platform-billing.shared';

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below100 = (n: number): string =>
  n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
const below1000 = (n: number): string =>
  n < 100 ? below100(n) : `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${below100(n % 100)}` : ''}`;

/** `Rupees One Lakh Sixteen Thousand Two Hundred Fifty Two and Seventy Eight Paise Only` (Indian numbering). */
export function amountInWords(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  let rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000);
  rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000);
  rupees %= 1000;
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rupees) parts.push(below1000(rupees));
  const r = parts.length ? parts.join(' ') : 'Zero';
  return `${neg ? 'Minus ' : ''}Rupees ${r}${p ? ` and ${below100(p)} Paise` : ''} Only`;
}

const rs = (p: number) => formatRupees(p);

/** The PDF bytes of a document and its lines. */
export function renderDocument(inv: PlatformInvoice, lines: PlatformInvoiceLine[]): Buffer {
  const credit = inv.documentType === 'CREDIT_NOTE';
  const d = new PdfDoc();
  const L = 40;
  const R = PAGE_W - 40;
  let y = 52;
  d.text(L, y, inv.supplierLegalName ?? 'SocietyApp', { size: 15, bold: true });
  d.text(R, y, credit ? 'CREDIT NOTE' : 'TAX INVOICE', { size: 15, bold: true, align: 'right' });
  y += 16;
  d.text(L, y, inv.supplierAddress ?? '', { size: 8.5, maxWidth: 300 });
  d.text(R, y, `No: ${inv.invoiceNo}`, { size: 10, bold: true, align: 'right' });
  y += 12;
  d.text(L, y, `GSTIN: ${inv.supplierGstin ?? '-'}   State code: ${inv.supplierStateCode ?? '-'}`, {
    size: 8.5,
  });
  d.text(R, y, `Date: ${inv.issueDate ? fmtDate(inv.issueDate) : '-'}`, { size: 9, align: 'right' });
  y += 12;
  if (!credit && inv.dueDate) d.text(R, y, `Due date: ${fmtDate(inv.dueDate)}`, { size: 9, align: 'right' });
  if (credit && inv.originalInvoiceId)
    d.text(R, y, `Reason: ${(inv.creditNoteReason ?? '').replace(/_/g, ' ').toLowerCase()}`, {
      size: 9,
      align: 'right',
    });
  d.text(L, y, `SAC: ${inv.sacCode}   GST rate: ${String(inv.gstRatePct).replace(/\.?0+$/, '')}%`, {
    size: 8.5,
  });
  y += 10;
  d.line(L, y, R, y, 1);
  y += 16;
  d.text(L, y, 'Billed to', { size: 8.5, bold: true });
  d.text(300, y, 'Place of supply', { size: 8.5, bold: true });
  y += 13;
  d.text(L, y, inv.billingName, { size: 10.5, bold: true, maxWidth: 240 });
  d.text(300, y, `${inv.billingStateName} (${inv.placeOfSupplyStateCode})`, { size: 9.5 });
  y += 12;
  d.text(L, y, inv.billingAddress, { size: 8.5, maxWidth: 240 });
  d.text(
    300,
    y,
    inv.taxType === 'INTER_STATE' ? 'Inter-state supply (IGST)' : 'Intra-state supply (CGST and SGST)',
    { size: 8.5 },
  );
  y += 12;
  d.text(L, y, inv.billingGstin ? `GSTIN: ${inv.billingGstin}` : 'GSTIN: not provided (unregistered)', {
    size: 8.5,
  });
  if (inv.periodStart && inv.periodEnd)
    d.text(300, y, `Service period: ${fmtRange(inv.periodStart, inv.periodEnd)}`, { size: 8.5 });
  y += 20;

  // lines table
  const colNo = L + 2;
  const colDesc = L + 24;
  const colQty = 360;
  const colRate = 440;
  const colAmt = R;
  const header = (): void => {
    d.rect(L, y - 11, R - L, 16, 0.92);
    d.text(colNo, y, '#', { size: 8.5, bold: true });
    d.text(colDesc, y, 'Description', { size: 8.5, bold: true });
    d.text(colQty, y, 'Qty', { size: 8.5, bold: true, align: 'right' });
    d.text(colRate, y, 'Rate', { size: 8.5, bold: true, align: 'right' });
    d.text(colAmt, y, 'Amount', { size: 8.5, bold: true, align: 'right' });
    y += 16;
  };
  header();
  for (const l of lines) {
    if (y > PAGE_H - 230) {
      d.addPage();
      y = 60;
      header();
    }
    d.text(colNo, y, String(l.lineNo), { size: 9 });
    d.text(colDesc, y, l.description, { size: 9, maxWidth: colQty - colDesc - 30 });
    d.text(colQty, y, String(l.quantity).replace(/\.?0+$/, ''), { size: 9, align: 'right' });
    d.text(colRate, y, rs(num(l.unitPricePaise)), { size: 9, align: 'right' });
    d.text(colAmt, y, rs(num(l.amountPaise)), { size: 9, align: 'right' });
    y += 14;
  }
  d.line(L, y - 4, R, y - 4);
  y += 10;

  // tax table
  const row = (label: string, v: number, bold = false): void => {
    d.text(colRate + 30, y, label, { size: 9.5, bold, align: 'right' });
    d.text(colAmt, y, rs(v), { size: 9.5, bold, align: 'right' });
    y += 14;
  };
  row('Taxable value', num(inv.subtotalPaise));
  if (num(inv.cgstPaise) || inv.taxType === 'INTRA_STATE') {
    row(`CGST @ ${(Number(inv.gstRatePct) / 2).toString()}%`, num(inv.cgstPaise));
    row(`SGST @ ${(Number(inv.gstRatePct) / 2).toString()}%`, num(inv.sgstPaise));
  }
  if (num(inv.igstPaise) || inv.taxType === 'INTER_STATE')
    row(`IGST @ ${Number(inv.gstRatePct).toString()}%`, num(inv.igstPaise));
  d.line(colRate - 60, y - 6, R, y - 6);
  y += 4;
  row(credit ? 'Credit note total' : 'Invoice total', num(inv.totalPaise), true);
  y += 6;
  d.text(L, y, `Amount in words: ${amountInWords(num(inv.totalPaise))}`, { size: 9, maxWidth: R - L });
  y += 22;
  if (!credit) {
    d.text(L, y, 'Payment', { size: 9, bold: true });
    y += 12;
    d.text(
      L,
      y,
      'Pay online from Settings, Subscription and billing in SocietyApp, or by NEFT, RTGS or IMPS to the company account.',
      { size: 8.5, maxWidth: R - L },
    );
    y += 11;
    d.text(
      L,
      y,
      `Quote ${inv.invoiceNo} as the payment reference and send the transfer details to billing support.`,
      { size: 8.5, maxWidth: R - L },
    );
    y += 18;
  }
  if (inv.notes) {
    d.text(L, y, `Notes: ${inv.notes}`, { size: 8.5, maxWidth: R - L });
    y += 16;
  }
  d.line(L, PAGE_H - 58, R, PAGE_H - 58);
  d.text(
    PAGE_W / 2,
    PAGE_H - 44,
    credit
      ? 'Computer-generated credit note. No signature required.'
      : 'Computer-generated invoice. No signature required.',
    {
      size: 8.5,
      align: 'center',
    },
  );
  return d.build(`${inv.invoiceNo}`);
}

const ATTEMPTS = 5;

/** `platform-billing:render-pdf`: returns what happened (the job logs it, tests assert it). */
export async function renderPdfFor(
  invoiceId: number,
): Promise<'READY' | 'SKIPPED' | 'FAILED' | 'NOT_ISSUED'> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const inv = await PlatformInvoice.findByPk(invoiceId);
      if (!inv || !inv.invoiceNo) return 'NOT_ISSUED';
      if (inv.pdfStatus === 'READY' && inv.pdfFileId) return 'SKIPPED';
      const lines = await PlatformInvoiceLine.findAll({ where: { invoiceId }, order: [['lineNo', 'ASC']] });
      const content = renderDocument(inv, lines);
      const { fileId } = await billingPorts().files.storePdf({
        societyId: inv.societyId,
        name: `${inv.invoiceNo.replace(/\//g, '-')}.pdf`,
        content,
      });
      await sequelize.transaction(async t => {
        const row = await PlatformInvoice.findByPk(invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!row || (row.pdfStatus === 'READY' && row.pdfFileId)) return;
        row.set({ pdfFileId: fileId, pdfStatus: 'READY' });
        await row.save({ transaction: t });
      });
      return 'READY';
    } catch (err) {
      last = err;
      logger.warn({ err, invoiceId, attempt }, 'platform invoice PDF render failed');
    }
  }
  await sequelize.transaction(async t => {
    const row = await PlatformInvoice.findByPk(invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row || row.pdfStatus === 'READY') return;
    row.set({ pdfStatus: 'FAILED' });
    await row.save({ transaction: t });
    await audit(
      SYSTEM_CTX('pdf'),
      {
        action: 'platform_billing.invoice.pdf_failed',
        entityType: 'platform_invoice',
        entityId: invoiceId,
        entityLabel: row.invoiceNo,
        societyId: row.societyId,
        after: { error: last instanceof Error ? last.message : String(last) },
      },
      t,
    );
  });
  return 'FAILED';
}
