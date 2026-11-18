import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalRequest, Deposit, Invoice, JournalEntry, LedgerAccount, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { accountsPortCalls, setAccountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { sequelize } from '../../../src/models';
import * as svc from '../../../src/modules/accounts/accounts.deposits.service';
import { registerDepositHooks } from '../../../src/modules/accounts/accounts.periods.jobs';
import { committeeApprove, committeeReject, ensureSystemUser } from '../../helpers/approvals-decide';
import { deposits as publicDeposits } from '../../../src/modules/accounts/accounts.public';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { ctxFor } from '../../helpers/billing-invoices';
import { idemH, type RunSociety } from '../../helpers/billing-runs';
import { offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { addBankLedger, balanceOf, post, useRealJournal } from '../../helpers/accounts';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});

let w: RunSociety;
let admin: ReturnType<typeof ctxFor>;
let bankId: number;
const sid = () => w.society.id!;

beforeEach(async () => {
  await resetPayments();
  setAccountsPorts();
  useRealJournal();
  svc.clearDepositOwners();
  registerDepositHooks();
  w = await paymentsWorld({ flats: 2 });
  await ensureSystemUser(); // owner modules raise refunds with a system context
  admin = ctxFor(w, w.user.id!);
  await sequelize.transaction(t => ensureBooks(t, sid()));
  bankId = Number((await addBankLedger(sid())).id);
  await post(sysCtx(w), {
    date: '2026-11-01',
    voucherType: 'OPENING_BALANCE',
    refType: 'seed_bank',
    refId: 1,
    narration: 'Seed bank',
    lines: [
      { ledgerAccountCode: '1110-001', debitPaise: 5_000_000, creditPaise: 0 },
      { ledgerAccountCode: '3900', debitPaise: 0, creditPaise: 5_000_000 },
    ],
  });
});

const make = (o: Record<string, unknown> = {}) =>
  svc.createDeposit(admin, {
    unitId: w.units[0]!.id,
    kind: 'RENOVATION',
    title: 'Renovation deposit kitchen',
    amountPaise: 2_500_000,
    dueDate: '2026-11-10',
    ...o,
  } as never);

/** Pays the deposit invoice in cash and runs the sync job: the deposit becomes HELD. */
async function held(o: Record<string, unknown> = {}, amountPaise = 2_500_000) {
  const d = await make({ amountPaise, ...o });
  await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, amountPaise, { method: 'CASH' }), t));
  await svc.depositSyncJob({ societyId: sid() });
  return svc.getDeposit(sid(), d.id);
}
const today = '2026-11-04';

describe('deposit lifecycle (T13-26)', () => {
  it('charge, paid, deduct, refund request, approval and payout', async () => {
    const d = await make();
    expect(d).toMatchObject({ status: 'AWAITING_PAYMENT', receivedPaise: 0, code: `DEP-${d.id}` });
    expect(d.invoiceId).toBeGreaterThan(0);
    expect(await balanceOf(sid(), '2510')).toBe(-2_500_000); // module 11 credited the deposit ledger
    await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 2_500_000, { method: 'CASH' }), t));
    expect(await svc.depositSyncJob({ societyId: sid() })).toBe(1);
    let cur = await svc.getDeposit(sid(), d.id);
    expect(cur).toMatchObject({ status: 'HELD', receivedPaise: 2_500_000, heldPaise: 2_500_000 });

    cur = await svc.deductDeposit(admin, d.id, {
      amountPaise: 300_000,
      reason: 'Damaged lift lobby',
      date: today,
      version: cur.version,
    });
    expect(cur).toMatchObject({ status: 'HELD', deductedPaise: 300_000, heldPaise: 2_200_000 });
    expect(await balanceOf(sid(), '4600')).toBe(-300_000);
    expect(await balanceOf(sid(), '2510')).toBe(-2_200_000);
    const j = (await JournalEntry.findOne({
      where: { societyId: sid(), refType: 'deposit', refId: `${d.id}:1` },
    }))!;
    expect([j.voucherType, Number(j.totalPaise)]).toEqual(['JOURNAL', 300_000]);

    cur = await svc.requestDepositRefund(admin, d.id, { version: cur.version });
    expect(cur).toMatchObject({ status: 'REFUND_PENDING', refundRequestedPaise: 2_200_000 });
    const req = (await ApprovalRequest.findByPk(cur.refundApprovalRequestId!))!;
    expect([req.type, req.entityType, Number(req.amountPaise), req.status]).toEqual([
      'DEPOSIT_REFUND',
      'deposit',
      2_200_000,
      'PENDING',
    ]);
    await committeeApprove(cur.refundApprovalRequestId!);
    cur = await svc.getDeposit(sid(), d.id);
    expect(cur.status).toBe('REFUND_APPROVED');

    cur = await svc.markRefundPaid(admin, d.id, {
      paidFromLedgerAccountId: bankId,
      refundMode: 'NEFT',
      refundReference: 'UTR123456',
      date: today,
      version: cur.version,
    });
    expect(cur).toMatchObject({
      status: 'REFUNDED',
      refundedPaise: 2_200_000,
      heldPaise: 0,
      refundRequestedPaise: 0,
    });
    expect(await balanceOf(sid(), '2510')).toBe(0);
    expect(await balanceOf(sid(), '1110-001')).toBe(5_000_000 - 2_200_000);
    const pay = (await JournalEntry.findOne({
      where: { societyId: sid(), refType: 'deposit', refId: `${d.id}:refund` },
    }))!;
    expect(pay.voucherType).toBe('PAYMENT');
    expect(cur.adjustments.map(a => a.kind)).toEqual(['DEDUCTION', 'REFUND']);
  });

  it('a deduction above the held amount is 422 DEPOSIT_INSUFFICIENT_HELD (T13-27)', async () => {
    const d = await held();
    await expect(
      svc.deductDeposit(admin, d.id, {
        amountPaise: 2_600_000,
        reason: 'Too much',
        date: today,
        version: d.version,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'DEPOSIT_INSUFFICIENT_HELD' });
  });

  it('a deduction that leaves nothing forfeits the deposit; forfeit takes the whole held amount', async () => {
    const d = await held({}, 100_000);
    const f = await svc.deductDeposit(admin, d.id, {
      amountPaise: 100_000,
      reason: 'Everything damaged',
      date: today,
      version: d.version,
    });
    expect(f).toMatchObject({ status: 'FORFEITED', heldPaise: 0 });
    const d2 = await held({ kind: 'KEY', title: 'Key deposit' }, 50_000);
    const f2 = await svc.forfeitDeposit(admin, d2.id, {
      reason: 'Key lost for good',
      date: today,
      version: d2.version,
    });
    expect(f2).toMatchObject({ status: 'FORFEITED', deductedPaise: 50_000 });
    expect(await balanceOf(sid(), '4600')).toBe(-150_000);
    expect(accountsPortCalls.length).toBeGreaterThanOrEqual(0);
  });

  it('deduct and forfeit need a HELD deposit and the current version', async () => {
    const d = await make();
    await expect(
      svc.deductDeposit(admin, d.id, {
        amountPaise: 1000,
        reason: 'Not held yet',
        date: today,
        version: d.version,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    const h = await held({ kind: 'MOVE', title: 'Move deposit' }, 100_000);
    await expect(
      svc.forfeitDeposit(admin, h.id, { reason: 'Stale write', date: today, version: h.version + 5 }),
    ).rejects.toMatchObject({ status: 409, code: 'STALE_VERSION' });
    await expect(
      svc.deductDeposit(admin, h.id, {
        amountPaise: 1000,
        reason: 'Future date',
        date: '2026-12-01',
        version: h.version,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'DATE_OUT_OF_RANGE' });
  });

  it('a rejected refund goes back to HELD and can be requested again', async () => {
    const d = await held({}, 200_000);
    const p = await svc.requestDepositRefund(admin, d.id, { reason: 'Work finished', version: d.version });
    await committeeReject(p.refundApprovalRequestId!, 'Inspect first');
    const back = await svc.getDeposit(sid(), d.id);
    expect(back).toMatchObject({ status: 'HELD', refundRequestedPaise: 0 });
    expect(back.timeline!.find(e => e.action === 'accounts.deposit.refund_rejected')).toMatchObject({
      reason: 'Inspect first',
    });
    const again = await svc.requestDepositRefund(admin, d.id, { version: back.version });
    expect(again.status).toBe('REFUND_PENDING');
  });

  it('a request while one is open is refused; refund-paid needs REFUND_APPROVED', async () => {
    const d = await held({}, 200_000);
    const p = await svc.requestDepositRefund(admin, d.id, { version: d.version });
    await expect(svc.requestDepositRefund(admin, d.id, { version: p.version })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      svc.markRefundPaid(admin, d.id, {
        paidFromLedgerAccountId: bankId,
        refundMode: 'NEFT',
        refundReference: 'UTR123456',
        date: today,
        version: p.version,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('refund-paid checks the source, the mode, the reference and the balance (BR-13-47, BR-13-22, BR-13-26)', async () => {
    const d = await held({}, 200_000);
    const p = await svc.requestDepositRefund(admin, d.id, { version: d.version });
    await committeeApprove(p.refundApprovalRequestId!);
    const cur = await svc.getDeposit(sid(), d.id);
    const base = {
      paidFromLedgerAccountId: bankId,
      refundMode: 'NEFT' as const,
      refundReference: 'UTR123456',
      date: today,
      version: cur.version,
    };
    await expect(svc.markRefundPaid(admin, d.id, { ...base, refundMode: 'CASH' })).rejects.toMatchObject({
      code: 'INVALID_PAYMENT_SOURCE',
    });
    await expect(svc.markRefundPaid(admin, d.id, { ...base, refundReference: 'x' })).rejects.toMatchObject({
      code: 'INVALID_PAYMENT_SOURCE',
    });
    await expect(
      svc.markRefundPaid(admin, d.id, { ...base, paidFromLedgerAccountId: 99_999_999 }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYMENT_SOURCE' });
    // drain the bank so the balance check fails
    await post(sysCtx(w), {
      date: '2026-11-02',
      voucherType: 'PAYMENT',
      refType: 'drain',
      refId: 1,
      narration: 'Drain bank',
      lines: [
        { ledgerAccountCode: '5600', debitPaise: 4_950_000, creditPaise: 0 },
        { ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: 4_950_000 },
      ],
    });
    await expect(svc.markRefundPaid(admin, d.id, base)).rejects.toMatchObject({
      status: 422,
      code: 'INSUFFICIENT_BALANCE',
    });
    expect((await svc.getDeposit(sid(), d.id)).status).toBe('REFUND_APPROVED'); // nothing changed
  });

  it('cash refunds go with a cash account', async () => {
    const d = await held({}, 100_000);
    const p = await svc.requestDepositRefund(admin, d.id, { version: d.version });
    await committeeApprove(p.refundApprovalRequestId!);
    const cashAcc = (await LedgerAccount.findOne({ where: { societyId: sid(), code: '1120' } }))!;
    const cur = await svc.getDeposit(sid(), d.id);
    const r = await svc.markRefundPaid(admin, d.id, {
      paidFromLedgerAccountId: Number(cashAcc.id),
      refundMode: 'CASH',
      date: today,
      version: cur.version,
    });
    expect(r.status).toBe('REFUNDED');
  });
});

describe('create, opening, cancel and sync', () => {
  it('an opening deposit is HELD at once and posts Dr 3900, Cr the deposit ledger', async () => {
    const before = await balanceOf(sid(), '3900');
    const d = await svc.createDeposit(admin, {
      unitId: w.units[1]!.id,
      kind: 'AMENITY',
      title: 'Clubhouse deposit',
      amountPaise: 80_000,
      isOpening: true,
      openingDate: '2026-10-01',
    });
    expect(d).toMatchObject({ status: 'HELD', receivedPaise: 80_000, invoiceId: null, isOpening: true });
    expect(await balanceOf(sid(), '2530')).toBe(-80_000);
    expect(await balanceOf(sid(), '3900')).toBe(before + 80_000);
  });

  it('the same refType, refId and kind is 409 DUPLICATE; amounts and due dates are validated', async () => {
    await make({ refType: 'move_request', refId: 7, kind: 'MOVE' });
    await expect(make({ refType: 'move_request', refId: 7, kind: 'MOVE' })).rejects.toMatchObject({
      status: 409,
      code: 'DUPLICATE',
    });
    await expect(make({ amountPaise: 50 })).rejects.toMatchObject({ status: 400 });
    await expect(make({ dueDate: '2027-03-01' })).rejects.toMatchObject({ status: 400 });
    await expect(make({ residentId: 987654 })).rejects.toMatchObject({ status: 404 });
  });

  it('cancel works only while awaiting payment and requests the invoice cancellation', async () => {
    const d = await make({ unitId: w.units[1]!.id });
    const c = await svc.cancelDeposit(admin, d.id, { reason: 'Raised by mistake', version: d.version });
    expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'Raised by mistake' });
    expect(await ApprovalRequest.count({ where: { type: 'INVOICE_CANCEL' } })).toBe(1);
    await expect(
      svc.cancelDeposit(admin, d.id, { reason: 'Again please', version: c.version }),
    ).rejects.toMatchObject({
      status: 409,
    });
    const h = await held({ kind: 'KEY', title: 'Key deposit' }, 50_000);
    await expect(
      svc.cancelDeposit(admin, h.id, { reason: 'Too late', version: h.version }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('cancel of a part-paid deposit says why', async () => {
    const d = await make({ unitId: w.units[1]!.id });
    const inv = (await Invoice.findByPk(d.invoiceId!))!;
    await inv.update({ paidPaise: 1_000, outstandingPaise: Number(inv.totalPaise) - 1_000 });
    await expect(
      svc.cancelDeposit(admin, d.id, { reason: 'Raised by mistake', version: d.version }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_STATE',
      errors: [{ message: expect.stringContaining('payment has already been applied') }],
    });
  });

  it('deposit-sync sends a HELD deposit back when its invoice is no longer paid, but not after a deduction', async () => {
    const d = await held({}, 300_000);
    await Invoice.update({ status: 'PARTIALLY_PAID' } as never, { where: { id: d.invoiceId! } });
    expect(await svc.depositSyncJob({ societyId: sid() })).toBe(1);
    expect((await svc.getDeposit(sid(), d.id)).status).toBe('AWAITING_PAYMENT');
    await Invoice.update({ status: 'PAID' } as never, { where: { id: d.invoiceId! } });
    await svc.depositSyncJob({ societyId: sid() });
    const h = await svc.getDeposit(sid(), d.id);
    expect(h.status).toBe('HELD');
    await svc.deductDeposit(admin, d.id, {
      amountPaise: 1000,
      reason: 'Small damage',
      date: today,
      version: h.version,
    });
    await Invoice.update({ status: 'PARTIALLY_PAID' } as never, { where: { id: d.invoiceId! } });
    expect(await svc.depositSyncJob({ societyId: sid() })).toBe(0);
    expect((await svc.getDeposit(sid(), d.id)).status).toBe('HELD');
  });

  it('the module 12 order hook marks the deposit HELD inside the capture transaction', async () => {
    const d = await make();
    await Invoice.update({ status: 'PAID' } as never, { where: { id: d.invoiceId! } });
    await moneyTx(t => svc.onDepositOrderPaid(sysCtx(w), { societyId: sid(), refId: d.id }, t));
    expect((await svc.getDeposit(sid(), d.id)).status).toBe('HELD');
    const row = (await Deposit.findByPk(d.id))!;
    expect(row.receivedAt).not.toBeNull();
  });
});

describe('owner modules (BR-13-45a, T13-45, T13-46)', () => {
  const owner = () => {
    const calls: { fn: string; input: any }[] = [];
    publicDeposits.registerOwner('move_request', {
      onDepositPaid: async (_c, input) => void calls.push({ fn: 'paid', input }),
      onDepositRefunded: async (_c, input) => void calls.push({ fn: 'refunded', input }),
    });
    return calls;
  };

  it('request is idempotent; paid calls onDepositPaid once; refund with a deduction pays the rest', async () => {
    const calls = owner();
    const ctx = sysCtx(w);
    const ask = () =>
      moneyTx(t =>
        publicDeposits.request(
          ctx,
          { unitId: w.units[0]!.id, kind: 'MOVE', refType: 'move_request', refId: 55, amountPaise: 500_000 },
          t,
        ),
      );
    const r1 = await ask();
    const r2 = await ask();
    expect(r2.depositId).toBe(r1.depositId);
    expect(r1.invoiceId).toBeGreaterThan(0);
    await drainQueues();
    await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 500_000, { method: 'CASH' }), t));
    await svc.depositSyncJob({ societyId: sid() });
    await svc.depositSyncJob({ societyId: sid() });
    expect(calls.filter(c => c.fn === 'paid')).toEqual([
      { fn: 'paid', input: { refType: 'move_request', refId: 55, depositId: r1.depositId } },
    ]);
    await moneyTx(t =>
      publicDeposits.requestRefund(ctx, r1.depositId, { deductionPaise: 50_000, reason: 'Wall scratch' }, t),
    );
    let cur = await svc.getDeposit(sid(), r1.depositId);
    expect(cur).toMatchObject({
      status: 'REFUND_PENDING',
      deductedPaise: 50_000,
      refundRequestedPaise: 450_000,
    });
    await committeeApprove(cur.refundApprovalRequestId!);
    cur = await svc.getDeposit(sid(), r1.depositId);
    await svc.markRefundPaid(admin, r1.depositId, {
      paidFromLedgerAccountId: bankId,
      refundMode: 'UPI',
      refundReference: 'UPI123456',
      date: today,
      version: cur.version,
    });
    expect(calls.find(c => c.fn === 'refunded')!.input).toMatchObject({ refundedPaise: 450_000 });
  });

  it('a deduction equal to the held amount forfeits with no approval and refundedPaise 0', async () => {
    const calls = owner();
    const ctx = sysCtx(w);
    const { depositId } = await moneyTx(t =>
      publicDeposits.request(
        ctx,
        { unitId: w.units[0]!.id, kind: 'MOVE', refType: 'move_request', refId: 56, amountPaise: 100_000 },
        t,
      ),
    );
    await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 100_000, { method: 'CASH' }), t));
    await svc.depositSyncJob({ societyId: sid() });
    const before = await ApprovalRequest.count({ where: { type: 'DEPOSIT_REFUND' } });
    await moneyTx(t =>
      publicDeposits.requestRefund(ctx, depositId, { deductionPaise: 100_000, reason: 'All forfeited' }, t),
    );
    expect((await svc.getDeposit(sid(), depositId)).status).toBe('FORFEITED');
    expect(await ApprovalRequest.count({ where: { type: 'DEPOSIT_REFUND' } })).toBe(before);
    expect(calls.find(c => c.fn === 'refunded')!.input.refundedPaise).toBe(0);
  });

  it('requestRefund on an unpaid deposit cancels it and its invoice without approval', async () => {
    const ctx = sysCtx(w);
    const { depositId, invoiceId } = await moneyTx(t =>
      publicDeposits.request(
        ctx,
        { unitId: w.units[1]!.id, kind: 'AMENITY', refType: 'booking', refId: 9, amountPaise: 90_000 },
        t,
      ),
    );
    await moneyTx(t =>
      publicDeposits.requestRefund(ctx, depositId, { deductionPaise: 0, reason: 'Booking expired' }, t),
    );
    expect((await svc.getDeposit(sid(), depositId)).status).toBe('CANCELLED');
    expect((await Invoice.findByPk(invoiceId))!.status).toBe('CANCELLED');
  });

  it('one owner per refType: a second registration throws', () => {
    owner();
    expect(() => owner()).toThrow(/already has an owner/);
  });
});

describe('routes and isolation (T13-35)', () => {
  it('another society sees 404 DEPOSIT_NOT_FOUND on every deposit route', async () => {
    const d = await make();
    const other = await paymentsWorld({ flats: 1 });
    expect(await other.c('get', `/accounts/deposits/${d.id}`)).toMatchObject({
      status: 404,
      body: { code: 'DEPOSIT_NOT_FOUND' },
    });
    for (const [path, body] of [
      ['deduct', { amountPaise: 1000, reason: 'Not yours', date: today, version: 1 }],
      ['forfeit', { reason: 'Not yours', date: today, version: 1 }],
      ['refund-request', { version: 1 }],
      [
        'refund-paid',
        {
          paidFromLedgerAccountId: 1,
          refundMode: 'NEFT',
          refundReference: 'UTR123456',
          date: today,
          version: 1,
        },
      ],
      ['cancel', { reason: 'Not yours', version: 1 }],
    ] as const) {
      const r = await other.c('post', `/accounts/deposits/${d.id}/${path}`, body, { headers: idemH() });
      expect(r.body.code, `${path} ${JSON.stringify(r.body)}`).toBe('DEPOSIT_NOT_FOUND');
    }
    await expect(svc.getDeposit(other.society.id!, d.id)).rejects.toMatchObject({
      code: 'DEPOSIT_NOT_FOUND',
    });
  });

  it('create, list, get and cancel over HTTP', async () => {
    const r = await w.c(
      'post',
      '/accounts/deposits',
      {
        unitId: w.units[0]!.id,
        kind: 'KEY',
        title: 'Key deposit',
        amountPaise: 10_000,
        dueDate: '2026-11-08',
      },
      { headers: idemH() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.data.id;
    const list = await w.c('get', '/accounts/deposits', undefined, {
      query: { status: 'AWAITING_PAYMENT', q: `DEP-${id}` },
    });
    expect(list.body.data.map((x: any) => x.id)).toEqual([id]);
    expect(list.body.pagination.total).toBe(1);
    expect((await w.c('get', `/accounts/deposits/${id}`)).body.data.code).toBe(`DEP-${id}`);
    const bad = await w.c(
      'post',
      '/accounts/deposits',
      { unitId: 1, kind: 'KEY', title: 'x', amountPaise: 10 },
      { headers: idemH() },
    );
    expect(bad.status).toBe(400);
    const cancel = await w.c('post', `/accounts/deposits/${id}/cancel`, {
      reason: 'Raised by mistake',
      version: r.body.data.version,
    });
    expect(cancel.body.data.status).toBe('CANCELLED');
  });

  it('GET /accounts/deposits/summary totals held, refunded and forfeited over every deposit', async () => {
    const mk = async (title: string, amountPaise: number) =>
      (
        await w.c(
          'post',
          '/accounts/deposits',
          {
            unitId: w.units[0]!.id,
            kind: 'KEY',
            title,
            amountPaise,
            isOpening: true,
            openingDate: '2026-10-01',
          },
          { headers: idemH() },
        )
      ).body.data;
    const a = await mk('Key deposit A', 50_000);
    await mk('Key deposit B', 20_000);
    const f = await w.c(
      'post',
      `/accounts/deposits/${a.id}/forfeit`,
      { reason: 'Keys never returned', date: '2026-11-02', version: a.version },
      { headers: idemH() },
    );
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const sum = await w.c('get', '/accounts/deposits/summary');
    expect(sum.status, JSON.stringify(sum.body)).toBe(200);
    expect(sum.body.data).toEqual({ heldPaise: 20_000, refundedPaise: 0, forfeitedPaise: 50_000 });
  });
});

describe('resident view', () => {
  it('lists only the deposits of the caller units, without internal notes', async () => {
    await make({ notes: 'secret note' });
    await svc.createDeposit(admin, {
      unitId: w.units[1]!.id,
      kind: 'KEY',
      title: 'Key deposit',
      amountPaise: 10_000,
      dueDate: '2026-11-10',
    });
    const mine = await svc.listMyDeposits({ ...admin, unitIds: [w.units[0]!.id] });
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toHaveProperty('notes');
    expect(mine[0]).not.toHaveProperty('refundApprovalRequestId');
    expect(await svc.listMyDeposits({ ...admin, unitIds: [] })).toEqual([]);
  });
});
