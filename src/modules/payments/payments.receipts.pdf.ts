import { formatRupees } from '../../lib/money';
import { amountInWords } from '../platform-billing/platform-billing.pdf';
import { PAGE_H, PAGE_W, PdfDoc } from '../platform-billing/platform-billing.pdf-writer';

/**
 * The receipt PDF (BR-12-22 to BR-12-24, F12). Same writer as the bills of module 11 (A4, Helvetica, no dependencies). A
 * cancelled receipt carries a "CANCELLED" banner and keeps its number; a cheque not yet cleared says "Subject to realisation";
 * a revised receipt (after a reallocation) shows its revision; the convenience fee is its own line, never allocated.
 */
export interface ReceiptLine {
  description: string;
  amountPaise: number;
}
export interface ReceiptDocument {
  receiptNo: string;
  receiptDate: string;
  revision: number;
  cancelled: boolean;
  subjectToRealisation: boolean;
  society: { name: string; address: string; gstin: string | null };
  payerName: string;
  unitLabel: string;
  methodLabel: string;
  referenceNo: string | null;
  chequeBankName: string | null;
  chequeDate: string | null;
  amountPaise: number;
  convenienceFeePaise: number;
  convenienceFeeGstPaise: number;
  lines: ReceiptLine[];
}

const rs = (p: number) => formatRupees(p);

export function renderReceiptPdf(doc: ReceiptDocument): Buffer {
  const d = new PdfDoc();
  const L = 40;
  const R = PAGE_W - 40;
  let y = 52;
  d.text(L, y, doc.society.name, { size: 15, bold: true, maxWidth: 330 });
  d.text(R, y, 'RECEIPT', { size: 15, bold: true, align: 'right' });
  y += 16;
  d.text(L, y, doc.society.address, { size: 8.5, maxWidth: 330 });
  d.text(R, y, `No: ${doc.receiptNo}`, { size: 10, bold: true, align: 'right' });
  y += 12;
  if (doc.society.gstin) d.text(L, y, `GSTIN: ${doc.society.gstin}`, { size: 8.5 });
  d.text(R, y, `Date: ${doc.receiptDate}`, { size: 9, align: 'right' });
  y += 12;
  if (doc.revision > 1) d.text(R, y, `Revision ${doc.revision}`, { size: 9, align: 'right' });
  y += 10;
  d.line(L, y, R, y, 1);
  y += 18;
  if (doc.cancelled) {
    d.rect(L, y - 14, R - L, 30, 0.85);
    d.text(PAGE_W / 2, y + 7, 'CANCELLED', { size: 22, bold: true, align: 'center' });
    y += 40;
  }
  d.text(L, y, 'Received from', { size: 8.5, bold: true });
  d.text(300, y, 'Flat', { size: 8.5, bold: true });
  y += 13;
  d.text(L, y, doc.payerName, { size: 10.5, bold: true, maxWidth: 240 });
  d.text(300, y, doc.unitLabel, { size: 10.5 });
  y += 18;
  d.text(L, y, `Mode: ${doc.methodLabel}`, { size: 9 });
  if (doc.referenceNo)
    d.text(300, y, `${doc.chequeBankName ? 'Cheque no' : 'Reference'}: ${doc.referenceNo}`, { size: 9 });
  y += 13;
  if (doc.chequeBankName || doc.chequeDate)
    d.text(
      L,
      y,
      `Drawn on: ${doc.chequeBankName ?? ''}${doc.chequeDate ? `, dated ${doc.chequeDate}` : ''}`,
      { size: 9, maxWidth: R - L },
    );
  y += 18;

  d.rect(L, y - 11, R - L, 16, 0.92);
  d.text(L + 2, y, 'Towards', { size: 8.5, bold: true });
  d.text(R, y, 'Amount', { size: 8.5, bold: true, align: 'right' });
  y += 16;
  for (const l of doc.lines) {
    if (y > PAGE_H - 200) {
      d.addPage();
      y = 60;
    }
    d.text(L + 2, y, l.description, { size: 9, maxWidth: R - L - 110 });
    d.text(R, y, rs(l.amountPaise), { size: 9, align: 'right' });
    y += 14;
  }
  d.line(L, y - 4, R, y - 4);
  y += 10;
  d.text(R - 110, y, 'Amount received', { size: 10, bold: true, align: 'right' });
  d.text(R, y, rs(doc.amountPaise), { size: 10, bold: true, align: 'right' });
  y += 16;
  d.text(L, y, `Amount in words: ${amountInWords(doc.amountPaise)}`, { size: 9, maxWidth: R - L });
  y += 18;
  if (doc.convenienceFeePaise > 0) {
    d.text(L, y, 'Convenience fee (collected for the payment gateway, not society income)', {
      size: 8.5,
      maxWidth: R - L - 110,
    });
    d.text(R, y, rs(doc.convenienceFeePaise + doc.convenienceFeeGstPaise), { size: 8.5, align: 'right' });
    y += 13;
    d.text(
      L,
      y,
      `Total paid by the payer: ${rs(doc.amountPaise + doc.convenienceFeePaise + doc.convenienceFeeGstPaise)}`,
      {
        size: 8.5,
      },
    );
    y += 16;
  }
  if (doc.subjectToRealisation) {
    d.text(L, y, 'Subject to realisation of the cheque.', { size: 9.5, bold: true });
  }
  d.line(L, PAGE_H - 58, R, PAGE_H - 58);
  d.text(PAGE_W / 2, PAGE_H - 44, 'Computer-generated document. No signature required.', {
    size: 8.5,
    align: 'center',
  });
  return d.build(doc.receiptNo);
}
