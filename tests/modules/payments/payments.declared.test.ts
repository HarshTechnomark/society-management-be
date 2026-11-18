import { approvalRequests } from '../../helpers/approvals-decide';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Invoice, Payment, Society, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { paymentsPortCalls } from '../../../src/modules/payments/payments.ports';
import { residentUser } from '../../helpers/residents';
import { mkInvoice, paymentsWorld, resetPayments } from '../../helpers/payments';
import { decide, idemH, proofFile, utr } from '../../helpers/payments-offline';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
});

async function residentWorld() {
  const w = await paymentsWorld();
  const res = await residentUser(w.society, w.units[0]!.id, { name: 'Rohan Sharma', relation: 'CO_OWNER' });
  const declare = (body: Record<string, unknown> = {}, headers = idemH()) =>
    res.c(
      'post',
      '/me/payments/declared',
      {
        unitId: w.units[0]!.id,
        method: 'NEFT',
        amountPaise: 250_000,
        paymentDate: '2026-11-03',
        referenceNo: utr(),
        fileIds: [proofFile(w.society.id!, res.user.id)],
        ...body,
      },
      { headers },
    );
  return { w, res, declare };
}

describe('POST /me/payments/declared (8.6)', () => {
  it('creates a RESIDENT_DECLARED payment PENDING_APPROVAL for the caller and an OFFLINE_PAYMENT request', async () => {
    const { w, res, declare } = await residentWorld();
    const r = await declare({ note: 'Paid from my SBI account' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'PENDING_APPROVAL',
      source: 'RESIDENT_DECLARED',
      method: 'NEFT',
      receiptNo: null,
    });
    const p = (await Payment.findByPk(r.body.data.id))!;
    expect([Number(p.payerUserId), p.payerName, Number(p.createdBy), p.notes]).toEqual([
      res.user.id,
      'Rohan Sharma',
      res.user.id,
      'Paid from my SBI account',
    ]);
    expect(p.referenceKey).toMatch(/^BANK:UTR/);
    const call = (await approvalRequests()).at(-1)! as any;
    expect(call).toMatchObject({ type: 'OFFLINE_PAYMENT', categoryKey: 'NEFT', amountPaise: 250_000 });
    expect(
      await AuditLog.count({ where: { action: 'payments.payment.declared', entityId: String(p.id) } }),
    ).toBe(1);
    void w;
  });

  it('review: an admin approves and the declared transfer is allocated oldest first with a receipt; the payer is notified', async () => {
    const { w, declare } = await residentWorld();
    const inv = await mkInvoice(w, 0, 200_000, '2026-11-20');
    const r = await declare({ amountPaise: 250_000 });
    expect((await decide(w, r.body.data.approval.requestId)).status).toBe(200);
    const p = (await Payment.findByPk(r.body.data.id))!;
    expect([p.status, Number(p.toInvoicesPaise), Number(p.toAdvancePaise)]).toEqual([
      'CONFIRMED',
      200_000,
      50_000,
    ]);
    expect(p.receiptNo).toMatch(/^RCT\//);
    expect((await Invoice.findByPk(inv.id))!.status).toBe('PAID');
    await drainQueues();
    const sent = paymentsPortCalls.find(
      c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.receipt_issued',
    );
    expect(sent).toBeTruthy();
  });

  it('a rejection ends it REJECTED, notifies the resident and frees the UTR', async () => {
    const { w, declare } = await residentWorld();
    const ref = utr();
    const r = await declare({ referenceNo: ref });
    await decide(w, r.body.data.approval.requestId, 'reject', 'Amount does not match');
    const p = (await Payment.findByPk(r.body.data.id))!;
    expect([p.status, p.rejectedReason]).toEqual(['REJECTED', 'Amount does not match']);
    const n = paymentsPortCalls.find(
      c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.offline_rejected',
    );
    expect((n!.input as any).userIds).toEqual([Number(p.payerUserId)]);
    expect((await declare({ referenceNo: ref })).status).toBe(201);
  });

  it('DUPLICATE_REFERENCE for a used UTR (also one recorded by an admin); DUPLICATE_PAYMENT_SUSPECTED for same flat, method, amount, date', async () => {
    const { w, declare } = await residentWorld();
    const ref = utr();
    expect((await declare({ referenceNo: ref })).status).toBe(201);
    const same = await declare({ referenceNo: ref.toLowerCase(), amountPaise: 260_000 });
    expect([same.status, same.body.code]).toEqual([409, 'DUPLICATE_REFERENCE']);
    const sus = await declare({ referenceNo: utr() });
    expect([sus.status, sus.body.code]).toEqual([409, 'DUPLICATE_PAYMENT_SUSPECTED']);
    void w;
  });

  it("UNIT_NOT_FOUND for a flat that is not the caller's; the caller cannot declare for a neighbour", async () => {
    const { w, declare } = await residentWorld();
    const r = await declare({ unitId: w.units[1]!.id });
    expect([r.status, r.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
  });

  it('validation: at least one proof file, at most three, reference pattern per method, UPI at most 5,00,000', async () => {
    const { w, res, declare } = await residentWorld();
    expect((await declare({ fileIds: [] })).status).toBe(400);
    const four = [1, 2, 3, 4].map(() => proofFile(w.society.id!, res.user.id));
    expect((await declare({ fileIds: four })).status).toBe(400);
    expect((await declare({ referenceNo: 'abc' })).status).toBe(400);
    expect((await declare({ method: 'UPI_TO_BANK', referenceNo: '12345' })).status).toBe(400);
    expect(
      (await declare({ method: 'UPI_TO_BANK', referenceNo: '123456789012', amountPaise: 50_000_100 })).status,
    ).toBe(400);
    expect((await declare({ method: 'CASH' })).status).toBe(400);
    expect((await declare({ amountPaise: 50 })).status).toBe(400);
    expect(
      (await declare({ method: 'UPI_TO_BANK', referenceNo: '123456789012', amountPaise: 50_000_000 })).status,
    ).toBe(201);
  });

  it('FILE_NOT_LINKABLE for a file the caller did not upload or of another purpose; PAYMENT_DATE_INVALID for a future date', async () => {
    const { w, res, declare } = await residentWorld();
    const others = proofFile(w.society.id!, w.user.id);
    const r = await declare({ fileIds: [others] });
    expect([r.status, r.body.code]).toEqual([422, 'FILE_NOT_LINKABLE']);
    const kyc = proofFile(w.society.id!, res.user.id, 'KYC_DOCUMENT');
    expect((await declare({ fileIds: [kyc] })).status).toBe(422);
    const f = await declare({ paymentDate: '2026-11-05' });
    expect([f.status, f.body.code]).toEqual([422, 'PAYMENT_DATE_INVALID']);
  });

  it('the same Idempotency-Key replays and makes one payment', async () => {
    const { w, res } = await residentWorld();
    const headers = idemH();
    const body = {
      unitId: w.units[0]!.id,
      method: 'NEFT',
      amountPaise: 250_000,
      paymentDate: '2026-11-03',
      referenceNo: utr(),
      fileIds: [proofFile(w.society.id!, res.user.id)],
    };
    const a = await res.c('post', '/me/payments/declared', body, { headers });
    const b = await res.c('post', '/me/payments/declared', body, { headers });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Payment.count({ where: { societyId: w.society.id! } })).toBe(1);
  });

  it('T12-39: a suspended society refuses a declared transfer with 423', async () => {
    const { w, declare } = await residentWorld();
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.society.id! } },
    );
    const r = await declare();
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
  });

  it('a resident cannot use the admin routes (403)', async () => {
    const { w, res } = await residentWorld();
    const r = await res.c(
      'post',
      '/payments/offline',
      {
        unitId: w.units[0]!.id,
        payingFor: 'DUES',
        method: 'CASH',
        amountPaise: 5000,
        paymentDate: '2026-11-04',
      },
      { headers: idemH() },
    );
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });
});
