import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Collection,
  CollectionRequest,
  Invoice,
  Payment,
  PaymentAllocation,
  PaymentOrder,
  UnitAdvance,
  UnitLedgerEntry,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import {
  clearOrderHooks,
  registerOrderHook,
  settleCapture,
  settleCaptureTx,
} from '../../../src/modules/payments/payments.settle';
import {
  FAKE_WEBHOOK_SECRET,
  fakeGatewayAccount,
  paymentsPortCalls,
  paymentsPorts,
  setPaymentsPorts,
} from '../../../src/modules/payments/payments.ports';
import { refreshCollectionTotals } from '../../../src/modules/payments/payments.alloc.totals';
import { advanceBalance } from '../../../src/modules/payments/payments.advances';
import { offline, mkInvoice, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { settleInput } from '../../../src/modules/payments/payments.settle';

let gw: FakePaymentGateway;
afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  gw = await resetPayments();
  clearOrderHooks();
});

async function orderFor(
  w: Awaited<ReturnType<typeof paymentsWorld>>,
  invoiceId: number,
  base: number,
  o: { fee?: number; status?: string; items?: unknown[] } = {},
) {
  const fee = o.fee ?? 0;
  const gross = base + fee;
  const acct = fakeGatewayAccount(w.society.id!);
  const go = await gw.createOrder({
    societyGatewayAccountId: String(acct.id),
    amountPaise: gross,
    receipt: 'r',
    notes: {},
  });
  const order = await PaymentOrder.create({
    societyId: w.society.id!,
    unitId: w.units[0]!.id,
    sourceType: 'PAY_LIST',
    allocationMode: 'SELECTED',
    items: o.items ?? [{ itemType: 'INVOICE', itemId: invoiceId, label: 'INV', amountPaise: base }],
    basePaise: base,
    convenienceFeePaise: fee,
    convenienceFeeGstPaise: 0,
    grossAmountPaise: gross,
    gatewayAccountId: acct.id,
    gatewayOrderId: go.orderId,
    status: (o.status ?? 'CREATED') as never,
    expiresAt: new Date('2026-11-04T05:00:00Z'),
  } as never);
  return { order, go, acct };
}

describe('settleCapture (6.8)', () => {
  it('captures once: payment, allocation, receipt, ledger, journal with the fee line, order PAID', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const { order, go, acct } = await orderFor(w, Number(inv.id), 100_000, { fee: 2_000 });
    const p = gw.payOrder(go.orderId);
    const out = await settleCaptureTx(acct.id, p.paymentId);
    expect(out).toMatchObject({ outcome: 'SETTLED', needsReview: false, duplicate: false });
    const pay = (await Payment.findOne({ where: { gatewayPaymentId: p.paymentId } }))!;
    expect(pay).toMatchObject({ status: 'CAPTURED', source: 'ONLINE', method: 'UPI' });
    expect([Number(pay.amountPaise), Number(pay.convenienceFeePaise), Number(pay.grossAmountPaise)]).toEqual([
      100_000, 2_000, 102_000,
    ]);
    expect(Number((await Invoice.findByPk(inv.id))!.outstandingPaise)).toBe(0);
    expect((await PaymentOrder.findByPk(order.id))!.status).toBe('PAID');
    const j = paymentsPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any)[0];
    expect(j.lines.find((l: any) => l.accountCode === 'GATEWAY_CLEARING').debitPaise).toBe(102_000);
    expect(j.lines.find((l: any) => l.accountCode === 'GATEWAY_FEE_RECOVERY').creditPaise).toBe(2_000);
    const led = await UnitLedgerEntry.findOne({ where: { refId: pay.id, entryType: 'PAYMENT' } });
    expect(Number(led!.creditPaise)).toBe(100_000);
    await drainQueues();
  });

  it('a repeated capture of the same gateway payment changes nothing (BR-12-11)', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const { go, acct } = await orderFor(w, Number(inv.id), 100_000);
    const p = gw.payOrder(go.orderId);
    await settleCaptureTx(acct.id, p.paymentId);
    const again = await settleCaptureTx(acct.id, p.paymentId);
    expect(again.outcome).toBe('ALREADY_SETTLED');
    expect(await Payment.count({ where: { societyId: w.society.id! } })).toBe(1);
    expect(await PaymentAllocation.count({ where: { societyId: w.society.id! } })).toBe(1);
  });

  it('concurrent captures of the same payment settle exactly once', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const { go, acct } = await orderFor(w, Number(inv.id), 100_000);
    const p = gw.payOrder(go.orderId);
    const results = await Promise.all([1, 2, 3].map(() => settleCaptureTx(acct.id, p.paymentId)));
    expect(results.filter(r => r.outcome === 'SETTLED')).toHaveLength(1);
    expect(await Payment.count({ where: { societyId: w.society.id! } })).toBe(1);
    expect(Number((await Invoice.findByPk(inv.id))!.paidPaise)).toBe(100_000);
  });

  it('amount mismatch is kept, all to advance, flagged for review (BR-12-13)', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const { go, acct } = await orderFor(w, Number(inv.id), 100_000);
    const p = gw.payOrder(go.orderId, { amountPaise: 90_000 });
    const out = await settleCaptureTx(acct.id, p.paymentId);
    expect(out).toMatchObject({ outcome: 'SETTLED', needsReview: true });
    const pay = (await Payment.findOne({ where: { gatewayPaymentId: p.paymentId } }))!;
    expect(pay).toMatchObject({ needsReview: true, reviewReason: 'AMOUNT_MISMATCH' });
    expect(Number(pay.toAdvancePaise)).toBe(90_000);
    expect(Number((await Invoice.findByPk(inv.id))!.paidPaise)).toBe(0);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(90_000);
  });

  it('a cancelled order is kept the same way and stays cancelled', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const { order, go, acct } = await orderFor(w, Number(inv.id), 100_000, { status: 'CANCELLED' });
    const p = gw.payOrder(go.orderId);
    await settleCaptureTx(acct.id, p.paymentId);
    const pay = (await Payment.findOne({ where: { gatewayPaymentId: p.paymentId } }))!;
    expect(pay.reviewReason).toBe('ORDER_CANCELLED');
    expect((await PaymentOrder.findByPk(order.id))!.status).toBe('CANCELLED');
  });

  it('a second capture on a PAID order is a duplicate suspect, all to advance (BR-12-14)', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const { go, acct } = await orderFor(w, Number(inv.id), 100_000);
    const p1 = gw.payOrder(go.orderId);
    const p2 = gw.payOrder(go.orderId);
    await settleCaptureTx(acct.id, p1.paymentId);
    const out = await settleCaptureTx(acct.id, p2.paymentId);
    expect(out).toMatchObject({ outcome: 'SETTLED', duplicate: true });
    const first = (await Payment.findOne({ where: { gatewayPaymentId: p1.paymentId } }))!;
    const dup = (await Payment.findOne({ where: { gatewayPaymentId: p2.paymentId } }))!;
    expect(dup).toMatchObject({ isDuplicateSuspect: true });
    expect(Number(dup.duplicateOfPaymentId)).toBe(Number(first.id));
    expect(Number(dup.toAdvancePaise)).toBe(100_000);
    expect(Number((await Invoice.findByPk(inv.id))!.paidPaise)).toBe(100_000);
  });

  it('an unknown order creates nothing; a failed attempt marks the order ATTEMPTED with a FAILED row', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const { order, go, acct } = await orderFor(w, Number(inv.id), 100_000);
    const unknown = await sequelize.transaction(t =>
      settleCapture(
        acct.id,
        { id: 'pay_x', status: 'captured', amountPaise: 5, method: 'upi', orderId: 'order_nope' },
        t,
      ),
    );
    expect(unknown.outcome).toBe('UNKNOWN_ORDER');
    const failed = gw.payOrder(go.orderId, { status: 'failed' });
    const out = await settleCaptureTx(acct.id, failed.paymentId);
    expect(out.outcome).toBe('ATTEMPT_RECORDED');
    expect((await PaymentOrder.findByPk(order.id))!.status).toBe('ATTEMPTED');
    const row = (await Payment.findOne({ where: { gatewayPaymentId: failed.paymentId } }))!;
    expect(row.status).toBe('FAILED');
    expect(Number(row.toInvoicesPaise)).toBe(0);
    // a later successful payment on the same order still settles it
    const ok = gw.payOrder(go.orderId);
    expect((await settleCaptureTx(acct.id, ok.paymentId)).outcome).toBe('SETTLED');
    expect((await PaymentOrder.findByPk(order.id))!.status).toBe('PAID');
  });

  it('runs the order hook of a MODULE order inside the capture', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 30_000, '2026-11-20');
    const { order, go, acct } = await orderFor(w, Number(inv.id), 30_000);
    await order.update({
      sourceType: 'MODULE',
      sourceModule: '18',
      refType: 'booking',
      refId: 7,
      dedupeKey: 'booking:7',
    });
    const seen: number[] = [];
    registerOrderHook('booking', { onPaid: async (_c, o) => void seen.push(Number(o.refId)) });
    await settleCaptureTx(acct.id, gw.payOrder(go.orderId).paymentId);
    expect(seen).toEqual([7]);
  });

  it('a throwing hook rolls the capture back', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 30_000, '2026-11-20');
    const { order, go, acct } = await orderFor(w, Number(inv.id), 30_000);
    await order.update({
      sourceType: 'MODULE',
      sourceModule: '18',
      refType: 'booking',
      refId: 8,
      dedupeKey: 'booking:8',
    });
    registerOrderHook('booking', {
      onPaid: async () => {
        throw new Error('hook failed');
      },
    });
    await expect(settleCaptureTx(acct.id, gw.payOrder(go.orderId).paymentId)).rejects.toThrow('hook failed');
    expect(await Payment.count({ where: { societyId: w.society.id! } })).toBe(0);
    expect((await PaymentOrder.findByPk(order.id))!.status).toBe('CREATED');
  });
});

describe('collection requests in the plan (SELECTED)', () => {
  it('pays an optional request: paidPaise, status, fund line, no unit ledger entry, totals refresh', async () => {
    const w = await paymentsWorld();
    const col = await Collection.create({
      societyId: w.society.id!,
      title: 'Ganesh Utsav 2026',
      kind: 'FESTIVAL',
      purpose: 'Festival celebration fund',
      amountMode: 'MIN_PER_UNIT',
      amountPerUnitPaise: 110_000,
      minAmountPaise: 50_100,
      isMandatory: false,
      audienceType: 'ALL',
      targetPaise: 5_000_000,
      dueDate: '2026-12-01',
      fundId: 77,
      status: 'PUBLISHED',
    } as never);
    const req = await CollectionRequest.create({
      societyId: w.society.id!,
      collectionId: col.id,
      unitId: w.units[0]!.id,
      amountPaise: 110_000,
      minAmountPaise: 50_100,
    } as never);
    paymentsPortCalls.length = 0;
    const { payment } = await sequelize.transaction(t =>
      settleInput(
        sysCtx(w),
        offline(w, 0, 60_000, {
          mode: 'SELECTED',
          selected: [{ targetType: 'COLLECTION_REQUEST', id: Number(req.id), amountPaise: 60_000 }],
        }),
        t,
      ),
    );
    const r = (await CollectionRequest.findByPk(req.id))!;
    expect([Number(r.paidPaise), r.status]).toEqual([60_000, 'PART_PAID']);
    expect([
      Number(payment.toCollectionsPaise),
      Number(payment.toInvoicesPaise),
      Number(payment.toAdvancePaise),
    ]).toEqual([60_000, 0, 0]);
    expect(await UnitLedgerEntry.count({ where: { refId: payment.id } })).toBe(0);
    const j = paymentsPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any)[0];
    expect(j.lines.find((l: any) => l.accountCode === 'COLLECTION_FUND')).toMatchObject({
      creditPaise: 60_000,
      fundId: 77,
    });
    await refreshCollectionTotals(Number(col.id));
    const c2 = (await Collection.findByPk(col.id))!;
    expect([Number(c2.collectedPaise), Number(c2.contributorCount), Number(c2.paidCount)]).toEqual([
      60_000, 1, 0,
    ]);
    await drainQueues();
    expect(await UnitAdvance.count()).toBe(0);
  });
});

describe('ports', () => {
  it('records journal and notification calls, refuses an unbalanced journal, serves a fake gateway account', async () => {
    const w = await paymentsWorld();
    const { journal, gateways } = paymentsPorts();
    await expect(
      sequelize.transaction(t =>
        journal.post(
          sysCtx(w) as never,
          {
            date: '2026-11-04',
            voucherType: 'RECEIPT',
            refType: 'payment',
            refId: 1,
            narration: 'x',
            lines: [{ accountCode: 'BANK', debitPaise: 5, creditPaise: 0 }],
          },
          t,
        ),
      ),
    ).rejects.toThrow(/balance/);
    const acct = await gateways.accountFor(w.society.id!);
    expect(acct).toMatchObject({ provider: 'FAKE', webhookSecret: FAKE_WEBHOOK_SECRET, isActive: true });
    expect(gateways.clientFor(acct!)).toBe(gw);
    setPaymentsPorts({ gateways: { accountFor: async () => null } });
    expect(await paymentsPorts().gateways.accountFor(1)).toBeNull();
  });
});
