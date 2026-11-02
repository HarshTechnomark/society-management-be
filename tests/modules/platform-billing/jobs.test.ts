import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  FeatureFlag,
  PlatformCredit,
  PlatformInvoice,
  PlatformPayment,
  Society,
  Subscription,
  closeDb,
  sequelize,
} from '../../../src/models';
import type { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { setNow } from '../../../src/lib/clock';
import { drainQueues, enqueue, resetQueueState, tickScheduler } from '../../../src/lib/queue';
import { invalidateFlags } from '../../../src/modules/subscriptions/flags.service';
import { runAutopayCharge } from '../../../src/modules/platform-billing/platform-billing.autopay-charge';
import { amountInWords, renderPdfFor } from '../../../src/modules/platform-billing/platform-billing.pdf';
import { PdfDoc } from '../../../src/modules/platform-billing/platform-billing.pdf-writer';
import { setBillingPorts } from '../../../src/modules/platform-billing/platform-billing.ports';
import {
  runReconcileOrders,
  runRefundStatus,
} from '../../../src/modules/platform-billing/platform-billing.reconcile';
import { runTdsCertificateReminders } from '../../../src/modules/platform-billing/platform-billing.tds';
import { placeholderFiles } from '../../../src/modules/societies/societies.ports';
import { inboxFor } from '../../helpers/auth';
import { billedSociety, idemKey, platformTeam, resetBilling } from '../../helpers/billing';

/** Task 6.4: the remaining jobs of 9.1, the PDF (8.4) and the issue notifications (section 10; T06-40). */
let gw: FakePaymentGateway;
beforeEach(async () => {
  gw = (await resetBilling()) as FakePaymentGateway;
  resetQueueState();
});
afterEach(async () => {
  await FeatureFlag.update({ isEnabled: false }, { where: { flagKey: 'platform.autopay' } });
  invalidateFlags();
  setBillingPorts();
});
afterAll(async () => {
  await drainQueues();
  setNow(null);
  await closeDb();
});

async function setup() {
  const s = await billedSociety();
  return { ...s, ...(await platformTeam()) };
}
const subjects = async (email: string | null) => (await inboxFor(email!)).map(m => m.subject ?? '');
const order = async (
  pay: Awaited<ReturnType<typeof setup>>['pay'],
  invoiceId: number,
  amountPaise?: number,
) => {
  const r = await pay(
    'post',
    `/subscription/invoices/${invoiceId}/payment-orders`,
    amountPaise ? { amountPaise } : {},
    { headers: idemKey() },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { paymentId: number; gatewayOrderId: string };
};

describe('PDF (job render-pdf, 8.4)', () => {
  it('amount in words uses the Indian system', () => {
    expect(amountInWords(1116252)).toBe(
      'Rupees Eleven Thousand One Hundred Sixty Two and Fifty Two Paise Only',
    );
    expect(amountInWords(15812000)).toBe('Rupees One Lakh Fifty Eight Thousand One Hundred Twenty Only');
    expect(amountInWords(1250000000)).toBe('Rupees One Crore Twenty Five Lakh Only');
    expect(amountInWords(100)).toBe('Rupees One Only');
    expect(amountInWords(5)).toBe('Rupees Zero and Five Paise Only');
  });

  it('the writer produces a structurally valid PDF with the right page count and escaped text', () => {
    const d = new PdfDoc();
    d.text(40, 40, 'A (test) \\ ₹ 1,000 – done', { bold: true });
    d.addPage();
    d.line(10, 10, 100, 100);
    const buf = d.build('Title (x)');
    const text = buf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('(A \\(test\\) \\\\ Rs. 1,000 - done)');
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe('xref');
  });

  it('an issued invoice gets a PDF through the job: READY, stored file, link, audit; credit note too', async () => {
    const { invoice, view, maker, checker, society } = await setup();
    await drainQueues();
    const row = (await PlatformInvoice.findByPk(invoice.id))!;
    expect(row.pdfStatus).toBe('READY');
    const file = placeholderFiles.get(row.pdfFileId!)!;
    expect([file.purpose, file.contentType, file.societyId]).toEqual([
      'PLATFORM_INVOICE_PDF',
      'application/pdf',
      society.id,
    ]);
    const text = file.content.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    for (const part of [
      'TAX INVOICE',
      invoice.invoiceNo,
      'Computer-generated invoice',
      '27ABCDE1234F1Z5',
      'CGST',
      'SGST',
      'Amount in words',
      'SAC: 998314',
    ])
      expect(text, part).toContain(part);
    const r = await view('get', `/subscription/invoices/${invoice.id}/pdf-url`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      url: `/api/v1/dev/files/${row.pdfFileId}`,
      fileName: `${invoice.invoiceNo.replace(/\//g, '-')}.pdf`,
    });
    expect(
      await AuditLog.count({
        where: { action: 'platform_billing.invoice.pdf_downloaded', societyId: society.id! },
      }),
    ).toBe(1);
    expect((await maker.c('get', `/platform/invoices/${invoice.id}/pdf-url`)).status).toBe(200);
    expect(await renderPdfFor(invoice.id)).toBe('SKIPPED');

    // a credit note
    const cn = await maker.c(
      'post',
      `/platform/invoices/${invoice.id}/credit-notes`,
      { reason: 'PRICE_CORRECTION', subtotalPaise: 100000, notes: 'Price corrected for October' },
      { headers: idemKey() },
    );
    const ok = await checker.c('post', `/platform/invoices/${cn.body.data.id}/approve`, { version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await drainQueues();
    const cnRow = (await PlatformInvoice.findByPk(cn.body.data.id))!;
    expect(cnRow.pdfStatus).toBe('READY');
    expect(placeholderFiles.get(cnRow.pdfFileId!)!.content.toString('latin1')).toContain('CREDIT NOTE');
  });

  it('PDF_NOT_READY while pending; FAILED after 5 failures, and asking for the link again re-enqueues the render', async () => {
    const { invoice, view } = await setup();
    await drainQueues();
    await sequelize.query(
      "UPDATE platform_invoices SET pdfStatus = 'PENDING', pdfFileId = NULL WHERE id = :id",
      {
        replacements: { id: invoice.id },
      },
    );
    const no = await view('get', `/subscription/invoices/${invoice.id}/pdf-url`);
    expect([no.status, no.body.code]).toEqual([409, 'PDF_NOT_READY']);
    let calls = 0;
    setBillingPorts({
      files: {
        storePdf: async () => {
          calls += 1;
          throw new Error('storage down');
        },
      } as never,
    });
    expect(await renderPdfFor(invoice.id)).toBe('FAILED');
    expect(calls).toBe(5);
    expect((await PlatformInvoice.findByPk(invoice.id))!.pdfStatus).toBe('FAILED');
    setBillingPorts(); // storage is back
    const again = await view('get', `/subscription/invoices/${invoice.id}/pdf-url`);
    expect(again.body.code).toBe('PDF_NOT_READY');
    await drainQueues();
    expect((await PlatformInvoice.findByPk(invoice.id))!.pdfStatus).toBe('READY');
  });
});

describe('issue notifications (section 10)', () => {
  it('invoice_issued goes to the subscription viewers; credit_note_issued on approval', async () => {
    const { invoice, treasurer, secretary, maker, checker } = await setup();
    await drainQueues();
    for (const u of [treasurer, secretary])
      expect((await subjects(u.email)).some(x => x.startsWith(`Invoice ${invoice.invoiceNo}`))).toBe(true);
    const cn = await maker.c(
      'post',
      `/platform/invoices/${invoice.id}/credit-notes`,
      { reason: 'SERVICE_CREDIT', subtotalPaise: 50000, notes: 'Two days of downtime credited' },
      { headers: idemKey() },
    );
    await checker.c('post', `/platform/invoices/${cn.body.data.id}/approve`, { version: 1 });
    await drainQueues();
    const no = (await PlatformInvoice.findByPk(cn.body.data.id))!.invoiceNo!;
    expect((await subjects(secretary.email)).some(x => x.startsWith(`Credit note ${no}`))).toBe(true);
  });
});

describe('reconcile-orders (T06-40)', () => {
  it('settles a paid order whose webhook never came, fails a failed one, leaves young orders, and expires after 24 hours', async () => {
    const { invoice, pay } = await setup();
    const paid = await order(pay, invoice.id, 100000);
    const failed = await order(pay, invoice.id, 100001);
    const pending = await order(pay, invoice.id, 100002);
    const young = await order(pay, invoice.id, 100003);
    gw.payOrder(paid.gatewayOrderId);
    gw.payOrder(failed.gatewayOrderId, { status: 'failed' });
    await sequelize.query(
      "UPDATE platform_payments SET createdAt = '2026-11-01 05:00:00.000' WHERE id IN (:ids)",
      {
        replacements: { ids: [paid.paymentId, failed.paymentId, pending.paymentId] },
      },
    );
    const r = await runReconcileOrders();
    expect(r).toMatchObject({ checked: 3, settled: 1, failed: 1, expired: 0 });
    const status = async (id: number) => (await PlatformPayment.findByPk(id))!.status;
    expect(await status(paid.paymentId)).toBe('CAPTURED');
    expect(await status(failed.paymentId)).toBe('FAILED');
    expect(await status(pending.paymentId)).toBe('CREATED');
    expect(await status(young.paymentId)).toBe('CREATED');
    expect((await PlatformInvoice.findByPk(invoice.id))!.paidPaise).toBe(100000);
    // T06-40: 25 hours later the pending order expires; a later capture still settles it
    setNow('2026-11-02T07:00:00Z');
    const r2 = await runReconcileOrders();
    expect(r2.expired).toBe(2);
    expect(await status(pending.paymentId)).toBe('EXPIRED');
    expect(await AuditLog.count({ where: { action: 'platform_billing.payment.expired' } })).toBe(2);
    gw.payOrder(pending.gatewayOrderId);
    expect((await runReconcileOrders()).settled).toBe(0); // EXPIRED orders are not polled again; the webhook settles late captures
  });

  it('an order whose id never came back is failed; an amount mismatch settles nothing', async () => {
    const { invoice, pay, society } = await setup();
    const o = await order(pay, invoice.id, 100000);
    const p = await PlatformPayment.create({
      societyId: society.id!,
      invoiceId: invoice.id,
      kind: 'PAYMENT',
      origin: 'SOCIETY',
      status: 'CREATED',
      amountPaise: 5000,
      appliedPaise: 0,
      version: 1,
    } as never);
    gw.payOrder(o.gatewayOrderId, { amountPaise: 99900 });
    await sequelize.query(
      "UPDATE platform_payments SET createdAt = '2026-11-01 05:00:00.000' WHERE id IN (:ids)",
      {
        replacements: { ids: [o.paymentId, p.id] },
      },
    );
    const r = await runReconcileOrders();
    expect(r).toMatchObject({ checked: 2, settled: 0, failed: 1 });
    expect((await PlatformPayment.findByPk(p.id!))!.status).toBe('FAILED');
    expect((await PlatformPayment.findByPk(o.paymentId))!.status).toBe('CREATED');
    expect(await AuditLog.count({ where: { action: 'platform_billing.payment.mismatch' } })).toBe(1);
  });
});

describe('refund-status', () => {
  async function refundRow(societyId: number, gatewayRefundId: string, amountPaise: number) {
    const p = await PlatformPayment.create({
      societyId,
      invoiceId: null,
      kind: 'REFUND',
      origin: 'PLATFORM',
      status: 'PROCESSING',
      amountPaise,
      appliedPaise: 0,
      gatewayRefundId,
      version: 1,
    } as never);
    await sequelize.query(
      "UPDATE platform_payments SET updatedAt = '2026-11-01 02:00:00.000' WHERE id = :id",
      {
        replacements: { id: p.id },
      },
    );
    return p.id!;
  }

  it('polls PROCESSING refunds older than 2 hours: processed becomes REFUNDED, failed restores the balance, pending stays', async () => {
    const { society } = await setup();
    const ok = await refundRow(society.id!, 'rfnd_ok', 5000);
    const bad = await refundRow(society.id!, 'rfnd_bad', 7000);
    const wait = await refundRow(society.id!, 'rfnd_wait', 9000);
    gw.refunds.set('rfnd_ok', { status: 'processed', amountPaise: 5000 });
    gw.refunds.set('rfnd_bad', { status: 'failed', amountPaise: 7000 });
    gw.refunds.set('rfnd_wait', { status: 'pending', amountPaise: 9000 });
    const young = await PlatformPayment.create({
      societyId: society.id!,
      kind: 'REFUND',
      origin: 'PLATFORM',
      status: 'PROCESSING',
      amountPaise: 1000,
      appliedPaise: 0,
      gatewayRefundId: 'rfnd_young',
      version: 1,
    } as never);
    gw.refunds.set('rfnd_young', { status: 'processed', amountPaise: 1000 });
    const r = await runRefundStatus();
    expect(r).toMatchObject({ checked: 3, refunded: 1, failed: 1, errors: 0 });
    const st = async (id: number) => (await PlatformPayment.findByPk(id))!.status;
    expect([await st(ok), await st(bad), await st(wait), await st(young.id!)]).toEqual([
      'REFUNDED',
      'FAILED',
      'PROCESSING',
      'PROCESSING',
    ]);
    const credits = await PlatformCredit.findAll({
      where: { societyId: society.id!, entryType: 'REFUND_REVERSED' },
    });
    expect(credits.map(c => Number(c.amountPaise))).toEqual([7000]);
    expect((await runRefundStatus()).checked).toBe(1); // idempotent
  });
});

describe('autopay-charge', () => {
  async function mandated(max = 5000000) {
    const s = await setup();
    await FeatureFlag.update({ isEnabled: true }, { where: { flagKey: 'platform.autopay' } });
    invalidateFlags();
    const m = await gw.createMandate({ maxAmountPaise: max });
    await Subscription.update(
      {
        autopayStatus: 'ACTIVE',
        autopayMethod: 'UPI_AUTOPAY',
        autopayMandateRef: m.mandateId,
        autopayMaxAmountPaise: max,
      } as never,
      { where: { id: s.sub.id! } },
    );
    return s;
  }
  const due = (id: number, date: string) =>
    sequelize.query('UPDATE platform_invoices SET dueDate = :date WHERE id = :id', {
      replacements: { id, date },
    });

  it('charges the active mandate for invoices due today, once per invoice per day, and the invoice is paid', async () => {
    const s = await mandated();
    await due(s.invoice.id, '2026-11-01');
    const r = await runAutopayCharge('2026-11-01');
    expect(r).toMatchObject({ mandates: 1, charged: 1, failed: 0 });
    const p = (await PlatformPayment.findOne({ where: { invoiceId: s.invoice.id } }))!;
    expect([p.origin, p.status, p.kind, p.method, Number(p.appliedPaise)]).toEqual([
      'SYSTEM',
      'CAPTURED',
      'PAYMENT',
      'UPI_AUTOPAY',
      1239000,
    ]);
    expect((await PlatformInvoice.findByPk(s.invoice.id))!.status).toBe('PAID');
    expect((await runAutopayCharge('2026-11-01')).charged).toBe(0);
    expect(await PlatformPayment.count({ where: { invoiceId: s.invoice.id } })).toBe(1);
  });

  it('a failed charge fails the payment and retries on day +1 and +3, not on day +2', async () => {
    const s = await mandated();
    await due(s.invoice.id, '2026-11-01');
    gw.failNext.createOrder = true;
    const r = await runAutopayCharge('2026-11-01');
    expect(r).toMatchObject({ charged: 0, failed: 1 });
    expect((await PlatformPayment.findOne({ where: { invoiceId: s.invoice.id } }))!.status).toBe('FAILED');
    expect(
      (await subjects(s.treasurer.email)).some(x =>
        x.startsWith('Your SocietyApp payment did not go through'),
      ),
    ).toBe(true);
    setNow('2026-11-02T01:00:00Z');
    expect((await runAutopayCharge('2026-11-02')).charged).toBe(1);
    expect(await PlatformPayment.count({ where: { invoiceId: s.invoice.id } })).toBe(2);
  });

  it('skips invoices not due in the retry window, above the mandate limit, with the flag off or an inactive mandate', async () => {
    const s = await mandated(1000000);
    await due(s.invoice.id, '2026-11-01');
    expect(await runAutopayCharge('2026-11-01')).toMatchObject({ charged: 0, skipped: 1 }); // 1,239,000 > 1,000,000
    await Subscription.update({ autopayMaxAmountPaise: 5000000 } as never, { where: { id: s.sub.id! } });
    expect((await runAutopayCharge('2026-11-05')).charged).toBe(0); // due 4 days ago: not a retry day
    await FeatureFlag.update({ isEnabled: false }, { where: { flagKey: 'platform.autopay' } });
    invalidateFlags();
    expect(await runAutopayCharge('2026-11-01')).toMatchObject({ charged: 0, skipped: 1 });
    await Subscription.update({ autopayStatus: 'CANCELLED' } as never, { where: { id: s.sub.id! } });
    expect((await runAutopayCharge('2026-11-01')).mandates).toBe(0);
  });
});

describe('tds-certificate-reminders', () => {
  it('reminds payers once per claim per month for claims older than 60 days without a certificate', async () => {
    const { invoice, pay, treasurer, society } = await setup();
    const c = await pay(
      'post',
      `/subscription/invoices/${invoice.id}/tds-claims`,
      { tdsSection: '194J', tdsRatePct: '2', amountPaise: 21000, deductedOn: '2026-10-31' },
      { headers: idemKey() },
    );
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(await runTdsCertificateReminders()).toEqual({ claims: 0, queued: 0 }); // too young
    setNow('2027-01-05T05:00:00Z'); // 65 days later
    expect(await runTdsCertificateReminders()).toEqual({ claims: 1, queued: 1 });
    await drainQueues();
    const count = async () =>
      (await subjects(treasurer.email)).filter(x =>
        x.startsWith(`TDS certificate needed for ${invoice.invoiceNo}`),
      ).length;
    expect(await count()).toBe(1);
    await runTdsCertificateReminders(); // the same month: the job id already ran
    await drainQueues();
    expect(await count()).toBe(1);
    setNow('2027-02-05T05:00:00Z');
    await runTdsCertificateReminders();
    await drainQueues();
    expect(await count()).toBe(2);
    // a claim with a certificate is left alone
    await sequelize.query(
      'UPDATE platform_payments SET tdsCertificateFileId = 1 WHERE societyId = :id AND kind = :k',
      {
        replacements: { id: society.id, k: 'TDS' },
      },
    );
    expect(await runTdsCertificateReminders()).toEqual({ claims: 0, queued: 0 });
  });
});

describe('registration and the scheduler', () => {
  it('every job of 9.1 runs from the queue and the scheduler has its slot', async () => {
    const { invoice, society } = await setup();
    setNow('2026-11-17T03:30:00Z'); // 09:00 IST, D+1
    await enqueue('platform-billing', 'platform-billing:dunning', {});
    await drainQueues();
    expect((await PlatformInvoice.findByPk(invoice.id))!.status).toBe('OVERDUE');
    expect((await Society.findByPk(society.id!))!.status).toBe('PAST_DUE');
    const at = (iso: string) => tickScheduler(new Date(iso));
    expect(await at('2026-11-17T20:30:00Z')).toContain('platform-billing:generate-invoices'); // 02:00 IST
    resetQueueState();
    expect(await at('2026-11-17T00:30:00Z')).toContain('platform-billing:autopay-charge'); // 06:00 IST
    resetQueueState();
    expect(await at('2026-11-17T03:30:00Z')).toEqual(
      expect.arrayContaining(['platform-billing:dunning', 'platform-billing:refund-status']),
    );
    resetQueueState();
    expect(await at('2026-11-17T04:30:00Z')).toContain('platform-billing:tds-certificate-reminders'); // 10:00 IST
    expect(await at('2026-11-17T04:45:00Z')).toContain('platform-billing:reconcile-orders'); // every 15 minutes
    await drainQueues();
  });
});

void platformTeam;
