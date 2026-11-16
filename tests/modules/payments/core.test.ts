import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Invoice,
  Payment,
  PaymentAllocation,
  UnitAdvance,
  UnitLedgerEntry,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { settleInput, effectivatePending } from '../../../src/modules/payments/payments.settle';
import {
  advanceBalance,
  applyAdvancesForUnit,
  creditOpeningAdvance,
  postAdvance,
  queueAdvanceApply,
} from '../../../src/modules/payments/payments.advances';
import { onInvoiceCancelled, reversePaymentCore } from '../../../src/modules/payments/payments.reverse.core';
import { paymentsPortCalls, setPaymentsPorts } from '../../../src/modules/payments/payments.ports';
import { listAllocationsForInvoice } from '../../../src/modules/payments/payments.billing-hooks';
import { billingPorts } from '../../../src/modules/billing/billing.ports';
import { mkInvoice, offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { events } from '../../helpers/auth';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { setSetting } from '../../helpers/billing-runs';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
});

const settle = async (w: Awaited<ReturnType<typeof paymentsWorld>>, input: ReturnType<typeof offline>) =>
  moneyTx(t => settleInput(sysCtx(w), input, t));

const journalCalls = () => paymentsPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any);

/** The worked example 6.10: A-1203 with two open invoices, NEFT 900,000 oldest first. */
async function example610() {
  const w = await paymentsWorld({ flats: 2 });
  const inv87 = await mkInvoice(w, 0, 120_000, '2026-11-10');
  const inv123 = await mkInvoice(w, 0, 680_900, '2026-12-10');
  const res = await settle(w, offline(w, 0, 900_000));
  return { w, inv87, inv123, ...res };
}

describe('settle core: worked example 6.10', () => {
  it('allocates oldest first and sends the rest to advance', async () => {
    const { w, inv87, inv123, payment } = await example610();
    expect((await Invoice.findByPk(inv87.id))!.status).toBe('PAID');
    expect((await Invoice.findByPk(inv123.id))!.status).toBe('PAID');
    const allocs = await PaymentAllocation.findAll({
      where: { paymentId: payment.id },
      order: [['id', 'ASC']],
    });
    expect(allocs.map(a => [Number(a.invoiceId), Number(a.amountPaise)])).toEqual([
      [Number(inv87.id), 120_000],
      [Number(inv123.id), 680_900],
    ]);
    const p = (await Payment.findByPk(payment.id))!;
    expect([Number(p.toInvoicesPaise), Number(p.toCollectionsPaise), Number(p.toAdvancePaise)]).toEqual([
      800_900, 0, 99_100,
    ]);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(99_100);
    const adv = await UnitAdvance.findAll({ where: { unitId: w.units[0]!.id } });
    expect(adv).toHaveLength(1);
    expect(adv[0]).toMatchObject({ entryType: 'PAYMENT_EXCESS', dedupeKey: `EXCESS:payment:${payment.id}` });
  });

  it('issues the gapless receipt, the ledger credit, the balanced journal and the audit row', async () => {
    const { w, payment } = await example610();
    const p = (await Payment.findByPk(payment.id))!;
    expect(p.receiptNo).toBe('RCT/2026-27/000001');
    expect(p).toMatchObject({ receiptStatus: 'ISSUED', receiptRevision: 1, receiptPdfStatus: 'PENDING' });
    const led = await UnitLedgerEntry.findOne({
      where: { refType: 'payment', refId: p.id, entryType: 'PAYMENT' },
    });
    expect(Number(led!.creditPaise)).toBe(900_000);
    const j = journalCalls().find((c: any) => c.refType === 'payment');
    expect(j.voucherType).toBe('RECEIPT');
    expect(j.lines.find((l: any) => l.accountCode === 'BANK').debitPaise).toBe(900_000);
    expect(j.lines.find((l: any) => l.accountCode === 'MEMBER_RECEIVABLE').creditPaise).toBe(800_900);
    expect(j.lines.find((l: any) => l.accountCode === 'MEMBER_ADVANCES').creditPaise).toBe(99_100);
    const a = await AuditLog.findOne({
      where: { action: 'payments.payment.recorded', entityId: String(p.id) },
    });
    expect(a).not.toBeNull();
    await drainQueues();
    expect(events.find(e => e.event === 'payment.received')!.payload).toMatchObject({
      amountPaise: 900_000,
      receiptNo: p.receiptNo,
    });
    expect(w.units[0]!.id).toBeGreaterThan(0);
  });

  it('applies the advance to the next invoice (99,100 of 680,900 leaves 581,800)', async () => {
    const { w } = await example610();
    const inv150 = await mkInvoice(w, 0, 680_900, '2027-01-10');
    paymentsPortCalls.length = 0;
    const r = await sequelize.transaction(t =>
      applyAdvancesForUnit(sysCtx(w), w.society.id!, w.units[0]!.id, t),
    );
    expect(r.appliedPaise).toBe(99_100);
    const i = (await Invoice.findByPk(inv150.id))!;
    expect(Number(i.outstandingPaise)).toBe(581_800);
    expect(i.status).toBe('PARTIALLY_PAID');
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(0);
    const j = journalCalls()[0];
    expect(j.lines.map((l: any) => [l.accountCode, l.debitPaise, l.creditPaise])).toEqual([
      ['MEMBER_ADVANCES', 99_100, 0],
      ['MEMBER_RECEIVABLE', 0, 99_100],
    ]);
    // no unit ledger entry for an application (the payment already credited it)
    expect(await UnitLedgerEntry.count({ where: { unitId: w.units[0]!.id, entryType: 'PAYMENT' } })).toBe(1);
    // a second run is a no-op
    const again = await sequelize.transaction(t =>
      applyAdvancesForUnit(sysCtx(w), w.society.id!, w.units[0]!.id, t),
    );
    expect(again.appliedPaise).toBe(0);
  });

  it('the apply-advances job runs from queueAdvanceApply (module 11 hook is wired)', async () => {
    const { w } = await example610();
    await mkInvoice(w, 0, 50_000, '2027-01-10');
    await billingPorts().payments.queueAdvanceApply(w.society.id!, [w.units[0]!.id]);
    await drainQueues();
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(49_100);
    expect(await billingPorts().payments.advanceBalance(w.society.id!, w.units[0]!.id)).toBe(49_100);
    await queueAdvanceApply(w.society.id!, []);
  });
});

describe('settle core: idempotency and one transaction', () => {
  it('the same reference or gateway payment id settles once', async () => {
    const w = await paymentsWorld();
    await mkInvoice(w, 0, 100_000, '2026-11-20');
    const input = offline(w, 0, 60_000);
    const a = await settle(w, input);
    const b = await settle(w, input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(Number(b.payment.id)).toBe(Number(a.payment.id));
    expect(await Payment.count({ where: { societyId: w.society.id! } })).toBe(1);
    expect(await PaymentAllocation.count({ where: { societyId: w.society.id! } })).toBe(1);
    expect(await UnitLedgerEntry.count({ where: { entryType: 'PAYMENT' } })).toBe(1);
  });

  it('a failure after the allocation rolls everything back, including the receipt number', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    setPaymentsPorts({
      journal: {
        post: async () => {
          throw new Error('journal down');
        },
      },
    });
    await expect(settle(w, offline(w, 0, 100_000))).rejects.toThrow('journal down');
    expect(await Payment.count({ where: { societyId: w.society.id! } })).toBe(0);
    expect(await PaymentAllocation.count({ where: { societyId: w.society.id! } })).toBe(0);
    expect(await UnitAdvance.count({ where: { societyId: w.society.id! } })).toBe(0);
    expect(await UnitLedgerEntry.count({ where: { entryType: 'PAYMENT' } })).toBe(0);
    const i = (await Invoice.findByPk(inv.id))!;
    expect(Number(i.paidPaise)).toBe(0);
    // the number was given back: the next receipt is 000001 again
    setPaymentsPorts();
    const ok = await settle(w, offline(w, 0, 100_000));
    expect(ok.payment.receiptNo).toBe('RCT/2026-27/000001');
  });

  it('receipt numbers are gapless and unique under concurrency', async () => {
    const w = await paymentsWorld({ flats: 3 });
    await Promise.all(
      [0, 1, 2, 0, 1, 2].map((u, i) =>
        settle(w, offline(w, u, 10_000 + i, { mode: 'OLDEST_FIRST', advanceOnly: true })),
      ),
    );
    const nos = (await Payment.findAll({ where: { societyId: w.society.id! } }))
      .map(p => p.receiptNo!)
      .sort();
    expect(nos).toEqual([1, 2, 3, 4, 5, 6].map(i => `RCT/2026-27/${String(i).padStart(6, '0')}`));
  });
});

describe('advances', () => {
  it('never goes negative, is idempotent by dedupe key, and the opening credit posts no journal or ledger entry', async () => {
    const w = await paymentsWorld();
    const sid = w.society.id!;
    const uid = w.units[0]!.id;
    const res = await sequelize.transaction(async t => {
      const a = await postAdvance(
        sysCtx(w),
        sid,
        uid,
        { entryType: 'PAYMENT_EXCESS', amountPaise: 5_000, dedupeKey: 'K1', narration: 'x' },
        t,
      );
      const b = await postAdvance(
        sysCtx(w),
        sid,
        uid,
        { entryType: 'PAYMENT_EXCESS', amountPaise: 5_000, dedupeKey: 'K1', narration: 'x' },
        t,
      );
      return [a, b];
    });
    expect(Number(res[0]!.id)).toBe(Number(res[1]!.id));
    expect(await advanceBalance(sid, uid)).toBe(5_000);
    await expect(
      sequelize.transaction(t =>
        postAdvance(
          sysCtx(w),
          sid,
          uid,
          { entryType: 'APPLIED', amountPaise: -5_001, dedupeKey: 'K2', narration: 'x' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ADVANCE_INSUFFICIENT', status: 422 });
    await expect(
      sequelize.transaction(t =>
        postAdvance(
          sysCtx(w),
          sid,
          uid,
          { entryType: 'APPLIED', amountPaise: 100, dedupeKey: 'K3', narration: 'x' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_FAILED' });
    paymentsPortCalls.length = 0;
    const ledgerBefore = await UnitLedgerEntry.count();
    await sequelize.transaction(t => creditOpeningAdvance(sysCtx(w), w.units[1]!.id, 7_000, t));
    await sequelize.transaction(t => creditOpeningAdvance(sysCtx(w), w.units[1]!.id, 7_000, t));
    expect(await advanceBalance(sid, w.units[1]!.id)).toBe(7_000);
    expect(journalCalls()).toHaveLength(0);
    expect(await UnitLedgerEntry.count()).toBe(ledgerBefore);
    expect(
      (await UnitAdvance.findOne({ where: { dedupeKey: `OPENING:unit:${w.units[1]!.id}` } }))!.entryType,
    ).toBe('OPENING');
  });

  it('advance rows cannot be updated or deleted', async () => {
    const w = await paymentsWorld();
    await sequelize.transaction(t =>
      postAdvance(
        sysCtx(w),
        w.society.id!,
        w.units[0]!.id,
        { entryType: 'OPENING', amountPaise: 100, dedupeKey: 'O', narration: 'x' },
        t,
      ),
    );
    const row = (await UnitAdvance.findOne({ where: { dedupeKey: 'O' } }))!;
    await expect(row.update({ amountPaise: 5 })).rejects.toThrow(/immutable/);
    await expect(row.destroy()).rejects.toThrow(/never deleted/);
  });
});

describe('reverse core (reverse, bounce, return)', () => {
  it('reverses the example: invoices reopen, advance removed, receipt cancelled, ledger and journal mirrored', async () => {
    const { w, inv87, inv123, payment } = await example610();
    paymentsPortCalls.length = 0;
    await sequelize.transaction(t =>
      reversePaymentCore(
        sysCtx(w),
        Number(payment.id),
        { newStatus: 'REVERSED', reversalReasonCode: 'WRONG_ENTRY', reason: 'Entered twice by mistake' },
        t,
      ),
    );
    const p = (await Payment.findByPk(payment.id))!;
    expect(p).toMatchObject({
      status: 'REVERSED',
      receiptStatus: 'CANCELLED',
      receiptNo: 'RCT/2026-27/000001',
      receiptRevision: 2,
      reversalReasonCode: 'WRONG_ENTRY',
    });
    expect([Number(p.toInvoicesPaise), Number(p.toAdvancePaise)]).toEqual([0, 0]);
    expect(Number((await Invoice.findByPk(inv87.id))!.outstandingPaise)).toBe(120_000);
    expect(Number((await Invoice.findByPk(inv123.id))!.outstandingPaise)).toBe(680_900);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(0);
    const rev = await UnitLedgerEntry.findOne({ where: { refId: p.id, entryType: 'PAYMENT_REVERSAL' } });
    expect(Number(rev!.debitPaise)).toBe(900_000);
    const j = journalCalls()[0];
    expect(j.voucherType).toBe('JOURNAL');
    expect(j.lines.find((l: any) => l.accountCode === 'BANK').creditPaise).toBe(900_000);
    expect(j.lines.find((l: any) => l.accountCode === 'MEMBER_RECEIVABLE').debitPaise).toBe(800_900);
    // negative rows point at the originals
    const negs = await PaymentAllocation.findAll({ where: { paymentId: p.id, reasonCode: 'REVERSED' } });
    expect(negs).toHaveLength(2);
    expect(negs.every(a => Number(a.amountPaise) < 0 && a.reversalOfId !== null)).toBe(true);
    await expect(
      sequelize.transaction(t =>
        reversePaymentCore(sysCtx(w), Number(payment.id), { newStatus: 'REVERSED' }, t),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('a bounce frees the reference key and unwinds an advance that was already spent', async () => {
    const w = await paymentsWorld();
    const first = await mkInvoice(w, 0, 100_000, '2026-11-20');
    const input = offline(w, 0, 150_000, {
      method: 'CHEQUE',
      status: 'RECEIVED',
      chequeBankName: 'HDFC Bank',
      chequeDate: '2026-11-04',
      referenceNo: '123456',
      referenceKey: 'CHQ:hdfcbank:123456',
    });
    const { payment } = await settle(w, input);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(50_000);
    const next = await mkInvoice(w, 0, 80_000, '2026-12-20');
    await sequelize.transaction(t => applyAdvancesForUnit(sysCtx(w), w.society.id!, w.units[0]!.id, t));
    expect(Number((await Invoice.findByPk(next.id))!.paidPaise)).toBe(50_000);
    await sequelize.transaction(t =>
      reversePaymentCore(
        sysCtx(w),
        Number(payment.id),
        { newStatus: 'BOUNCED', reason: 'Cheque returned' },
        t,
      ),
    );
    const p = (await Payment.findByPk(payment.id))!;
    expect(p.status).toBe('BOUNCED');
    expect(p.referenceKey).toBeNull();
    expect(Number((await Invoice.findByPk(first.id))!.outstandingPaise)).toBe(100_000);
    // the advance application was reversed first, so the next invoice is open again and the balance is zero
    expect(Number((await Invoice.findByPk(next.id))!.paidPaise)).toBe(0);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(0);
    expect(
      (await UnitAdvance.findAll({ where: { unitId: w.units[0]!.id } })).every(
        a => Number(a.balanceAfterPaise) >= 0,
      ),
    ).toBe(true);
  });

  it('onInvoiceCancelled releases the allocation to advance, moves the payment parts and is idempotent (BR-12-53)', async () => {
    const w = await paymentsWorld();
    await setSetting(w.society.id!, 'payments.autoApplyAdvance', false); // the invoice here is not really cancelled
    const inv = await mkInvoice(w, 0, 120_000, '2026-11-20');
    const { payment } = await settle(w, offline(w, 0, 120_000));
    await sequelize.transaction(t => onInvoiceCancelled(sysCtx(w), Number(inv.id), t));
    await sequelize.transaction(t => onInvoiceCancelled(sysCtx(w), Number(inv.id), t));
    expect(Number((await Invoice.findByPk(inv.id))!.paidPaise)).toBe(0);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(120_000);
    const p = (await Payment.findByPk(payment.id))!;
    expect([Number(p.toInvoicesPaise), Number(p.toAdvancePaise), Number(p.receiptRevision)]).toEqual([
      0, 120_000, 2,
    ]);
    expect(p.status).toBe('CONFIRMED');
    const events2 = await listAllocationsForInvoice(w.society.id!, Number(inv.id));
    expect(events2.map(e => e.amountPaise)).toEqual([120_000, -120_000]);
    expect(await UnitAdvance.count({ where: { entryType: 'ALLOCATION_RELEASED' } })).toBe(1);
  });
});

describe('pending approval path', () => {
  it('effectivatePending turns a PENDING_APPROVAL payment effective', async () => {
    const w = await paymentsWorld();
    const inv = await mkInvoice(w, 0, 40_000, '2026-11-20');
    const p = await Payment.create({
      societyId: w.society.id!,
      unitId: w.units[0]!.id,
      source: 'OFFLINE',
      method: 'CASH',
      status: 'PENDING_APPROVAL',
      payerName: 'Cash payer',
      amountPaise: 40_000,
      grossAmountPaise: 40_000,
      paymentDate: '2026-11-04',
      createdBy: null,
    } as never);
    const r = await sequelize.transaction(t =>
      effectivatePending(sysCtx(w), Number(p.id), { mode: 'OLDEST_FIRST', status: 'CONFIRMED' }, t),
    );
    expect(r.payment.status).toBe('CONFIRMED');
    expect(r.payment.receiptNo).toBe('RCT/2026-27/000001');
    expect(Number((await Invoice.findByPk(inv.id))!.outstandingPaise)).toBe(0);
    await expect(
      sequelize.transaction(t =>
        effectivatePending(sysCtx(w), Number(p.id), { mode: 'OLDEST_FIRST', status: 'CONFIRMED' }, t),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const j = journalCalls()[0];
    expect(j.lines[0].accountCode).toBe('CASH_IN_HAND');
  });
});
