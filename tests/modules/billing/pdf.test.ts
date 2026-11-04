import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, BillingNote, Invoice, closeDb } from '../../../src/models';
import { advance, now } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { setSocietyPorts, placeholderFiles } from '../../../src/modules/societies/societies.ports';
import { approve } from '../../../src/modules/billing/billing.notes.approvals-hook';
import {
  renderBillingPdf,
  qrMatrix,
  type PdfDocument,
} from '../../../src/modules/billing/billing.pdf.render';
import { billPageUrl, renderPdfFor } from '../../../src/modules/billing/billing.pdf.service';
import { billingPortCalls } from '../../../src/modules/billing/billing.ports';
import { resetLogins } from '../../helpers/access';
import { featureOff } from '../../helpers/society-setup';
import { rawInvoice } from '../../helpers/maint-billing';
import {
  ctxFor,
  idemH,
  invoiceWorld,
  makeInvoice,
  resetInvoices,
  type RunSociety,
} from '../../helpers/billing-invoices';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  resetLogins();
  setSocietyPorts();
  placeholderFiles.clear();
  await resetInvoices();
});
afterEach(() => {
  vi.restoreAllMocks();
  setSocietyPorts();
});

const doc = (o: Partial<PdfDocument> = {}): PdfDocument => ({
  kind: 'INVOICE',
  documentNo: 'INV/2026-27/000123',
  society: { name: 'Sky Heights CHS', address: 'MG Road, Pune, Maharashtra, 411001', gstin: null },
  billToName: 'Anil Deshmukh',
  unitLabel: 'A-1203',
  date: '2026-11-01',
  dueDate: '2026-11-10',
  periodLabel: 'Nov 2026',
  lines: [
    {
      lineNo: 1,
      lineKind: 'CHARGE',
      description: 'Maintenance: 1,150 sq ft x Rs 3.20 (Nov 2026)',
      amountPaise: 368_000,
    },
    { lineNo: 2, lineKind: 'CHARGE', description: 'Parking', amountPaise: 50_000 },
  ],
  subtotalPaise: 418_000,
  totalPaise: 418_000,
  taxed: false,
  previousDuesPaise: 100_000,
  outstandingPaise: 418_000,
  payLink: 'https://app.example.test/pay/invoices/5123',
  ...o,
});
const text = (b: Buffer) => b.toString('latin1');

describe('the renderer (BR-11-67, F19)', () => {
  it('draws a bill with the number, lines, total in words, previous dues, the pay link and a QR code', () => {
    const pdf = renderBillingPdf(doc());
    expect(text(pdf.subarray(0, 8))).toBe('%PDF-1.4');
    expect(text(pdf)).toContain('%%EOF');
    const t = text(pdf);
    expect(t).toContain('INV/2026-27/000123');
    expect(t).toContain('BILL');
    expect(t).toContain('Rupees Four Thousand One Hundred Eighty Only');
    expect(t).toContain('Previous dues');
    expect(t).toContain('earlier bills\\): Rs.1,000');
    expect(t).toContain('Total to pay including previous dues: Rs.5,180');
    expect(t).toContain('https://app.example.test/pay/invoices/5123');
    // each dark QR module is one filled square: the 33x33 or larger code has hundreds of them
    expect((t.match(/ re f/g) ?? []).length).toBeGreaterThan(300);
  });

  it('a taxed bill is titled TAX INVOICE with the society GSTIN; notes are titled credit note and debit note and refer to the bill', () => {
    const taxed = text(
      renderBillingPdf(doc({ taxed: true, society: { name: 'S', address: 'A', gstin: '27AAAAS1234A1Z5' } })),
    );
    expect(taxed).toContain('TAX INVOICE');
    expect(taxed).toContain('GSTIN: 27AAAAS1234A1Z5');
    const cn = text(
      renderBillingPdf(
        doc({
          kind: 'CREDIT_NOTE',
          documentNo: 'CN/2026-27/000001',
          invoiceNo: 'INV/2026-27/000123',
          reason: 'BILLING_ERROR',
          remarks: 'Parking removed',
        }),
      ),
    );
    expect(cn).toContain('CREDIT NOTE');
    expect(cn).toContain('Against bill: INV/2026-27/000123');
    expect(cn).toContain('billing error');
    expect(cn).not.toContain('Pay online');
    expect(text(renderBillingPdf(doc({ kind: 'DEBIT_NOTE', documentNo: 'DN/2026-27/000001' })))).toContain(
      'DEBIT NOTE',
    );
  });

  it('a long bill continues on a second page', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      lineNo: i + 1,
      lineKind: 'CHARGE',
      description: `Charge ${i + 1}`,
      amountPaise: 100,
    }));
    expect(
      (text(renderBillingPdf(doc({ lines, payLink: null }))).match(/\/Type \/Page /g) ?? []).length,
    ).toBe(2);
  });

  it('the QR matrix is a square with the three finder patterns', () => {
    const m = qrMatrix('https://app.example.test/pay/invoices/5123');
    const n = m.length;
    expect(n).toBeGreaterThanOrEqual(21);
    expect(m.every(r => r.length === n)).toBe(true);
    for (const [r0, c0] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ] as const) {
      expect(m[r0]![c0]).toBe(true);
      expect(m[r0 + 3]![c0 + 3]).toBe(true); // the centre of the finder
      expect(m[r0 + 1]![c0 + 1]).toBe(false); // the light ring
    }
  });
});

describe('the billing:render-pdf job and the URLs (9.1, 8.13)', () => {
  const urlOf = (w: RunSociety, id: number) => w.c('get', `/invoices/${id}/pdf-url`);

  it('renders an issued bill once: READY, stored as an INVOICE_PDF file named without personal data, then downloadable for 5 minutes', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    await drainQueues();
    const row = (await Invoice.findByPk(inv.id))!;
    expect(row.pdfStatus).toBe('READY');
    const file = placeholderFiles.get(Number(row.pdfFileId))!;
    expect(file).toMatchObject({
      purpose: 'INVOICE_PDF',
      name: 'INV-2026-27-000001.pdf',
      contentType: 'application/pdf',
      societyId: w.society.id,
    });
    expect(file.name).not.toMatch(/Owner|A-101/);
    expect(text(file.content)).toContain('INV/2026-27/000001');
    expect(text(file.content)).toContain('Owner of A-101');
    // "Pay online" and the QR code go to the resident app's bill page, not the first (platform) origin
    const payLink = `https://my.societyapp.in/resident/bills/${inv.id}`;
    expect(billPageUrl(inv.id)).toBe(payLink);
    expect(new URL(payLink).host).toBe('my.societyapp.in');
    expect(text(file.content)).toContain(payLink);
    expect(text(file.content)).not.toContain('platform.societyapp.in');
    expect(text(file.content)).not.toContain('/pay/invoices/');
    const r = await urlOf(w, inv.id);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      url: `/api/v1/dev/files/${row.pdfFileId}`,
      expiresAt: expect.any(String),
      fileName: 'INV-2026-27-000001.pdf',
    });
    expect(Date.parse(r.body.data.expiresAt) - now().getTime()).toBeGreaterThan(4 * 60_000);
    expect(Date.parse(r.body.data.expiresAt) - now().getTime()).toBeLessThanOrEqual(5 * 60_000);
    // never re-rendered
    const files = placeholderFiles.size;
    expect(await renderPdfFor('invoice', inv.id)).toBe('SKIPPED');
    expect(placeholderFiles.size).toBe(files);
    expect(await renderPdfFor('invoice', 999_999)).toBe('NOT_FOUND');
  });

  it('409 PDF_NOT_READY while the PDF is pending; 404 for an unknown id', async () => {
    const w = await invoiceWorld();
    const raw = await rawInvoice(w.society.id!, w.units[0]!.id, { pdfStatus: 'PENDING' } as never);
    const r = await urlOf(w, Number(raw.id));
    expect([r.status, r.body.code]).toEqual([409, 'PDF_NOT_READY']);
    expect((await urlOf(w, 999_999)).body.code).toBe('INVOICE_NOT_FOUND');
  });

  it('an opening-balance invoice has no file: 409 PDF_NOT_READY', async () => {
    const w = await invoiceWorld();
    const raw = await rawInvoice(w.society.id!, w.units[0]!.id, {
      invoiceType: 'OPENING',
      pdfStatus: 'READY',
      pdfFileId: null,
    } as never);
    expect((await urlOf(w, Number(raw.id))).body.code).toBe('PDF_NOT_READY');
  });

  it('FAILED after 5 attempts: members who can edit billing are told, the URL answers 409 with retryAt, and a retry after 5 minutes renders it', async () => {
    const w = await invoiceWorld();
    let tries = 0;
    setSocietyPorts({
      files: {
        storeSystemFile: async () => {
          tries++;
          throw new Error('disk full');
        },
      },
    });
    const inv = await makeInvoice(w);
    await drainQueues();
    expect(tries).toBe(5);
    expect((await Invoice.findByPk(inv.id))!.pdfStatus).toBe('FAILED');
    const note = billingPortCalls.find(
      c => c.fn === 'notifications.send' && (c.input as any).template === 'billing.document_pdf_failed',
    )!.input as any;
    expect(note.userIds).toContain(w.user.id);
    expect(note.data).toEqual({ documentNo: 'INV/2026-27/000001' });
    const first = await urlOf(w, inv.id);
    expect([first.status, first.body.code]).toEqual([409, 'PDF_NOT_READY']);
    expect(first.body.errors[0].retryAt).toEqual(expect.any(String));
    setSocietyPorts();
    advance(6 * 60_000);
    const again = await urlOf(w, inv.id);
    expect(again.body.code).toBe('PDF_NOT_READY');
    await drainQueues();
    expect((await Invoice.findByPk(inv.id))!.pdfStatus).toBe('READY');
    expect((await urlOf(w, inv.id)).status).toBe(200);
  });

  it('a credit note and a debit note get their own PDF when issued; the note URL needs an issued note', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    const line = inv.lines.find((l: any) => l.headKey === 'PARKING').id;
    const cn = await w.c(
      'post',
      `/invoices/${inv.id}/credit-notes`,
      {
        reasonCode: 'WAIVER',
        remarks: 'Waived by the committee',
        lines: [{ invoiceLineId: line, amountPaise: 1_000 }],
      },
      { headers: idemH() },
    );
    const noteUrl = (id: number) => w.c('get', `/billing/notes/${id}/pdf-url`);
    expect((await noteUrl(cn.body.data.id)).body.code).toBe('NOTE_NOT_FOUND'); // not issued yet
    await approve(cn.body.data.approvalRequestId, ctxFor(w, w.treasurer.user.id!));
    const dn = await w.c(
      'post',
      `/invoices/${inv.id}/debit-notes`,
      {
        reasonCode: 'OTHER',
        remarks: 'Extra work done',
        lines: [{ chargeHeadId: w.heads.PARKING!.id, description: 'Sticker', amountPaise: 5_000 }],
      },
      { headers: idemH() },
    );
    await drainQueues();
    for (const [id, no, title] of [
      [cn.body.data.id, 'CN-2026-27-000001.pdf', 'CREDIT NOTE'],
      [dn.body.data.id, 'DN-2026-27-000001.pdf', 'DEBIT NOTE'],
    ] as const) {
      const r = await noteUrl(id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.fileName).toBe(no);
      const n = (await BillingNote.findByPk(id))!;
      expect(text(placeholderFiles.get(Number(n.pdfFileId))!.content)).toContain(title);
      expect(placeholderFiles.get(Number(n.pdfFileId))!.purpose).toBe('INVOICE_PDF');
    }
    expect(await AuditLog.count({ where: { action: 'billing.credit_note.issued' } })).toBe(1);
  });

  it('the PDF routes need the invoice PDF entitlement (402 FEATURE_NOT_IN_PLAN) but the invoice itself does not', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    await drainQueues();
    await featureOff(w.society.id!, 'billing.invoice_pdf_with_upi_qr');
    const r = await urlOf(w, inv.id);
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    expect((await w.c('get', `/invoices/${inv.id}`)).status).toBe(200);
  });
});
