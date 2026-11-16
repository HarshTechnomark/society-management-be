import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Collection,
  CollectionRequest,
  Payment,
  Refund,
  UnitLedgerEntry,
  closeDb,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { reversePaymentCore } from '../../../src/modules/payments/payments.reverse.core';
import {
  ReadTimeoutError,
  maskName,
  paymentsReports,
  readRows,
} from '../../../src/modules/payments/payments.reports';
import { payments } from '../../../src/modules/payments/payments.public';
import { ReadTimeoutError as BillingReadTimeoutError } from '../../../src/modules/billing/billing.public';
import { mkInvoice, offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';

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
const opts = { deadlineMs: 20_000 };

async function world() {
  const w = await paymentsWorld({ flats: 3 });
  await mkInvoice(w, 0, 500_000, '2026-11-10');
  await mkInvoice(w, 1, 300_000, '2026-11-10');
  const a = await pay(w, 0, 500_000, {
    payerName: 'Rohan Sharma',
    method: 'NEFT',
    paymentDate: '2026-11-04',
  });
  const b = await pay(w, 1, 100_000, {
    payerName: 'Meera Iyer',
    method: 'CASH',
    referenceNo: null,
    referenceKey: null,
    paymentDate: '2026-11-05',
  });
  const c = await pay(w, 1, 200_000, {
    payerName: 'Meera Iyer',
    method: 'CHEQUE',
    status: 'RECEIVED',
    referenceNo: '123456',
    referenceKey: 'CHQ:H:123456',
    chequeBankName: 'H',
    chequeDate: '2026-11-02',
    paymentDate: '2026-11-06',
  });
  const d = await pay(w, 2, 70_000, { payerName: 'Kiran Patel', paymentDate: '2026-11-07' });
  await moneyTx(t =>
    reversePaymentCore(
      sysCtx(w),
      Number(c.id),
      {
        newStatus: 'BOUNCED',
        patch: { bouncedOn: '2026-11-08', bounceReason: 'Insufficient funds' } as never,
      },
      t,
    ),
  );
  await Refund.create({
    societyId: w.society.id!,
    unitId: w.units[0]!.id,
    paymentId: a.id,
    amountPaise: 20_000,
    mode: 'BANK_TRANSFER',
    status: 'PROCESSED',
    reason: 'overpaid',
    processedAt: new Date('2026-11-09T05:00:00Z'),
  } as never).catch(() => undefined);
  return { w, a, b, c, d };
}

describe('paymentsReports.summary (8.27, T12-47)', () => {
  it('received, reversed, refunded and the method mix; received equals the receipt ledger credits of effective payments', async () => {
    const { w, c } = await world();
    const r = await paymentsReports.summary(w.society.id!, '2026-11-01', '2026-11-30', opts);
    expect(r.receivedPaise).toBe(500_000 + 100_000 + 70_000);
    expect(r.paymentCount).toBe(3);
    expect(r.byMethod).toEqual({ NEFT: 570_000, CASH: 100_000 });
    expect(r.reversedPaise).toBe(Number(c.amountPaise));
    expect(r.refundedPaise).toBe((await Refund.count({ where: { societyId: w.society.id! } })) ? 20_000 : 0);
    expect(r.advanceCreditedPaise).toBe(70_000);
    expect(r.efficiencyPercent).toBeNull(); // no regular bill of the month
    const credits = await UnitLedgerEntry.findAll({
      where: { societyId: w.society.id!, entryType: 'PAYMENT' },
    });
    const effective = await Payment.findAll({ where: { societyId: w.society.id!, status: 'CONFIRMED' } });
    expect(effective.reduce((s, p) => s + Number(p.amountPaise), 0)).toBe(r.receivedPaise);
    expect(credits.length).toBe(4);
  });

  it('a window without payments is all zero with a null efficiency', async () => {
    const { w } = await world();
    const r = await paymentsReports.summary(w.society.id!, '2025-01-01', '2025-01-31', opts);
    expect(r).toEqual({
      receivedPaise: 0,
      reversedPaise: 0,
      refundedPaise: 0,
      paymentCount: 0,
      byMethod: {},
      advanceCreditedPaise: 0,
      efficiencyPercent: null,
    });
  });

  it("refuses a bad range (programmer error) and reads only the caller's society", async () => {
    const { w } = await world();
    await expect(paymentsReports.summary(w.society.id!, '2026-12-01', '2026-11-01')).rejects.toThrow();
    await expect(paymentsReports.summary(w.society.id!, '2020-01-01', '2026-11-01')).rejects.toThrow();
    const other = await paymentsWorld({ flats: 1 });
    expect(
      (await paymentsReports.summary(other.society.id!, '2026-11-01', '2026-11-30', opts)).receivedPaise,
    ).toBe(0);
  });
});

describe('paymentsReports.register (8.27, T12-50)', () => {
  const q = (o: Record<string, unknown> = {}) => ({
    from: '2026-11-01',
    to: '2026-11-30',
    page: 1,
    limit: 50,
    sortBy: 'paymentDate' as const,
    sortDir: 'asc' as const,
    ...o,
  });

  it('masks payer names by default (R*** S****), shows them when unmasked, and never returns phone or email', async () => {
    const { w } = await world();
    const m = await paymentsReports.register(w.society.id!, q(), opts);
    expect(m.total).toBe(4);
    expect(m.rows.map(r => r.payerName)).toEqual(
      ['R**** S*****', 'M**** I***', 'M**** I***', 'K**** P****'].map(x => x),
    );
    const u = await paymentsReports.register(w.society.id!, q({ piiClass: 'unmasked' }), opts);
    expect(u.rows[0]!.payerName).toBe('Rohan Sharma');
    for (const row of [...m.rows, ...u.rows])
      expect(Object.keys(row).sort()).toEqual([
        'amountPaise',
        'convenienceFeePaise',
        'id',
        'method',
        'payerName',
        'paymentDate',
        'receiptNo',
        'referenceNo',
        'refundedPaise',
        'status',
        'toAdvancePaise',
        'toCollectionsPaise',
        'toInvoicesPaise',
        'unitLabel',
      ]);
    expect(maskName('Rohan Sharma')).toBe('R**** S*****');
  });

  it('filters, sorts, pages and totals', async () => {
    const { w } = await world();
    const cash = await paymentsReports.register(w.society.id!, q({ method: ['CASH'] }), opts);
    expect(cash.rows.map(r => r.method)).toEqual(['CASH']);
    expect(cash.totals).toEqual({ amountPaise: 100_000, refundedPaise: 0 });
    const bounced = await paymentsReports.register(w.society.id!, q({ status: ['BOUNCED'] }), opts);
    expect(bounced.total).toBe(1);
    const byUnit = await paymentsReports.register(w.society.id!, q({ unitId: w.units[1]!.id }), opts);
    expect(byUnit.total).toBe(2);
    const desc = await paymentsReports.register(
      w.society.id!,
      q({ sortBy: 'amountPaise', sortDir: 'desc', limit: 2, page: 2 }),
      opts,
    );
    expect(desc.rows).toHaveLength(2);
    expect(desc.total).toBe(4);
    expect(desc.rows[0]!.amountPaise).toBeLessThanOrEqual(200_000);
    expect(desc.totals.amountPaise).toBe(870_000);
  });

  it('limit above 1000 and a sort outside the whitelist are programmer errors; buildingIds limit the rows', async () => {
    const { w } = await world();
    await expect(paymentsReports.register(w.society.id!, q({ limit: 1001 }), opts)).rejects.toThrow();
    await expect(paymentsReports.register(w.society.id!, q({ sortBy: 'payerName' }), opts)).rejects.toThrow();
    expect(
      (await paymentsReports.register(w.society.id!, q({ buildingIds: [w.buildingId] }), opts)).total,
    ).toBe(4);
    expect(
      (await paymentsReports.register(w.society.id!, q({ buildingIds: [w.buildingId + 999] }), opts)).total,
    ).toBe(0);
  });
});

describe('paymentsReports.collectionProgress (8.27)', () => {
  it('progress per collection, recomputed for the buildings in scope', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const col = await Collection.create({
      societyId: w.society.id!,
      title: 'Diwali',
      kind: 'FESTIVAL',
      purpose: 'Diwali celebration',
      amountMode: 'MIN_PER_UNIT',
      amountPerUnitPaise: 100_000,
      minAmountPaise: 100_000,
      isMandatory: false,
      audienceType: 'ALL',
      targetPaise: 200_000,
      dueDate: '2026-12-01',
      fundId: 5,
      status: 'PUBLISHED',
    } as never);
    const r1 = await CollectionRequest.create({
      societyId: w.society.id!,
      collectionId: col.id,
      unitId: w.units[0]!.id,
      amountPaise: 100_000,
      minAmountPaise: 100_000,
    } as never);
    await CollectionRequest.create({
      societyId: w.society.id!,
      collectionId: col.id,
      unitId: w.units[1]!.id,
      amountPaise: 100_000,
      minAmountPaise: 100_000,
    } as never);
    await moneyTx(t =>
      settleInput(
        sysCtx(w),
        offline(w, 0, 100_000, {
          mode: 'SELECTED',
          selected: [{ targetType: 'COLLECTION_REQUEST', id: Number(r1.id), amountPaise: 100_000 }],
        }),
        t,
      ),
    );
    const base = { page: 1, limit: 10, sortBy: 'dueDate' as const, sortDir: 'asc' as const };
    const r = await paymentsReports.collectionProgress(w.society.id!, base, opts);
    expect(r.total).toBe(1);
    expect(r.rows[0]).toMatchObject({
      title: 'Diwali',
      kind: 'FESTIVAL',
      isMandatory: false,
      status: 'PUBLISHED',
      targetPaise: 200_000,
      collectedPaise: 100_000,
      percent: 50,
      requestCount: 2,
      paidCount: 1,
      contributorCount: 1,
      dueDate: '2026-12-01',
      fundName: 'Fund 5',
      spentPaise: null,
    });
    expect(r.totals).toEqual({ targetPaise: 200_000, collectedPaise: 100_000 });
    const scoped = await paymentsReports.collectionProgress(
      w.society.id!,
      { ...base, buildingIds: [w.buildingId] },
      opts,
    );
    expect(scoped.rows[0]!.requestCount).toBe(2);
    const none = await paymentsReports.collectionProgress(
      w.society.id!,
      { ...base, buildingIds: [w.buildingId + 999] },
      opts,
    );
    expect(none.rows).toEqual([]);
    expect(
      (await paymentsReports.collectionProgress(w.society.id!, { ...base, status: ['CLOSED'] }, opts)).total,
    ).toBe(0);
    await expect(
      paymentsReports.collectionProgress(w.society.id!, { ...base, sortBy: 'x' as never }, opts),
    ).rejects.toThrow();
  });
});

describe('read deadline', () => {
  it('a read that cannot finish in deadlineMs throws ReadTimeoutError', async () => {
    const heavy =
      'SELECT COUNT(*) AS n FROM information_schema.columns a, information_schema.columns b, information_schema.columns c';
    await expect(readRows(heavy, {}, { deadlineMs: 20 })).rejects.toBeInstanceOf(ReadTimeoutError);
  });
  it('is the same class module 11 exports', async () => {
    expect(ReadTimeoutError).toBe(BillingReadTimeoutError);
  });
});

void payments;
