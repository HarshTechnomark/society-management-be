import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Invoice, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { billingReports, ReadTimeoutError } from '../../../src/modules/billing/billing.public';
import { readRows } from '../../../src/modules/billing/billing.dues.queries';
import { billingPortCalls, setBillingPorts } from '../../../src/modules/billing/billing.ports';
import { unitLedger } from '../../../src/modules/billing/billing.ledger.service';
import {
  gapsOf,
  reconcileSociety,
  runReconcileAll,
} from '../../../src/modules/billing/billing.reconcile.service';
import { approve } from '../../../src/modules/billing/billing.runs.approvals-hook';
import { systemCtx } from '../../../src/types/context';
import { createAndCompute, idemH, standardRules } from '../../helpers/billing-runs';
import { duesWorld, makeInvoice, resetDues, type DuesWorld } from '../../helpers/billing-dues';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetDues);

const nov = '2026-11-01';
const ctxOf = (w: DuesWorld, userId: number) => ({
  ...systemCtx('t'),
  user: { id: userId, name: 'D', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' as const },
  society: { id: w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});
const list = { page: 1, limit: 100, sortDir: 'desc' as const };

/** Open, overdue, disputed, paid and part-paid invoices over four flats. */
async function seeded() {
  const w = await duesWorld(4);
  const [a, b, c, d] = w.units as DuesWorld['units'];
  const o = (u: { label: string }) => w.owners[u.label]!;
  await makeInvoice(w, {
    unit: a!,
    billTo: o(a!),
    totalPaise: 500_000,
    paidPaise: 500_000,
    periodStart: nov,
    invoiceDate: nov,
    dueDate: '2026-11-10',
    settledOn: '2026-11-02',
  });
  await makeInvoice(w, {
    unit: b!,
    billTo: o(b!),
    totalPaise: 400_000,
    periodStart: nov,
    invoiceDate: nov,
    dueDate: '2026-11-20',
  });
  await makeInvoice(w, {
    unit: c!,
    billTo: o(c!),
    totalPaise: 800_000,
    paidPaise: 100_000,
    periodStart: nov,
    invoiceDate: '2026-07-01',
    dueDate: '2026-07-20',
  });
  await makeInvoice(w, {
    unit: d!,
    billTo: o(d!),
    totalPaise: 900_000,
    periodStart: '2026-09-01',
    dueDate: '2026-07-20',
    invoiceDate: '2026-07-01',
    isDisputed: true,
  });
  await makeInvoice(w, {
    unit: a!,
    billTo: o(a!),
    totalPaise: 250_000,
    periodStart: '2026-10-01',
    invoiceDate: '2026-10-01',
    dueDate: '2026-10-10',
    headKey: 'WATER',
  });
  return w;
}

describe('billingReports (8.25, T11-56)', () => {
  it('summary equals GET /billing/summary', async () => {
    const w = await seeded();
    const api = (await w.c('get', '/billing/summary?month=2026-11')).body.data;
    const { month: _m, ...rest } = api;
    expect(await billingReports.summary(w.society.id!, '2026-11')).toEqual(rest);
  });

  it('defaulters rows and totals equal GET /billing/defaulters (plus the unmasked mobile)', async () => {
    const w = await seeded();
    const api = (await w.c('get', '/billing/defaulters?minDaysOverdue=30&minAmountPaise=0')).body.data;
    const r = await billingReports.defaulters(w.society.id!, {
      ...list,
      minDaysOverdue: 30,
      minAmountPaise: 0,
      sortBy: 'overduePaise',
    });
    expect(r.totals).toEqual(api.totals);
    expect(r.rows.map(({ ownerMobile: _m, ...x }) => x)).toEqual(api.items);
    expect(r.rows.every(x => typeof x.ownerMobile === 'string')).toBe(true);
    expect(r.rows.map(x => x.unitLabel)).not.toContain('A-104'); // disputed
  });

  it('ageingByUnit: totals minus module 12 advances equal the sum of the ledger balances; buckets equal summary().ageing', async () => {
    const w = await seeded();
    const advances: Record<number, number> = { [w.units[1]!.id]: 150_000 };
    setBillingPorts({ payments: { advanceBalance: async (_s: number, u: number) => advances[u] ?? 0 } });
    // the advance is a ledger credit of module 12
    await sequelize.transaction(t =>
      unitLedger.post(
        ctxOf(w, 1),
        {
          unitId: w.units[1]!.id,
          entryType: 'PAYMENT',
          refType: 'payment',
          refId: 1,
          debitPaise: 0,
          creditPaise: 150_000,
          date: '2026-11-03',
          narration: 'Receipt',
        },
        t,
      ),
    );
    const ag = await billingReports.ageingByUnit(w.society.id!, '2026-11-04', {
      ...list,
      sortBy: 'totalPaise',
    });
    let ledger = 0;
    for (const u of w.units) ledger += await unitLedger.balance(w.society.id!, u.id);
    const adv = Object.values(advances).reduce((x, y) => x + y, 0);
    expect(ag.totals.totalPaise - adv).toBe(ledger);
    const summary = await billingReports.summary(w.society.id!, '2026-11');
    expect([
      ag.totals.d1_30Paise,
      ag.totals.d31_60Paise,
      ag.totals.d61_90Paise,
      ag.totals.d91PlusPaise,
    ]).toEqual(summary.ageing.map(b => b.amountPaise));
    expect(ag.totals.disputedPaise).toBe(900_000);
    const c = ag.rows.find(r => r.unitId === w.units[2]!.id)!;
    expect(c).toMatchObject({
      unitLabel: 'A-103',
      ownerName: 'Owner A-103',
      d91PlusPaise: 700_000,
      totalPaise: 700_000,
    });
    expect(ag.rows.find(r => r.unitId === w.units[1]!.id)!.notDuePaise).toBe(400_000);
    expect(ag.total).toBe(4);
  });

  it('ageingByUnit for an earlier day rebuilds the outstanding from the dated allocations', async () => {
    const w = await duesWorld(1);
    const inv = await makeInvoice(w, {
      unit: w.units[0]!,
      billTo: w.owners['A-101']!,
      totalPaise: 800_000,
      dueDate: '2026-09-10',
      paidPaise: 800_000,
      settledOn: '2026-10-15',
    });
    setBillingPorts({
      payments: {
        listAllocationsForInvoice: async () => [{ allocatedOn: '2026-10-15', amountPaise: 800_000 }],
      },
    });
    const before = await billingReports.ageingByUnit(w.society.id!, '2026-10-01', {
      ...list,
      sortBy: 'unitLabel',
    });
    expect(before.totals).toMatchObject({ d1_30Paise: 800_000, totalPaise: 800_000 });
    const after = await billingReports.ageingByUnit(w.society.id!, '2026-10-20', {
      ...list,
      sortBy: 'unitLabel',
    });
    expect(after.rows).toEqual([]);
    expect(inv.id).toBeTruthy();
  });

  it('collectionSummary by month equals summary(); by building and by charge head add up to the same totals', async () => {
    const w = await seeded();
    const summary = await billingReports.summary(w.society.id!, '2026-11');
    const base = {
      ...list,
      from: '2026-11-01',
      to: '2026-11-30',
      sortBy: 'group' as const,
      sortDir: 'asc' as const,
    };
    const month = await billingReports.collectionSummary(w.society.id!, { ...base, groupBy: 'month' });
    expect(month.totals.billedPaise).toBe(summary.billedPaise);
    expect(month.totals.collectedPaise).toBe(summary.collectedPaise);
    expect(month.rows).toEqual([
      {
        group: '2026-11',
        billedPaise: 1_700_000,
        collectedPaise: 600_000,
        efficiencyPct: '35.3',
        outstandingPaise: 1_100_000,
      },
    ]);
    const wide = { ...base, from: '2026-09-01', to: '2026-11-30' };
    const m3 = await billingReports.collectionSummary(w.society.id!, { ...wide, groupBy: 'month' });
    for (const g of ['building', 'chargeHead'] as const) {
      const r = await billingReports.collectionSummary(w.society.id!, { ...wide, groupBy: g });
      expect(r.totals).toEqual(m3.totals);
    }
    const heads = await billingReports.collectionSummary(w.society.id!, { ...wide, groupBy: 'chargeHead' });
    expect(heads.rows.map(r => r.group)).toEqual(['MAINTENANCE', 'WATER']);
    expect(heads.rows[1]!.billedPaise).toBe(250_000);
    await expect(
      billingReports.collectionSummary(w.society.id!, {
        ...base,
        from: '2024-01-01',
        to: '2026-11-30',
        groupBy: 'month',
      }),
    ).rejects.toThrow(/731/);
  });

  it('paymentBehaviour: flats with at least 2 invoices, payment counts and returned cheques from module 12', async () => {
    const w = await duesWorld(2);
    const [a, b] = w.units as DuesWorld['units'];
    for (const m of ['07', '08', '09'])
      await makeInvoice(w, {
        unit: a!,
        billTo: w.owners['A-101']!,
        dueDate: `2026-${m}-10`,
        periodStart: `2026-${m}-01`,
        invoiceDate: `2026-${m}-01`,
        paidPaise: m === '09' ? 0 : 800_000,
        settledOn: m === '09' ? null : `2026-${m}-12`,
      });
    await makeInvoice(w, { unit: b!, billTo: w.owners['A-102']!, dueDate: '2026-09-10' });
    setBillingPorts({
      payments: {
        listAllocationsForInvoice: async () => [{ allocatedOn: '2026-09-12', amountPaise: 100 }],
        chequeReturnCount: async (_s: number, u: number) => (u === a!.id ? 2 : 0),
      },
    });
    const r = await billingReports.paymentBehaviour(w.society.id!, '2026-11-04');
    expect(r.total).toBe(1);
    expect(r.rows[0]).toMatchObject({ unitId: a!.id, chequeReturns12m: 2 });
    expect(r.rows[0]!.invoices).toHaveLength(3);
    expect(r.rows[0]!.invoices[0]).toMatchObject({
      outstandingPaise: 800_000,
      settledOn: null,
      paymentCount: 1,
    });
    expect(JSON.stringify(r)).not.toContain('Owner');
  });

  it('T11-57 a slow read is aborted with ReadTimeoutError; another society id returns nothing', async () => {
    const w = await seeded();
    await expect(
      readRows(
        'SELECT COUNT(*) AS n FROM information_schema.columns a, information_schema.columns b, information_schema.columns c',
        {},
        { deadlineMs: 20 },
      ),
    ).rejects.toBeInstanceOf(ReadTimeoutError);
    const other = w.society.id! + 987_654;
    expect((await billingReports.summary(other, '2026-11')).billedPaise).toBe(0);
    expect(
      (
        await billingReports.defaulters(other, {
          ...list,
          minDaysOverdue: 1,
          minAmountPaise: 0,
          sortBy: 'overduePaise',
        })
      ).rows,
    ).toEqual([]);
    expect(
      (await billingReports.ageingByUnit(other, '2026-11-04', { ...list, sortBy: 'totalPaise' })).rows,
    ).toEqual([]);
    expect((await billingReports.paymentBehaviour(other, '2026-11-04')).rows).toEqual([]);
  });
});

describe('reportsCache.touch (8.26, T11-58)', () => {
  it('an issue run touches (societyId, dues) once per committed batch, after commit', async () => {
    const w = await duesWorld(2);
    await standardRules(w.society.id!, w.heads, []);
    const run = await createAndCompute(w.c);
    const d = (await w.c('get', `/billing/runs/${run.id}`)).body.data;
    const p = await w.c(
      'post',
      `/billing/runs/${run.id}/publish`,
      { confirmLabel: d.runLabel, version: d.version },
      { headers: idemH() },
    );
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(billingPortCalls.filter(c => c.fn === 'reports.touch')).toHaveLength(0);
    await approve(p.body.data.approvalRequestId, ctxOf(w, w.treasurer.user.id!));
    await drainQueues();
    const touches = billingPortCalls.filter(c => c.fn === 'reports.touch');
    expect(touches.length).toBeGreaterThanOrEqual(1);
    expect(touches.length).toBeLessThanOrEqual(2);
    expect(touches[0]!.input).toEqual({ societyId: w.society.id!, area: 'dues' });
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(w.units.length);
  });
});

describe('billing:reconcile (BR-11-7, T11-37)', () => {
  it('is clean on consistent data and reports ledger differences and number gaps', async () => {
    const w = await seeded();
    expect(await reconcileSociety(w.society.id!)).toEqual([]);
    expect(await runReconcileAll()).toEqual({});
    await sequelize.transaction(t =>
      unitLedger.post(
        ctxOf(w, 1),
        {
          unitId: w.units[0]!.id,
          entryType: 'ADJUSTMENT',
          refType: 'opening_balance',
          refId: 7,
          debitPaise: 0,
          creditPaise: 5_000,
          date: '2026-11-03',
          narration: 'Odd',
        },
        t,
      ),
    );
    const m = await reconcileSociety(w.society.id!);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'LEDGER_BALANCE', ref: `unit ${w.units[0]!.id}` });
    await expect(runReconcileAll()).rejects.toThrow(/billing:reconcile found 1 mismatches/);
  });

  it('finds a missing invoice number in a series', async () => {
    const w = await duesWorld(3);
    for (const u of w.units) await makeInvoice(w, { unit: u, billTo: w.owners[u.label]! });
    const rows = await Invoice.findAll({ where: { societyId: w.society.id! }, order: [['id', 'ASC']] });
    const nos = ['000001', '000002', '000004'];
    for (const [i, r] of rows.entries())
      await sequelize.query('UPDATE invoices SET invoiceNo = :no WHERE id = :id', {
        replacements: { no: `INV/2026-27/${nos[i]}`, id: r.id! },
      });
    const m = await reconcileSociety(w.society.id!);
    expect(m.find(x => x.kind === 'NUMBER_GAP')).toMatchObject({ ref: 'INV 2026-27', detail: 'missing 3' });
    expect(gapsOf([1, 2, 5, 9])).toEqual([3, 4, 6, 7, 8]);
  });
});
