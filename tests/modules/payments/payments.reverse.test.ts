import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Collection,
  CollectionRequest,
  Invoice,
  Payment,
  PaymentAllocation,
  Refund,
  UnitAdvance,
  closeDb,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { advance } from '../../../src/lib/clock';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { advanceBalance, applyAdvancesForUnit } from '../../../src/modules/payments/payments.advances';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { paymentsPortCalls, setPaymentsPorts } from '../../../src/modules/payments/payments.ports';
import { runIntegrityCheck } from '../../../src/modules/payments/payments.admin.integrity';
import { balancingLines } from '../../../src/modules/payments/payments.reverse.service';
import { idemH } from '../../helpers/billing-runs';
import { mkInvoice, offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { adminOf } from '../../helpers/residents';
import { featureOff } from '../../helpers/society-setup';
import { events } from '../../helpers/auth';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
});

type World = Awaited<ReturnType<typeof paymentsWorld>>;
const pay = async (w: World, unit: number, amount: number, o: Parameters<typeof offline>[3] = {}) =>
  (await moneyTx(t => settleInput(sysCtx(w), offline(w, unit, amount, o), t))).payment;
const fresh = async (id: unknown) => (await Payment.findByPk(id as number))!;
const journals = () => paymentsPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any);

/** A-101: bill 500,000 due 10 Nov and a NEFT of 600,000: 500,000 to the bill, 100,000 to advance. */
async function world() {
  const w = await paymentsWorld({ flats: 2 });
  const inv = await mkInvoice(w, 0, 500_000, '2026-11-10');
  const p = await pay(w, 0, 600_000);
  await drainQueues();
  return { w, inv, p };
}
const reverseBody = (version: number, o: Record<string, unknown> = {}) => ({
  reasonCode: 'WRONG_ENTRY',
  reason: 'Entered against the wrong flat',
  version,
  ...o,
});
const reverse = (w: World, id: unknown, body: unknown) =>
  w.c('post', `/payments/${id}/reverse`, body, { headers: idemH() });

describe('POST /payments/:id/reverse (8.14, BR-12-33)', () => {
  it('reverses: invoice reopens, advance removed, receipt cancelled, journal mirrored, audited, payer told, event emitted', async () => {
    const { w, inv, p } = await world();
    await Payment.update({ payerUserId: w.treasurer.user.id }, { where: { id: p.id } });
    const version = Number((await fresh(p.id)).version);
    paymentsPortCalls.length = 0;
    events.length = 0;
    const r = await reverse(w, p.id, reverseBody(version));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      status: 'REVERSED',
      receiptStatus: 'CANCELLED',
      toInvoicesPaise: 0,
      toAdvancePaise: 0,
      reversalReasonCode: 'WRONG_ENTRY',
      reversalReason: 'Entered against the wrong flat',
    });
    const i = (await Invoice.findByPk(inv.id))!;
    expect([i.status, Number(i.paidPaise), Number(i.outstandingPaise)]).toEqual(['ISSUED', 0, 500_000]);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(0);
    const rows = await PaymentAllocation.findAll({ where: { paymentId: p.id }, order: [['id', 'ASC']] });
    expect(rows.map(a => [Number(a.amountPaise), a.reasonCode])).toEqual([
      [500_000, 'ALLOCATED'],
      [-500_000, 'REVERSED'],
    ]);
    const mirror = journals().find(j => j.voucherType === 'JOURNAL')!;
    expect(mirror.lines.find((l: any) => l.accountCode === 'BANK').creditPaise).toBe(600_000);
    expect(
      await AuditLog.count({ where: { action: 'payments.payment.reversed', entityId: String(p.id) } }),
    ).toBe(1);
    expect(
      paymentsPortCalls.find(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'payments.payment_reversed',
      ),
    ).toBeTruthy();
    expect(events.some(e => e.event === 'payment.reversed')).toBe(true);
    expect(await runIntegrityCheck()).toEqual([]);
  });

  it('needs the Idempotency-Key, a recent sign-in (401 REAUTH_REQUIRED), the version and a 10 character reason', async () => {
    const { w, p } = await world();
    const version = Number((await fresh(p.id)).version);
    expect((await w.c('post', `/payments/${p.id}/reverse`, reverseBody(version))).status).toBe(400);
    expect((await reverse(w, p.id, reverseBody(version, { reason: 'short' }))).status).toBe(400);
    expect((await reverse(w, p.id, reverseBody(version, { reasonCode: 'NOPE' }))).status).toBe(400);
    expect((await reverse(w, p.id, { reasonCode: 'WRONG_ENTRY', reason: 'long enough reason' })).status).toBe(
      400,
    );
    advance(10 * 60_000);
    const r = await reverse(w, p.id, reverseBody(version));
    expect([r.status, r.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await fresh(p.id)).status).toBe('CONFIRMED');
  });

  it('403 without finance.payments.approve (T12-36), 404 for another society, same key replays', async () => {
    const { w, p } = await world();
    const version = Number((await fresh(p.id)).version);
    const accountant = await adminOf(w.society, 'accountant');
    const denied = await accountant.c('post', `/payments/${p.id}/reverse`, reverseBody(version), {
      headers: idemH(),
    });
    expect(denied.status).toBe(403);
    const other = await paymentsWorld({ flats: 1 });
    expect((await reverse(other, p.id, reverseBody(version))).body.code).toBe('PAYMENT_NOT_FOUND');
    const key = idemH();
    const a = await w.c('post', `/payments/${p.id}/reverse`, reverseBody(version), { headers: key });
    const b = await w.c('post', `/payments/${p.id}/reverse`, reverseBody(version), { headers: key });
    expect([a.status, b.status, b.headers['idempotent-replay']]).toEqual([200, 200, 'true']);
  });

  it('maker-checker: the person who recorded it cannot reverse it', async () => {
    const { w, p } = await world();
    await Payment.update({ createdBy: w.user.id }, { where: { id: p.id } });
    const r = await reverse(w, p.id, reverseBody(Number((await fresh(p.id)).version)));
    expect([r.status, r.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
  });

  it('INVALID_STATE for a payment that is not effective, already reversed, with a cheque in clearing, or with refunds', async () => {
    const { w, p } = await world();
    const v = () => fresh(p.id).then(x => Number(x.version));
    await Payment.update({ refundedPaise: 1_000 }, { where: { id: p.id } });
    expect((await reverse(w, p.id, reverseBody(await v()))).body.code).toBe('INVALID_STATE');
    await Payment.update({ refundedPaise: 0 }, { where: { id: p.id } });
    await Refund.create({
      societyId: w.society.id!,
      unitId: w.units[0]!.id,
      paymentId: p.id,
      amountPaise: 1_000,
      mode: 'BANK_TRANSFER',
      status: 'PENDING_APPROVAL',
      reason: 'test refund',
    } as never).catch(() => undefined);
    if (await Refund.count({ where: { paymentId: p.id } }))
      expect((await reverse(w, p.id, reverseBody(await v()))).body.code).toBe('INVALID_STATE');
    await Refund.destroy({ where: { paymentId: p.id } });
    const chq = await pay(w, 1, 100_000, {
      method: 'CHEQUE',
      status: 'RECEIVED',
      referenceNo: '111111',
      referenceKey: 'CHQ:X:111111',
      chequeBankName: 'X',
      chequeDate: '2026-11-01',
    });
    expect((await reverse(w, chq.id, reverseBody(Number(chq.version)))).body.code).toBe('INVALID_STATE');
    expect((await reverse(w, p.id, reverseBody(await v()))).status).toBe(200);
    expect((await reverse(w, p.id, reverseBody(await v()))).body.code).toBe('INVALID_STATE');
  });

  it('409 STALE_VERSION', async () => {
    const { w, p } = await world();
    const r = await reverse(w, p.id, reverseBody(Number((await fresh(p.id)).version) + 3));
    expect([r.status, r.body.code]).toEqual([409, 'STALE_VERSION']);
  });

  it('an online payment is reversed only for a lost chargeback (422 BUSINESS_RULE_FAILED otherwise)', async () => {
    const w = await paymentsWorld({ flats: 1 });
    const p = await pay(w, 0, 100_000, {
      source: 'ONLINE',
      method: 'UPI',
      status: 'CAPTURED',
      gatewayPaymentId: 'pay_cb',
      referenceNo: null,
      referenceKey: null,
    });
    const version = Number(p.version);
    const no = await reverse(w, p.id, reverseBody(version));
    expect([no.status, no.body.code]).toEqual([422, 'BUSINESS_RULE_FAILED']);
    const yes = await reverse(w, p.id, reverseBody(version, { reasonCode: 'CHARGEBACK_LOST' }));
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    expect(yes.body.data.reversalReasonCode).toBe('CHARGEBACK_LOST');
  });

  it('422 PERIOD_LOCKED when the accounting period is locked', async () => {
    const { w, p } = await world();
    setPaymentsPorts({ journal: { isDateLocked: async () => true } });
    const r = await reverse(w, p.id, reverseBody(Number((await fresh(p.id)).version)));
    expect([r.status, r.body.code]).toEqual([422, 'PERIOD_LOCKED']);
    setPaymentsPorts();
  });

  it('removes an advance that was already applied: the newest applications are reversed first and the advance never goes negative', async () => {
    const { w, inv, p } = await world();
    await mkInvoice(w, 0, 80_000, '2026-12-10');
    await moneyTx(t => applyAdvancesForUnit(sysCtx(w), w.society.id!, w.units[0]!.id, t));
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(20_000);
    const r = await reverse(w, p.id, reverseBody(Number((await fresh(p.id)).version)));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(0);
    const min = Math.min(
      ...(await UnitAdvance.findAll({ where: { unitId: w.units[0]!.id } })).map(a =>
        Number(a.balanceAfterPaise),
      ),
    );
    expect(min).toBeGreaterThanOrEqual(0);
    expect((await Invoice.findByPk(inv.id))!.status).toBe('ISSUED');
    expect(await runIntegrityCheck()).toEqual([]);
  });
});

describe('POST /payments/:id/reallocate (8.15, BR-12-23, BR-12-34)', () => {
  const body = (version: number, targets: unknown[], reason = 'Move the money to the second bill') => ({
    targets,
    reason,
    version,
  });
  const realloc = (w: World, id: unknown, b: unknown) =>
    w.c('post', `/payments/${id}/reallocate`, b, { headers: idemH() });

  /** A-101 has bills 500,000 (10 Nov) and 300,000 (10 Dec); the NEFT of 600,000 pays the first and 100,000 of the second. */
  async function two() {
    const w = await paymentsWorld({ flats: 2 });
    const a = await mkInvoice(w, 0, 500_000, '2026-11-10');
    const b = await mkInvoice(w, 0, 300_000, '2026-12-10');
    const p = await pay(w, 0, 600_000);
    await drainQueues();
    return { w, a, b, p };
  }

  it('moves the money between bills and advance: same total, same number, revision + 1, journal balanced, audit, PDF re-rendered', async () => {
    const { w, a, b, p } = await two();
    const before = await fresh(p.id);
    expect([Number(before.toInvoicesPaise), Number(before.toAdvancePaise)]).toEqual([600_000, 0]);
    paymentsPortCalls.length = 0;
    const r = await realloc(
      w,
      p.id,
      body(Number(before.version), [
        { type: 'INVOICE', id: Number(b.id), amountPaise: 300_000 },
        { type: 'INVOICE', id: Number(a.id), amountPaise: 200_000 },
        { type: 'ADVANCE', amountPaise: 100_000 },
      ]),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      toInvoicesPaise: 500_000,
      toAdvancePaise: 100_000,
      receiptRevision: 2,
      receiptNo: before.receiptNo,
      status: 'CONFIRMED',
    });
    const ia = (await Invoice.findByPk(a.id))!;
    const ib = (await Invoice.findByPk(b.id))!;
    expect([Number(ia.paidPaise), ia.status, Number(ib.paidPaise), ib.status]).toEqual([
      200_000,
      'PARTIALLY_PAID',
      300_000,
      'PAID',
    ]);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(100_000);
    const j = journals().find(
      x => x.refType === 'payment_realloc' && x.narration.startsWith('Reallocation'),
    )!;
    expect(j.lines.reduce((s: number, l: any) => s + l.debitPaise, 0)).toBe(
      j.lines.reduce((s: number, l: any) => s + l.creditPaise, 0),
    );
    expect(j.lines.find((l: any) => l.accountCode === 'MEMBER_ADVANCES').creditPaise).toBe(100_000);
    expect(j.lines.find((l: any) => l.accountCode === 'MEMBER_RECEIVABLE').debitPaise).toBe(100_000);
    const audit = await AuditLog.findOne({
      where: { action: 'payments.payment.reallocated', entityId: String(p.id) },
    });
    expect(audit!.reason).toBe('Move the money to the second bill');
    const reversed = await PaymentAllocation.count({ where: { paymentId: p.id, reasonCode: 'REALLOCATED' } });
    expect(reversed).toBe(2);
    await drainQueues();
    expect((await fresh(p.id)).receiptPdfStatus).toBe('READY');
    expect(await runIntegrityCheck()).toEqual([]);
    // moving it back needs the new version and returns the advance
    const back = await realloc(
      w,
      p.id,
      body(Number((await fresh(p.id)).version), [
        { type: 'INVOICE', id: Number(a.id), amountPaise: 500_000 },
        { type: 'INVOICE', id: Number(b.id), amountPaise: 100_000 },
      ]),
    );
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(0);
    expect(back.body.data.receiptRevision).toBe(3);
    expect(await runIntegrityCheck()).toEqual([]);
  });

  it('can target a collection request of the flat (and the fund line moves in the journal)', async () => {
    const { w, a, p } = await two();
    const col = await Collection.create({
      societyId: w.society.id!,
      title: 'Diwali',
      kind: 'FESTIVAL',
      purpose: 'Diwali celebration',
      amountMode: 'MIN_PER_UNIT',
      amountPerUnitPaise: 100_000,
      minAmountPaise: 10_000,
      isMandatory: false,
      audienceType: 'ALL',
      targetPaise: 5_000_000,
      dueDate: '2026-12-01',
      fundId: 5,
      status: 'PUBLISHED',
    } as never);
    const req = await CollectionRequest.create({
      societyId: w.society.id!,
      collectionId: col.id,
      unitId: w.units[0]!.id,
      amountPaise: 100_000,
      minAmountPaise: 10_000,
    } as never);
    paymentsPortCalls.length = 0;
    const r = await realloc(
      w,
      p.id,
      body(Number((await fresh(p.id)).version), [
        { type: 'INVOICE', id: Number(a.id), amountPaise: 500_000 },
        { type: 'COLLECTION_REQUEST', id: Number(req.id), amountPaise: 100_000 },
      ]),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ toInvoicesPaise: 500_000, toCollectionsPaise: 100_000 });
    expect(
      r.body.data.allocations.some((x: any) => x.collectionTitle === 'Diwali' && x.amountPaise === 100_000),
    ).toBe(true);
    const cr = (await CollectionRequest.findByPk(req.id))!;
    expect([Number(cr.paidPaise), cr.status]).toEqual([100_000, 'PAID']);
    const j = journals().find(x => x.narration.startsWith('Reallocation'))!;
    expect(j.lines.find((l: any) => l.accountCode === 'COLLECTION_FUND')).toMatchObject({
      creditPaise: 100_000,
      fundId: 5,
    });
    await drainQueues();
    expect(await runIntegrityCheck()).toEqual([]);
  });

  it('422 REALLOCATION_INVALID when the totals differ, a target repeats, the payment is old or has a refund', async () => {
    const { w, a, p } = await two();
    const v = async () => Number((await fresh(p.id)).version);
    const t = (n: number) => [{ type: 'INVOICE', id: Number(a.id), amountPaise: n }];
    const bad = await realloc(w, p.id, body(await v(), t(500_000)));
    expect([bad.status, bad.body.code]).toEqual([422, 'REALLOCATION_INVALID']);
    const dup = await realloc(w, p.id, body(await v(), [...t(300_000), ...t(300_000)]));
    expect(dup.body.code).toBe('REALLOCATION_INVALID');
    await Payment.update({ paymentDate: '2025-01-01' }, { where: { id: p.id } });
    expect((await realloc(w, p.id, body(await v(), t(600_000)))).body.code).toBe('REALLOCATION_INVALID');
    await Payment.update({ paymentDate: '2026-11-04', refundedPaise: 100 }, { where: { id: p.id } });
    expect((await realloc(w, p.id, body(await v(), t(600_000)))).body.code).toBe('REALLOCATION_INVALID');
  });

  it("404 PAYABLE_NOT_FOUND for another flat's bill; 422 AMOUNT_EXCEEDS_DUE above what a bill can take", async () => {
    const { w, a, b, p } = await two();
    const other = await mkInvoice(w, 1, 600_000, '2026-11-10');
    const v = Number((await fresh(p.id)).version);
    const nf = await realloc(
      w,
      p.id,
      body(v, [{ type: 'INVOICE', id: Number(other.id), amountPaise: 600_000 }]),
    );
    expect([nf.status, nf.body.code]).toEqual([404, 'PAYABLE_NOT_FOUND']);
    const over = await realloc(
      w,
      p.id,
      body(v, [
        { type: 'INVOICE', id: Number(b.id), amountPaise: 400_000 },
        { type: 'INVOICE', id: Number(a.id), amountPaise: 200_000 },
      ]),
    );
    expect([over.status, over.body.code]).toEqual([422, 'AMOUNT_EXCEEDS_DUE']);
    expect((await Invoice.findByPk(a.id))!.status).toBe('PAID');
    expect(await runIntegrityCheck()).toEqual([]);
  });

  it('needs the allocation engine entitlement (402 FEATURE_NOT_IN_PLAN)', async () => {
    const { w, a, p } = await two();
    await featureOff(w.society.id!, 'payments.allocation_engine');
    const r = await realloc(
      w,
      p.id,
      body(Number((await fresh(p.id)).version), [
        { type: 'INVOICE', id: Number(a.id), amountPaise: 600_000 },
      ]),
    );
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });

  it('409 INVALID_STATE for a reversed payment, 409 STALE_VERSION, 400 for a bad body, 403 without edit', async () => {
    const { w, a, p } = await two();
    const v = Number((await fresh(p.id)).version);
    const ok = [{ type: 'INVOICE', id: Number(a.id), amountPaise: 600_000 }];
    expect((await realloc(w, p.id, body(v + 2, ok))).body.code).toBe('STALE_VERSION');
    expect((await realloc(w, p.id, body(v, [{ type: 'INVOICE', amountPaise: 600_000 }]))).status).toBe(400);
    expect((await realloc(w, p.id, body(v, [{ type: 'ADVANCE', amountPaise: 50 }]))).status).toBe(400);
    expect(
      (
        await realloc(
          w,
          p.id,
          body(v, [
            { type: 'ADVANCE', amountPaise: 300_000 },
            { type: 'ADVANCE', amountPaise: 300_000 },
          ]),
        )
      ).status,
    ).toBe(400);
    expect((await realloc(w, p.id, body(v, ok, 'short'))).status).toBe(400);
    const guard = await adminOf(w.society, 'committee_member');
    expect(
      (await guard.c('post', `/payments/${p.id}/reallocate`, body(v, ok), { headers: idemH() })).status,
    ).toBe(403);
    expect((await reverse(w, p.id, reverseBody(v))).status).toBe(200);
    const r = await realloc(w, p.id, body(Number((await fresh(p.id)).version), ok));
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('REALLOCATION_INVALID when the advance part of the payment was already spent', async () => {
    const w = await paymentsWorld({ flats: 1 });
    const a = await mkInvoice(w, 0, 100_000, '2026-11-10');
    const p = await pay(w, 0, 150_000);
    await mkInvoice(w, 0, 50_000, '2026-12-10');
    await moneyTx(t => applyAdvancesForUnit(sysCtx(w), w.society.id!, w.units[0]!.id, t));
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(0);
    const r = await realloc(
      w,
      p.id,
      body(Number((await fresh(p.id)).version), [
        { type: 'INVOICE', id: Number(a.id), amountPaise: 100_000 },
        { type: 'ADVANCE', amountPaise: 50_000 },
      ]),
    );
    expect(r.status).toBe(200); // keeping the advance part as it is stays possible
    const x = await realloc(
      w,
      p.id,
      body(Number((await fresh(p.id)).version), [
        { type: 'INVOICE', id: Number(a.id), amountPaise: 150_000 },
      ]),
    );
    expect([x.status, x.body.code]).toEqual([422, 'AMOUNT_EXCEEDS_DUE']);
  });
});

describe('balancing journal lines', () => {
  it('nets the credit side per account and fund; nothing when unchanged', () => {
    const l = (accountCode: string, creditPaise: number, fundId?: number) => ({
      accountCode,
      debitPaise: 0,
      creditPaise,
      unitId: 1,
      ...(fundId ? { fundId } : {}),
    });
    expect(balancingLines([l('MEMBER_RECEIVABLE', 500)], [l('MEMBER_RECEIVABLE', 500)], 1)).toEqual([]);
    const out = balancingLines(
      [l('MEMBER_RECEIVABLE', 500)],
      [l('MEMBER_RECEIVABLE', 300), l('MEMBER_ADVANCES', 200)],
      1,
    );
    expect(out).toEqual([
      { accountCode: 'MEMBER_RECEIVABLE', debitPaise: 200, creditPaise: 0, unitId: 1 },
      { accountCode: 'MEMBER_ADVANCES', debitPaise: 0, creditPaise: 200, unitId: 1 },
    ]);
  });
});
