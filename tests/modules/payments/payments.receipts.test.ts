import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, Payment, PaymentWebhookEvent, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { advance } from '../../../src/lib/clock';
import { kv } from '../../../src/lib/kv';
import { placeholderFiles, societyPorts } from '../../../src/modules/societies/societies.ports';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { paymentsPortCalls } from '../../../src/modules/payments/payments.ports';
import { renderReceiptFor } from '../../../src/modules/payments/payments.receipts.service';
import { reversePaymentCore } from '../../../src/modules/payments/payments.reverse.core';
import { runIntegrityCheck } from '../../../src/modules/payments/payments.admin.integrity';
import { successRate } from '../../../src/modules/payments/payments.admin.jobs';
import { idemH } from '../../helpers/billing-runs';
import { mkInvoice, offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { adminOf, residentUser } from '../../helpers/residents';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
  await kv().slidingWindowReset('payments:resend:');
});

type World = Awaited<ReturnType<typeof paymentsWorld>>;
const pay = async (w: World, unit: number, amount: number, o: Parameters<typeof offline>[3] = {}) =>
  (await moneyTx(t => settleInput(sysCtx(w), offline(w, unit, amount, o), t))).payment;
const pdfOf = (fileId: number) => placeholderFiles.get(fileId)!.content.toString('latin1').replace(/\\/g, '');

async function world() {
  const w = await paymentsWorld({ flats: 2 });
  await mkInvoice(w, 0, 500_000, '2026-11-10');
  const p = await pay(w, 0, 600_000);
  return { w, p };
}

describe('receipt PDF job (9.1 payments:render-receipt)', () => {
  it('renders once, stores it as RECEIPT_PDF, sets READY, and skips a second run', async () => {
    const { p } = await world();
    expect((await Payment.findByPk(p.id))!.receiptPdfStatus).toBe('PENDING');
    await drainQueues();
    const row = (await Payment.findByPk(p.id))!;
    expect(row.receiptPdfStatus).toBe('READY');
    const file = placeholderFiles.get(Number(row.receiptPdfFileId))!;
    expect(file).toMatchObject({ purpose: 'RECEIPT_PDF', contentType: 'application/pdf' });
    const text = pdfOf(Number(row.receiptPdfFileId));
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain('RECEIPT');
    expect(text).toContain(row.receiptNo!);
    expect(text).toContain('Advance credited to the flat');
    expect(await renderReceiptFor(Number(p.id))).toBe('SKIPPED');
  });

  it('a cheque not yet cleared says subject to realisation; a convenience fee has its own line', async () => {
    const w = await paymentsWorld({ flats: 1 });
    const chq = await pay(w, 0, 100_000, {
      method: 'CHEQUE',
      status: 'RECEIVED',
      referenceNo: '654321',
      referenceKey: 'CHQ:SBI:654321',
      chequeBankName: 'SBI',
      chequeDate: '2026-11-01',
    });
    const fee = await pay(w, 0, 100_000, {
      source: 'ONLINE',
      method: 'UPI',
      status: 'CAPTURED',
      gatewayPaymentId: 'pay_fee1',
      referenceNo: null,
      referenceKey: null,
      convenienceFeePaise: 1_000,
      convenienceFeeGstPaise: 180,
    });
    await drainQueues();
    const a = pdfOf(Number((await Payment.findByPk(chq.id))!.receiptPdfFileId));
    expect(a).toContain('Subject to realisation');
    expect(a).toContain('SBI');
    const b = pdfOf(Number((await Payment.findByPk(fee.id))!.receiptPdfFileId));
    expect(b).toContain('Convenience fee (collected for the payment gateway, not society income)');
    expect(b).not.toContain('Subject to realisation');
  });

  it('a reversal re-renders it with the CANCELLED banner and keeps the number; the old file is replaced', async () => {
    const { w, p } = await world();
    await drainQueues();
    const first = Number((await Payment.findByPk(p.id))!.receiptPdfFileId);
    await moneyTx(t =>
      reversePaymentCore(
        sysCtx(w),
        Number(p.id),
        { newStatus: 'REVERSED', reversalReasonCode: 'WRONG_ENTRY', reason: 'wrong flat chosen' },
        t,
      ),
    );
    expect((await Payment.findByPk(p.id))!.receiptPdfStatus).toBe('PENDING');
    await drainQueues();
    const row = (await Payment.findByPk(p.id))!;
    expect(row).toMatchObject({ receiptStatus: 'CANCELLED', receiptPdfStatus: 'READY', receiptRevision: 2 });
    expect(Number(row.receiptPdfFileId)).not.toBe(first);
    expect(placeholderFiles.get(first)!.status).toBe('DELETED');
    const text = pdfOf(Number(row.receiptPdfFileId));
    expect(text).toContain('CANCELLED');
    expect(text).toContain(row.receiptNo!);
    expect(text).toContain('Revision 2');
  });

  it('retries 5 times and then marks FAILED; asking for the URL re-queues it after 5 minutes (BR-12 8.5)', async () => {
    const { w, p } = await world();
    await drainQueues();
    await Payment.update({ receiptPdfStatus: 'PENDING', receiptPdfFileId: null }, { where: { id: p.id } });
    const spy = vi.spyOn(societyPorts().files, 'storeSystemFile').mockRejectedValue(new Error('disk full'));
    expect(await renderReceiptFor(Number(p.id))).toBe('FAILED');
    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockRestore();
    expect((await Payment.findByPk(p.id))!.receiptPdfStatus).toBe('FAILED');
    const early = await w.c('get', `/payments/${p.id}/receipt-url`);
    expect([early.status, early.body.code]).toEqual([409, 'RECEIPT_NOT_READY']);
    await drainQueues();
    expect((await Payment.findByPk(p.id))!.receiptPdfStatus).toBe('FAILED');
    advance(6 * 60_000);
    const later = await w.c('get', `/payments/${p.id}/receipt-url`);
    expect(later.body.code).toBe('RECEIPT_NOT_READY');
    await drainQueues();
    expect((await Payment.findByPk(p.id))!.receiptPdfStatus).toBe('READY');
  });
});

describe('receipt URL (8.5, 8.16)', () => {
  it('admin and resident get a 5 minute URL with the file name; PENDING is RECEIPT_NOT_READY', async () => {
    const { w, p } = await world();
    const pending = await w.c('get', `/payments/${p.id}/receipt-url`);
    expect([pending.status, pending.body.code]).toEqual([409, 'RECEIPT_NOT_READY']);
    await drainQueues();
    const r = await w.c('get', `/payments/${p.id}/receipt-url`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.fileName).toBe('RCT-2026-27-000001.pdf');
    expect(r.body.data.url).toContain('/files/');
    expect(Date.parse(r.body.data.expiresAt) - Date.parse('2026-11-04T04:30:00Z')).toBe(5 * 60_000);
    const owner = await residentUser(w.society, w.units[0]!.id, { name: 'Owner A', relation: 'CO_OWNER' });
    const mine = await owner.c('get', `/me/payments/${p.id}/receipt-url`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.data.fileName).toBe('RCT-2026-27-000001.pdf');
    const other = await residentUser(w.society, w.units[1]!.id, { name: 'Owner B', relation: 'CO_OWNER' });
    expect((await other.c('get', `/me/payments/${p.id}/receipt-url`)).status).toBe(404);
  });

  it('a payment without a receipt is INVALID_STATE; another society is PAYMENT_NOT_FOUND', async () => {
    const { w, p } = await world();
    await Payment.update(
      { receiptStatus: 'NONE', receiptNo: null, receiptPdfStatus: 'NONE' },
      { where: { id: p.id } },
    );
    const r = await w.c('get', `/payments/${p.id}/receipt-url`);
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    const other = await paymentsWorld({ flats: 1 });
    expect((await other.c('get', `/payments/${p.id}/receipt-url`)).body.code).toBe('PAYMENT_NOT_FOUND');
  });
});

describe('POST /payments/:id/receipt/resend (8.16)', () => {
  it('sends the receipt again on the chosen channels, audits, and allows 3 a day', async () => {
    const { w, p } = await world();
    const payer = await residentUser(w.society, w.units[0]!.id, { name: 'Payer', relation: 'CO_OWNER' });
    await Payment.update({ payerUserId: payer.user.id }, { where: { id: p.id } });
    paymentsPortCalls.length = 0;
    const go = () =>
      w.c(
        'post',
        `/payments/${p.id}/receipt/resend`,
        { channels: ['EMAIL', 'WHATSAPP'] },
        { headers: idemH() },
      );
    const r = await go();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ sent: 2, recipients: 1, channels: ['EMAIL', 'WHATSAPP'] });
    expect(r.body.message).toBe('Receipt queued on 2 channels');
    const call = paymentsPortCalls.find(c => c.fn === 'notifications.send')!.input as any;
    expect(call).toMatchObject({ template: 'payments.receipt_issued', userIds: [Number(payer.user.id)] });
    expect(call.data.channels).toEqual(['EMAIL', 'WHATSAPP']);
    expect(
      await AuditLog.count({ where: { action: 'payments.receipt.resent', entityId: String(p.id) } }),
    ).toBe(1);
    expect((await go()).status).toBe(200);
    expect((await go()).status).toBe(200);
    const fourth = await go();
    expect([fourth.status, fourth.body.code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('validates channels, needs permission and a receipt', async () => {
    const { w, p } = await world();
    const h = () => ({ headers: idemH() });
    expect((await w.c('post', `/payments/${p.id}/receipt/resend`, { channels: [] }, h())).status).toBe(400);
    expect(
      (await w.c('post', `/payments/${p.id}/receipt/resend`, { channels: ['SMS', 'SMS'] }, h())).status,
    ).toBe(400);
    expect((await w.c('post', `/payments/${p.id}/receipt/resend`, { channels: ['FAX'] }, h())).status).toBe(
      400,
    );
    const viewer = await adminOf(w.society, 'committee_member');
    expect(
      (await viewer.c('post', `/payments/${p.id}/receipt/resend`, { channels: ['SMS'] }, h())).status,
    ).toBe(403);
    await Payment.update({ receiptStatus: 'CANCELLED' }, { where: { id: p.id } });
    const r = await w.c('post', `/payments/${p.id}/receipt/resend`, { channels: ['SMS'] }, h());
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });
});

describe('POST /payments/:id/review-done (8.16)', () => {
  const body = (version: number) => ({ note: 'checked with the bank statement', version });
  async function flagged() {
    const { w } = await world();
    const p = await pay(w, 0, 100_000, {
      source: 'ONLINE',
      method: 'UPI',
      status: 'CAPTURED',
      gatewayPaymentId: 'pay_rev1',
      referenceNo: null,
      referenceKey: null,
    });
    await Payment.update(
      { needsReview: true, reviewReason: 'AMOUNT_MISMATCH', isDuplicateSuspect: true },
      { where: { id: p.id } },
    );
    const ev = await PaymentWebhookEvent.create({
      societyId: w.society.id!,
      gatewayAccountId: 1,
      provider: 'FAKE',
      providerEventId: 'evt_1',
      eventType: 'payment.captured',
      gatewayPaymentId: 'pay_rev1',
      payload: {},
      status: 'NEEDS_REVIEW',
    } as never);
    return { w, p, ev, version: Number((await Payment.findByPk(p.id))!.version) };
  }

  it('clears both flags, marks the linked events processed with the reviewer, audits', async () => {
    const { w, p, ev, version } = await flagged();
    const r = await w.c('post', `/payments/${p.id}/review-done`, body(version));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      needsReview: false,
      isDuplicateSuspect: false,
      version: version + 1,
    });
    const e = (await PaymentWebhookEvent.findByPk(ev.id))!;
    expect(e.status).toBe('PROCESSED');
    expect(Number(e.reviewedBy)).toBe(Number(w.user.id));
    const a = await AuditLog.findOne({
      where: { action: 'payments.payment.review_done', entityId: String(p.id) },
    });
    expect(a!.reason).toBe('checked with the bank statement');
  });

  it('409 INVALID_STATE without a flag, 409 STALE_VERSION, validation', async () => {
    const { w, p, version } = await flagged();
    expect((await w.c('post', `/payments/${p.id}/review-done`, body(version + 5))).body.code).toBe(
      'STALE_VERSION',
    );
    expect((await w.c('post', `/payments/${p.id}/review-done`, { note: 'ok', version })).status).toBe(400);
    expect((await w.c('post', `/payments/${p.id}/review-done`, body(version))).status).toBe(200);
    const again = await w.c('post', `/payments/${p.id}/review-done`, body(version + 1));
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await w.c('post', '/payments/9999999/review-done', body(1))).status).toBe(404);
  });
});

describe('needs_review alert and success rate', () => {
  it('a committed capture with a review flag notifies members with finance.payments.edit', async () => {
    const w = await paymentsWorld({ flats: 1 });
    paymentsPortCalls.length = 0;
    await pay(w, 0, 100_000, {
      source: 'ONLINE',
      method: 'UPI',
      status: 'CAPTURED',
      gatewayPaymentId: 'pay_alert',
      referenceNo: null,
      referenceKey: null,
      needsReview: true,
      reviewReason: 'AMOUNT_MISMATCH',
    } as never);
    await new Promise(r => setTimeout(r, 300));
    const sent = paymentsPortCalls
      .filter(c => c.fn === 'notifications.send')
      .map(c => (c.input as any).template);
    expect(sent).toContain('payments.needs_review');
  });

  it('successRate is CAPTURED over CAPTURED plus FAILED with one decimal, null when nothing', async () => {
    const w = await paymentsWorld({ flats: 1 });
    expect(await successRate(new Date('2026-01-01'))).toBeNull();
    for (let i = 0; i < 2; i++)
      await pay(w, 0, 100_000, {
        source: 'ONLINE',
        method: 'UPI',
        status: 'CAPTURED',
        gatewayPaymentId: `pay_s${i}`,
        referenceNo: null,
        referenceKey: null,
      });
    const [first] = await Payment.findAll();
    await Payment.create({
      ...(first!.toJSON() as object),
      id: undefined,
      status: 'FAILED',
      gatewayPaymentId: 'pay_f',
      receiptNo: null,
      receiptStatus: 'NONE',
      receiptPdfStatus: 'NONE',
      toInvoicesPaise: 0,
      toCollectionsPaise: 0,
      toAdvancePaise: 0,
      referenceKey: null,
      capturedAt: null,
    } as never);
    expect(await successRate(new Date('2026-01-01'))).toBe(66.7);
  });
});

describe('integrity check job (T12-44)', () => {
  it('finds nothing on consistent data and names the broken rows otherwise', async () => {
    await world();
    await drainQueues();
    expect(await runIntegrityCheck()).toEqual([]);
    await sequelize.query('UPDATE unit_advances SET balanceAfterPaise = balanceAfterPaise + 5');
    const issues = await runIntegrityCheck();
    expect(issues.map(i => i.check)).toContain('advance_chain');
  });
});
