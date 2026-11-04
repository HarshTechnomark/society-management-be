import qrcode from 'qrcode-generator';
import { formatRupees } from '../../lib/money';
import { amountInWords } from '../platform-billing/platform-billing.pdf';
import { PAGE_H, PAGE_W, PdfDoc } from '../platform-billing/platform-billing.pdf-writer';

/**
 * Bill, credit note and debit note PDFs (BR-11-67, F19). Same writer as the platform invoices of module 06 (A4, Helvetica,
 * text and lines, no dependencies); the QR code is drawn as filled squares from `qrcode-generator` (pure JavaScript). Rendered
 * from stored rows, once. The pay link is the society app's bill page; a UPI QR needs the society's UPI id (module 12), so
 * until then the QR carries the pay link.
 */
export interface PdfLine {
  lineNo: number;
  lineKind: string;
  description: string;
  amountPaise: number;
}
export interface PdfDocument {
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  documentNo: string;
  society: { name: string; address: string; gstin: string | null };
  billToName: string;
  unitLabel: string;
  date: string;
  dueDate?: string | null;
  periodLabel?: string | null;
  invoiceNo?: string;
  reason?: string | null;
  remarks?: string | null;
  lines: PdfLine[];
  subtotalPaise: number;
  totalPaise: number;
  taxed: boolean;
  previousDuesPaise?: number;
  outstandingPaise?: number;
  payLink?: string | null;
}

const rs = (p: number) => formatRupees(p);

/** The QR modules of a text as rows of booleans. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

export function renderBillingPdf(doc: PdfDocument): Buffer {
  const d = new PdfDoc();
  const L = 40;
  const R = PAGE_W - 40;
  let y = 52;
  const title =
    doc.kind === 'CREDIT_NOTE'
      ? 'CREDIT NOTE'
      : doc.kind === 'DEBIT_NOTE'
        ? 'DEBIT NOTE'
        : doc.taxed
          ? 'TAX INVOICE'
          : 'BILL';
  d.text(L, y, doc.society.name, { size: 15, bold: true, maxWidth: 330 });
  d.text(R, y, title, { size: 15, bold: true, align: 'right' });
  y += 16;
  d.text(L, y, doc.society.address, { size: 8.5, maxWidth: 330 });
  d.text(R, y, `No: ${doc.documentNo}`, { size: 10, bold: true, align: 'right' });
  y += 12;
  if (doc.society.gstin) d.text(L, y, `GSTIN: ${doc.society.gstin}`, { size: 8.5 });
  d.text(R, y, `Date: ${doc.date}`, { size: 9, align: 'right' });
  y += 12;
  if (doc.dueDate) d.text(R, y, `Due date: ${doc.dueDate}`, { size: 9, align: 'right' });
  if (doc.invoiceNo) d.text(L, y, `Against bill: ${doc.invoiceNo}`, { size: 8.5 });
  y += 10;
  d.line(L, y, R, y, 1);
  y += 16;
  d.text(L, y, 'Billed to', { size: 8.5, bold: true });
  d.text(300, y, 'Flat', { size: 8.5, bold: true });
  y += 13;
  d.text(L, y, doc.billToName, { size: 10.5, bold: true, maxWidth: 240 });
  d.text(300, y, doc.unitLabel, { size: 10.5 });
  y += 12;
  if (doc.periodLabel) d.text(L, y, `Period: ${doc.periodLabel}`, { size: 9 });
  if (doc.reason) d.text(300, y, `Reason: ${doc.reason.replace(/_/g, ' ').toLowerCase()}`, { size: 9 });
  y += 20;

  const colDesc = L + 24;
  const header = (): void => {
    d.rect(L, y - 11, R - L, 16, 0.92);
    d.text(L + 2, y, '#', { size: 8.5, bold: true });
    d.text(colDesc, y, 'Description', { size: 8.5, bold: true });
    d.text(R, y, 'Amount', { size: 8.5, bold: true, align: 'right' });
    y += 16;
  };
  header();
  for (const l of doc.lines) {
    if (y > PAGE_H - 260) {
      d.addPage();
      y = 60;
      header();
    }
    d.text(L + 2, y, String(l.lineNo), { size: 9 });
    d.text(colDesc, y, l.description, { size: 9, maxWidth: R - colDesc - 90 });
    d.text(R, y, rs(l.amountPaise), { size: 9, align: 'right' });
    y += 14;
  }
  d.line(L, y - 4, R, y - 4);
  y += 10;
  d.text(R - 110, y, doc.kind === 'INVOICE' ? 'Bill total' : 'Note total', {
    size: 10,
    bold: true,
    align: 'right',
  });
  d.text(R, y, rs(doc.totalPaise), { size: 10, bold: true, align: 'right' });
  y += 16;
  d.text(L, y, `Amount in words: ${amountInWords(doc.totalPaise)}`, { size: 9, maxWidth: R - L });
  y += 20;
  if (doc.kind === 'INVOICE') {
    const prev = doc.previousDuesPaise ?? 0;
    if (prev > 0) {
      d.text(L, y, `Previous dues (carried from earlier bills): ${rs(prev)}`, { size: 9 });
      y += 13;
      d.text(L, y, `Total to pay including previous dues: ${rs(prev + doc.totalPaise)}`, {
        size: 9.5,
        bold: true,
      });
      y += 16;
    }
    if (doc.payLink) {
      d.text(L, y, 'Pay online', { size: 9, bold: true });
      y += 12;
      d.text(L, y, doc.payLink, { size: 8.5, maxWidth: 360 });
      const m = qrMatrix(doc.payLink);
      const cell = 2.4;
      const size = m.length * cell;
      const x0 = R - size;
      const y0 = y - 12;
      for (let r = 0; r < m.length; r++)
        for (let c = 0; c < m.length; c++) if (m[r]![c]) d.rect(x0 + c * cell, y0 + r * cell, cell, cell, 0);
      y += Math.max(16, size - 8);
    }
  } else if (doc.remarks) {
    d.text(L, y, `Remarks: ${doc.remarks}`, { size: 8.5, maxWidth: R - L });
    y += 16;
  }
  d.line(L, PAGE_H - 58, R, PAGE_H - 58);
  d.text(PAGE_W / 2, PAGE_H - 44, 'Computer-generated document. No signature required.', {
    size: 8.5,
    align: 'center',
  });
  return d.build(doc.documentNo);
}
