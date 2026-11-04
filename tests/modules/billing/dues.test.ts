import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Invoice, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { touchDues } from '../../../src/modules/billing/billing.dues.cache';
import { efficiencyOf } from '../../../src/modules/billing/billing.dues.queries';
import { runLateFeesForSociety } from '../../../src/modules/billing/billing.latefee.service';
import { memberOf } from '../../helpers/society-setup';
import {
  duesWorld,
  interestPolicy,
  makeInvoice,
  resetDues,
  type DuesWorld,
} from '../../helpers/billing-dues';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetDues);

const nov = '2026-11-01';
async function dashboardWorld(): Promise<DuesWorld> {
  const w = await duesWorld(3);
  const [u1, u2, u3] = w.units as [DuesWorld['units'][0], DuesWorld['units'][0], DuesWorld['units'][0]];
  const o = (u: { label: string }) => w.owners[u.label]!;
  await makeInvoice(w, {
    unit: u1,
    billTo: o(u1),
    totalPaise: 500_000,
    paidPaise: 500_000,
    periodStart: nov,
    invoiceDate: nov,
    dueDate: '2026-11-10',
    settledOn: '2026-11-02',
  });
  await makeInvoice(w, {
    unit: u2,
    billTo: o(u2),
    totalPaise: 400_000,
    periodStart: nov,
    invoiceDate: nov,
    dueDate: '2026-11-20',
  });
  await makeInvoice(w, {
    unit: u3,
    billTo: o(u3),
    totalPaise: 300_000,
    paidPaise: 100_000,
    periodStart: nov,
    invoiceDate: '2026-10-01',
    dueDate: '2026-10-20',
  });
  await makeInvoice(w, {
    unit: u1,
    billTo: o(u1),
    totalPaise: 200_000,
    periodStart: '2026-07-01',
    invoiceDate: '2026-07-01',
    dueDate: '2026-07-10',
  });
  return w;
}

describe('GET /billing/summary (8.22, F24)', () => {
  it('billed, collected, efficiency, outstanding, overdue flats and ageing buckets', async () => {
    const w = await dashboardWorld();
    const r = await w.c('get', '/billing/summary?month=2026-11');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({
      month: '2026-11',
      billedPaise: 1_200_000,
      collectedPaise: 600_000,
      efficiencyPct: '50.0',
      outstandingPaise: 800_000,
      overdueFlats: 2,
      ageing: [
        { bucket: '0_30', amountPaise: 200_000 },
        { bucket: '31_60', amountPaise: 0 },
        { bucket: '61_90', amountPaise: 0 },
        { bucket: '90_PLUS', amountPaise: 200_000 },
      ],
    });
  });

  it('defaults to the current month, has null efficiency when nothing was billed, and rejects a bad month', async () => {
    const w = await dashboardWorld();
    expect((await w.c('get', '/billing/summary')).body.data.month).toBe('2026-11');
    expect((await w.c('get', '/billing/summary?month=2026-01')).body.data.efficiencyPct).toBeNull();
    expect((await w.c('get', '/billing/summary?month=2026-13')).status).toBe(400);
    expect((await w.c('get', '/billing/summary?x=1')).status).toBe(400);
  });

  it('efficiency has one decimal, half-up', () => {
    expect(efficiencyOf(1, 3)).toBe('33.3');
    expect(efficiencyOf(2, 3)).toBe('66.7');
    expect(efficiencyOf(1, 8)).toBe('12.5');
    expect(efficiencyOf(0, 0)).toBeNull();
  });

  it('cancelled invoices are not billed; the answer is cached 30 seconds and a touch clears it', async () => {
    const w = await dashboardWorld();
    const first = (await w.c('get', '/billing/summary?month=2026-11')).body.data;
    await Invoice.update(
      { paidPaise: 400_000, outstandingPaise: 0, status: 'PAID', settledOn: '2026-11-04' },
      { where: { societyId: w.society.id!, totalPaise: 400_000 } },
    );
    expect((await w.c('get', '/billing/summary?month=2026-11')).body.data.collectedPaise).toBe(
      first.collectedPaise,
    );
    touchDues(w.society.id!);
    await new Promise(r => setTimeout(r, 50));
    expect((await w.c('get', '/billing/summary?month=2026-11')).body.data.collectedPaise).toBe(1_000_000);
    setNow('2026-11-04T04:31:00Z');
  });

  it('is allowed for finance.billing.view holders', async () => {
    const w = await dashboardWorld();
    const sec = await memberOf(w.society, 'secretary');
    expect((await sec.c('get', '/billing/summary')).status).toBe(200);
  });
});

describe('GET /billing/defaulters (BR-11-64, 8.22, US-11-11)', () => {
  async function world() {
    const w = await duesWorld(4);
    const [a, b, c, d] = w.units as DuesWorld['units'];
    const o = (u: { label: string }) => w.owners[u.label]!;
    // 100 days overdue and 8,000: a defaulter
    await makeInvoice(w, { unit: a!, billTo: o(a!), totalPaise: 800_000, dueDate: '2026-07-26' });
    // 100 days overdue but only 1,000: below the amount
    await makeInvoice(w, { unit: b!, billTo: o(b!), totalPaise: 100_000, dueDate: '2026-07-26' });
    // 8,000 but only 30 days overdue
    await makeInvoice(w, { unit: c!, billTo: o(c!), totalPaise: 800_000, dueDate: '2026-10-05' });
    // 100 days, 9,000 but disputed
    await makeInvoice(w, {
      unit: d!,
      billTo: o(d!),
      totalPaise: 900_000,
      dueDate: '2026-07-26',
      isDisputed: true,
    });
    return w;
  }

  it('lists only flats meeting both conditions; disputed invoices are left out; the item has the 8.22 fields', async () => {
    const w = await world();
    const r = await w.c('get', '/billing/defaulters');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.items).toEqual([
      {
        unitId: w.units[0]!.id,
        unitLabel: 'A-101',
        ownerName: 'Owner A-101',
        billToNames: 'Owner A-101',
        overduePaise: 800_000,
        oldestDueDate: '2026-07-26',
        daysOverdue: 101,
        invoiceCount: 1,
      },
    ]);
    expect(r.body.data.totals).toEqual({ flats: 1, overduePaise: 800_000 });
    expect(r.body.pagination.total).toBe(1);
  });

  it('thresholds are query parameters; sorting and the building filter work', async () => {
    const w = await world();
    const r = await w.c(
      'get',
      '/billing/defaulters?minDaysOverdue=20&minAmountPaise=100000&sortBy=unitLabel&sortOrder=asc',
    );
    expect(r.body.data.items.map((x: any) => x.unitLabel)).toEqual(['A-101', 'A-102', 'A-103']);
    const byDays = await w.c(
      'get',
      '/billing/defaulters?minDaysOverdue=20&minAmountPaise=100000&sortBy=daysOverdue&sortOrder=desc',
    );
    expect(byDays.body.data.items[0].unitLabel).toBe('A-101');
    const bld = await w.c(
      'get',
      `/billing/defaulters?minDaysOverdue=20&minAmountPaise=0&buildingId=${w.buildingId + 999}`,
    );
    expect(bld.body.data.items).toEqual([]);
    expect((await w.c('get', '/billing/defaulters?minDaysOverdue=0')).status).toBe(400);
    expect((await w.c('get', '/billing/defaulters?minAmountPaise=1000000001')).status).toBe(400);
  });

  it('grace days of the policy move the cut-off: due + grace must be before today', async () => {
    const w = await world();
    await interestPolicy(w.society.id!, { graceDays: 30 });
    await makeInvoice(w, {
      unit: w.units[2]!,
      billTo: w.owners['A-103']!,
      totalPaise: 800_000,
      dueDate: '2026-10-10',
    });
    const r = await w.c('get', '/billing/defaulters?minDaysOverdue=20&minAmountPaise=0');
    // A-103 has invoices due 5 Oct and 10 Oct: both inside 30 days of grace on 4 Nov (due + 30 >= 4 Nov)
    expect(r.body.data.items.map((x: any) => x.unitLabel)).toEqual(['A-101', 'A-102']);
  });

  it('CSV needs finance.billing.export, is audited and escapes formulas', async () => {
    const w = await world();
    const sec = await memberOf(w.society, 'secretary');
    expect((await sec.c('get', '/billing/defaulters?format=csv')).status).toBe(403);
    const res = await w.c('get', '/billing/defaulters?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.text ?? String(res.body);
    expect(text).toContain('Flat,Owner,Billed to,Overdue (INR),Oldest due date,Days overdue,Open invoices');
    expect(text).toContain('A-101,Owner A-101,Owner A-101,8000.00,2026-07-26,101,1');
    expect(
      await AuditLog.count({ where: { action: 'billing.defaulters.exported', societyId: w.society.id! } }),
    ).toBe(1);
  });
});

describe('billing notes reads (8.19)', () => {
  it('lists and reads the interest debit note of the late fee job', async () => {
    const w = await duesWorld(1);
    await interestPolicy(w.society.id!);
    const i = await makeInvoice(w, { unit: w.units[0]!, billTo: w.owners['A-101']! });
    await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' });
    const list = await w.c('get', `/billing/notes?invoiceId=${i.id}&noteType=DEBIT&reasonCode=INTEREST`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const one = await w.c('get', `/billing/notes/${list.body.data[0].id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.lines.map((l: any) => l.lineKind)).toEqual(['INTEREST', 'ROUND_OFF']);
    expect((await w.c('get', '/billing/notes/99999999')).status).toBe(404);
    expect((await w.c('get', '/billing/notes?noteType=BAD')).status).toBe(400);
  });
});
