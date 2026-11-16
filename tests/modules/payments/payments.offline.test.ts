import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Collection,
  CollectionRequest,
  Invoice,
  Payment,
  PaymentAllocation,
  Society,
  closeDb,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import {
  paymentsPortCalls,
  placeholderPaymentApprovalTypes,
  setPaymentsPorts,
} from '../../../src/modules/payments/payments.ports';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { onOfflineApproved } from '../../../src/modules/payments/payments.offline.service';
import { memberOf } from '../../helpers/society-setup';
import { mkInvoice, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import {
  decide,
  idemH,
  proofFile,
  recordAndApprove,
  recordOffline,
  utr,
} from '../../helpers/payments-offline';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
});

const journalCalls = () => paymentsPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any);

describe('POST /payments/offline (8.11)', () => {
  it('creates a PENDING_APPROVAL payment and an OFFLINE_PAYMENT request; nothing is allocated or receipted', async () => {
    const w = await paymentsWorld();
    await mkInvoice(w, 0, 80_000, '2026-11-20');
    const r = await recordOffline(w, 0, { amountPaise: 80_000 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'PENDING_APPROVAL',
      method: 'CASH',
      receiptNo: null,
      version: 1,
    });
    expect(r.body.data.approval).toMatchObject({ status: 'PENDING' });
    const p = (await Payment.findByPk(r.body.data.id))!;
    expect(p.source).toBe('OFFLINE');
    expect(Number(p.approvalRequestId)).toBe(r.body.data.approval.requestId);
    expect(await PaymentAllocation.count({ where: { paymentId: p.id } })).toBe(0);
    const call = paymentsPortCalls.find(c => c.fn === 'approvals.request')!.input as any;
    expect(call).toMatchObject({
      type: 'OFFLINE_PAYMENT',
      entityType: 'payment',
      categoryKey: 'CASH',
      amountPaise: 80_000,
    });
    expect(call.title).toMatch(/^Cash ₹800 from /);
    expect(
      await AuditLog.count({ where: { action: 'payments.payment.recorded', entityId: String(p.id) } }),
    ).toBe(1);
  });

  it('T12-16: another member approves: CONFIRMED, receipt issued, invoice paid, Dr CASH_IN_HAND', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 80_000, '2026-11-20');
    const p = await recordAndApprove(w, 0, { amountPaise: 80_000 });
    expect(p.status).toBe('CONFIRMED');
    expect(p.receiptNo).toMatch(/^RCT\/2026-27\//);
    expect(p.approvedBy).not.toBeNull();
    expect((await Invoice.findByPk(inv.id))!.status).toBe('PAID');
    const j = journalCalls().find(x => x.voucherType === 'RECEIPT')!;
    expect(j.lines[0]).toMatchObject({ accountCode: 'CASH_IN_HAND', debitPaise: 80_000 });
  });

  it('T12-17: the recorder cannot approve their own entry', async () => {
    const w = await paymentsWorld();
    const r = await recordOffline(w, 0);
    const d = await w.c(
      'post',
      `/dev/approvals/${r.body.data.approval.requestId}/approve`,
      {},
      { query: { source: 'payments' } },
    );
    expect([d.status, d.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    expect((await Payment.findByPk(r.body.data.id))!.status).toBe('PENDING_APPROVAL');
  });

  it('a rejection ends it REJECTED with the reason, notifies the recorder and frees the reference', async () => {
    const w = await paymentsWorld();
    const ref = utr();
    const r = await recordOffline(w, 0, { method: 'NEFT', referenceNo: ref });
    const d = await decide(w, r.body.data.approval.requestId, 'reject', 'Not in the statement');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const p = (await Payment.findByPk(r.body.data.id))!;
    expect([p.status, p.rejectedReason, p.referenceKey, p.receiptNo]).toEqual([
      'REJECTED',
      'Not in the statement',
      null,
      null,
    ]);
    const n = paymentsPortCalls.find(
      c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.offline_rejected',
    );
    expect(n).toBeTruthy();
    // the same UTR can be recorded again after a rejection
    expect((await recordOffline(w, 0, { method: 'NEFT', referenceNo: ref })).status).toBe(201);
  });

  it('withdrawal by the recorder and expiry end the payment REJECTED', async () => {
    const w = await paymentsWorld();
    const hooks = placeholderPaymentApprovalTypes.get('OFFLINE_PAYMENT') as any;
    for (const fn of ['onCancelled', 'onExpired'] as const) {
      const r = await recordOffline(w, 0, { amountPaise: 100_100 + (fn === 'onExpired' ? 1 : 0) });
      await moneyTx(t => hooks[fn](sysCtx(w), r.body.data.id, t));
      expect((await Payment.findByPk(r.body.data.id))!.status).toBe('REJECTED');
    }
  });

  it('auto-approval: when module 14 approves inside the call, the response is already CONFIRMED with a receipt', async () => {
    const w = await paymentsWorld();
    const approver = await memberOf(w.society, 'secretary');
    setPaymentsPorts({
      approvals: {
        request: async (ctx, input, t) => {
          const c = { ...ctx, user: { ...ctx.user!, id: approver.user.id } };
          await onOfflineApproved(c as never, input.entityId, t);
          return { id: 777, status: 'APPROVED' };
        },
      },
    });
    const r = await recordOffline(w, 0);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.status).toBe('CONFIRMED');
    expect(r.body.data.receiptNo).toMatch(/^RCT\//);
    expect(r.body.data.approval).toEqual({ requestId: 777, status: 'APPROVED' });
  });

  it('T12-18: cash of 1,50,000 then 60,000 for one flat on one day: the second is CASH_LIMIT_EXCEEDED', async () => {
    const w = await paymentsWorld();
    expect((await recordOffline(w, 0, { amountPaise: 15_000_000 })).status).toBe(201);
    const r = await recordOffline(w, 0, { amountPaise: 6_000_000 });
    expect([r.status, r.body.code]).toEqual([422, 'CASH_LIMIT_EXCEEDED']);
    // another day and another flat are separate
    expect((await recordOffline(w, 0, { amountPaise: 6_000_000, paymentDate: '2026-11-03' })).status).toBe(
      201,
    );
    expect((await recordOffline(w, 1, { amountPaise: 6_000_000 })).status).toBe(201);
    // a rejected cash entry does not count
    const first = await recordOffline(w, 1, { amountPaise: 12_000_000 });
    expect(first.status).toBe(201);
  });

  it('a rejected cash payment is not counted against the limit', async () => {
    const w = await paymentsWorld();
    const a = await recordOffline(w, 0, { amountPaise: 15_000_000 });
    await decide(w, a.body.data.approval.requestId, 'reject');
    expect((await recordOffline(w, 0, { amountPaise: 15_000_000, notes: 'again' })).status).toBe(201);
  });

  it('amount ceilings per method: 5,00,000 for cash, cheque and UPI; 10,00,000 for bank transfers', async () => {
    const w = await paymentsWorld();
    const cash = await recordOffline(w, 0, { amountPaise: 50_000_001, paymentDate: '2026-11-01' });
    expect([cash.status, cash.body.code]).toEqual([422, 'AMOUNT_TOO_LARGE']);
    const upi = await recordOffline(w, 0, { method: 'UPI_TO_BANK', amountPaise: 50_000_001 });
    expect([upi.status, upi.body.code]).toEqual([422, 'AMOUNT_TOO_LARGE']);
    expect((await recordOffline(w, 0, { method: 'RTGS', amountPaise: 100_000_000 })).status).toBe(201);
  });

  it('T12-19: the same UTR twice is DUPLICATE_REFERENCE (case-insensitive); another society may reuse it', async () => {
    const w = await paymentsWorld();
    const ref = utr();
    expect((await recordOffline(w, 0, { method: 'NEFT', referenceNo: ref })).status).toBe(201);
    const r = await recordOffline(w, 1, {
      method: 'NEFT',
      referenceNo: ref.toLowerCase(),
      amountPaise: 300_000,
    });
    expect([r.status, r.body.code]).toEqual([409, 'DUPLICATE_REFERENCE']);
    const other = await paymentsWorld();
    expect((await recordOffline(other, 0, { method: 'NEFT', referenceNo: ref })).status).toBe(201);
  });

  it('the same cheque number of the same bank is a duplicate reference; another bank is not', async () => {
    const w = await paymentsWorld();
    const no = '445566';
    const c = (bankName: string) => ({ bankName, chequeNo: no, chequeDate: '2026-11-04' });
    expect((await recordOffline(w, 0, { method: 'CHEQUE', cheque: c('State Bank') })).status).toBe(201);
    const dup = await recordOffline(w, 1, {
      method: 'CHEQUE',
      cheque: c('state  bank'),
      amountPaise: 200_000,
    });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE_REFERENCE']);
    expect(
      (await recordOffline(w, 1, { method: 'CHEQUE', cheque: c('ICICI Bank'), amountPaise: 200_000 })).status,
    ).toBe(201);
  });

  it('T12-20: same flat, method, amount and date: 409 DUPLICATE_PAYMENT_SUSPECTED, then 201 with confirmDuplicate (audited, flagged)', async () => {
    const w = await paymentsWorld();
    const first = await recordOffline(w, 0, { amountPaise: 120_000 });
    const dup = await recordOffline(w, 0, { amountPaise: 120_000 });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE_PAYMENT_SUSPECTED']);
    expect(dup.body.errors[0].paymentId).toBe(first.body.data.id);
    const ok = await recordOffline(w, 0, { amountPaise: 120_000, confirmDuplicate: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const p = (await Payment.findByPk(ok.body.data.id))!;
    expect([Boolean(p.isDuplicateSuspect), Number(p.duplicateOfPaymentId)]).toEqual([
      true,
      first.body.data.id,
    ]);
    const row = (await AuditLog.findOne({
      where: { action: 'payments.payment.recorded', entityId: String(p.id) },
    }))!;
    expect((row.after as any).confirmDuplicate).toBe(true);
    expect(
      await AuditLog.count({
        where: { action: 'payments.payment.duplicate_flagged', entityId: String(p.id) },
      }),
    ).toBe(1);
  });

  it('T12-40: validation: 99 paise, a five-digit cheque number, a missing or bad reference', async () => {
    const w = await paymentsWorld();
    const low = await recordOffline(w, 0, { amountPaise: 99 });
    expect([low.status, low.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const chq = await recordOffline(w, 0, {
      method: 'CHEQUE',
      cheque: { bankName: 'HDFC Bank', chequeNo: '12345', chequeDate: '2026-11-04' },
    });
    expect(chq.status).toBe(400);
    expect((await recordOffline(w, 0, { method: 'NEFT', referenceNo: 'SHORT1' })).status).toBe(400);
    expect((await recordOffline(w, 0, { method: 'UPI_TO_BANK', referenceNo: '12345' })).status).toBe(400);
    const noRef = await w.c(
      'post',
      '/payments/offline',
      {
        unitId: w.units[0]!.id,
        payingFor: 'DUES',
        method: 'NEFT',
        amountPaise: 5000,
        paymentDate: '2026-11-04',
      },
      { headers: idemH() },
    );
    expect(noRef.status).toBe(400);
    const cashRef = await recordOffline(w, 0, { referenceNo: 'ABC' });
    expect(cashRef.status).toBe(400);
    const coll = await recordOffline(w, 0, { payingFor: 'COLLECTION' });
    expect(coll.status).toBe(400);
  });

  it('payment date: in the future or over 365 days old is PAYMENT_DATE_INVALID; exactly 365 days is fine', async () => {
    const w = await paymentsWorld();
    for (const d of ['2026-11-05', '2025-11-03']) {
      const r = await recordOffline(w, 0, { paymentDate: d });
      expect([r.status, r.body.code], d).toEqual([422, 'PAYMENT_DATE_INVALID']);
    }
    expect((await recordOffline(w, 0, { paymentDate: '2025-11-04' })).status).toBe(201);
  });

  it('a payment date in a locked period is PERIOD_LOCKED', async () => {
    const w = await paymentsWorld();
    setPaymentsPorts({ journal: { isDateLocked: async () => true } });
    const r = await recordOffline(w, 0);
    expect([r.status, r.body.code]).toEqual([422, 'PERIOD_LOCKED']);
    expect(await Payment.count({ where: { societyId: w.society.id! } })).toBe(0);
  });

  it('cheque dates: older than 90 days or more than 90 days ahead is CHEQUE_DATE_INVALID', async () => {
    const w = await paymentsWorld();
    const mk = (chequeDate: string) => ({
      method: 'CHEQUE',
      cheque: {
        bankName: 'HDFC Bank',
        chequeNo: String(200_000 + Number(chequeDate.slice(5, 7)) * 31 + Number(chequeDate.slice(8))),
        chequeDate,
      },
    });
    for (const d of ['2026-08-05', '2027-02-03']) {
      const r = await recordOffline(w, 0, mk(d));
      expect([r.status, r.body.code], d).toEqual([422, 'CHEQUE_DATE_INVALID']);
    }
    expect((await recordOffline(w, 0, mk('2026-08-06'))).status).toBe(201);
    expect((await recordOffline(w, 1, mk('2027-02-02'))).status).toBe(201);
  });

  it('proof files: linked when clean, owned and of the right purpose; otherwise FILE_NOT_LINKABLE', async () => {
    const w = await paymentsWorld();
    const good = proofFile(w.society.id!, w.user.id);
    const ok = await recordOffline(w, 0, { fileIds: [good] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const row = (await AuditLog.findOne({
      where: { action: 'payments.payment.recorded', entityId: String(ok.body.data.id) },
    }))!;
    expect((row.after as any).fileIds).toEqual([good]);
    const detail = (await w.c('get', `/payments/${ok.body.data.id}`)).body.data;
    expect(detail.proofFiles).toEqual([{ id: good, name: expect.any(String) }]);
    for (const fid of [
      proofFile(w.society.id!, w.user.id, 'KYC_DOCUMENT'),
      proofFile(w.society.id!, w.treasurer.user.id),
      proofFile(999999, w.user.id),
      good,
      424242,
    ]) {
      const r = await recordOffline(w, 0, { amountPaise: 123_400, fileIds: [fid] });
      expect([r.status, r.body.code], String(fid)).toEqual([422, 'FILE_NOT_LINKABLE']);
    }
    expect((await recordOffline(w, 0, { fileIds: [1, 2, 3, 4] })).status).toBe(400);
  });

  it('the same Idempotency-Key twice makes one payment and replays', async () => {
    const w = await paymentsWorld();
    const headers = idemH();
    const body = {
      unitId: w.units[0]!.id,
      payingFor: 'DUES',
      method: 'CASH',
      amountPaise: 50_000,
      paymentDate: '2026-11-04',
    };
    const a = await w.c('post', '/payments/offline', body, { headers });
    const b = await w.c('post', '/payments/offline', body, { headers });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Payment.count({ where: { societyId: w.society.id! } })).toBe(1);
  });

  it('unknown flat is UNIT_NOT_FOUND; a flat of another society too', async () => {
    const w = await paymentsWorld();
    const o = await paymentsWorld();
    for (const unitId of [999_999_999, o.units[0]!.id]) {
      const r = await w.c(
        'post',
        '/payments/offline',
        { unitId, payingFor: 'DUES', method: 'CASH', amountPaise: 5000, paymentDate: '2026-11-04' },
        { headers: idemH() },
      );
      expect([r.status, r.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    }
  });

  it('T12-36: a member without finance.payments.create gets 403', async () => {
    const w = await paymentsWorld();
    const member = await memberOf(w.society, 'committee_member');
    const r = await member.c(
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

  it('T12-39: a suspended society refuses an offline record with 423', async () => {
    const w = await paymentsWorld();
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.society.id! } },
    );
    const r = await recordOffline(w, 0);
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
  });

  it('the development approvals page lists the pending request with source payments', async () => {
    const w = await paymentsWorld();
    const r = await recordOffline(w, 0);
    const list = await w.c('get', '/dev/approvals');
    const row = list.body.data.find(
      (a: any) => a.source === 'payments' && a.id === r.body.data.approval.requestId,
    );
    expect(row).toMatchObject({ type: 'OFFLINE_PAYMENT', entityId: r.body.data.id });
  });

  describe('paying for a collection (BR-12-18)', () => {
    async function collectionWorld(
      mode: 'FIXED_PER_UNIT' | 'MIN_PER_UNIT' | 'VOLUNTARY',
      o: { mandatory?: boolean; status?: string } = {},
    ) {
      const w = await paymentsWorld();
      const c = await Collection.create({
        societyId: w.society.id!,
        title: 'Ganesh Utsav',
        kind: 'FESTIVAL',
        purpose: 'Festival celebration fund',
        amountMode: mode,
        amountPerUnitPaise: mode === 'FIXED_PER_UNIT' ? 110_000 : mode === 'MIN_PER_UNIT' ? 50_000 : 0,
        minAmountPaise: mode === 'MIN_PER_UNIT' ? 50_000 : 0,
        isMandatory: o.mandatory ?? false,
        audienceType: 'ALL',
        audienceIds: null,
        includeVacant: true,
        targetPaise: 1_000_000,
        dueDate: '2026-12-01',
        fundId: 1,
        payListVisibility: 'COUNT_ONLY',
        sendNotice: false,
        status: o.status ?? 'PUBLISHED',
        createdBy: w.user.id,
      } as never);
      const req = await CollectionRequest.create({
        societyId: w.society.id!,
        collectionId: c.id,
        unitId: w.units[0]!.id,
        amountPaise: mode === 'FIXED_PER_UNIT' ? 110_000 : 0,
        minAmountPaise: mode === 'MIN_PER_UNIT' ? 50_000 : 0,
        paidPaise: 0,
        status: 'OPEN',
      } as never);
      return { w, c, req };
    }
    const forCollection = (w: any, requestId: number, amountPaise: number) =>
      recordOffline(w, 0, { payingFor: 'COLLECTION', collectionRequestId: requestId, amountPaise });

    it('a fixed collection paid in cash goes to the request on approval, not to the invoices', async () => {
      const { w, req } = await collectionWorld('FIXED_PER_UNIT');
      const inv = await mkInvoice(w, 0, 80_000, '2026-11-20');
      const r = await forCollection(w, req.id!, 110_000);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await decide(w, r.body.data.approval.requestId)).status).toBe(200);
      const p = (await Payment.findByPk(r.body.data.id))!;
      expect([Number(p.toCollectionsPaise), Number(p.toInvoicesPaise), Number(p.toAdvancePaise)]).toEqual([
        110_000, 0, 0,
      ]);
      expect((await CollectionRequest.findByPk(req.id!))!.status).toBe('PAID');
      expect((await Invoice.findByPk(inv.id))!.status).toBe('ISSUED');
    });

    it('amount rules: fixed above the remaining, minimum below the floor, above 1,00,000', async () => {
      const f = await collectionWorld('FIXED_PER_UNIT');
      const over = await forCollection(f.w, f.req.id!, 110_100);
      expect([over.status, over.body.code]).toEqual([422, 'AMOUNT_EXCEEDS_DUE']);
      const m = await collectionWorld('MIN_PER_UNIT');
      const low = await forCollection(m.w, m.req.id!, 49_900);
      expect([low.status, low.body.code]).toEqual([422, 'AMOUNT_BELOW_MINIMUM']);
      expect((await forCollection(m.w, m.req.id!, 50_000)).status).toBe(201);
      const big = await forCollection(m.w, m.req.id!, 10_000_100);
      expect([big.status, big.body.code]).toEqual([422, 'AMOUNT_TOO_LARGE']);
    });

    it('not found when the request is another flat, mandatory, unpublished or unknown', async () => {
      const { w, req } = await collectionWorld('VOLUNTARY');
      const wrongUnit = await recordOffline(w, 1, { payingFor: 'COLLECTION', collectionRequestId: req.id });
      expect([wrongUnit.status, wrongUnit.body.code]).toEqual([404, 'COLLECTION_REQUEST_NOT_FOUND']);
      const unknown = await forCollection(w, 987_654_321, 10_000);
      expect(unknown.status).toBe(404);
      const mand = await collectionWorld('FIXED_PER_UNIT', { mandatory: true });
      expect((await forCollection(mand.w, mand.req.id!, 110_000)).status).toBe(404);
      const draft = await collectionWorld('VOLUNTARY', { status: 'CLOSED' });
      expect((await forCollection(draft.w, draft.req.id!, 10_000)).status).toBe(404);
    });
  });
});
