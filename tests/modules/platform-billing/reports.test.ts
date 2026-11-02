import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  PlatformCredit,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  Society,
  SocietyLifecycleEvent,
  closeDb,
  sequelize,
} from '../../../src/models';
import type { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { runDunning } from '../../../src/modules/platform-billing/platform-billing.dunning';
import { platformBilling } from '../../../src/modules/platform-billing/platform-billing.public';
import { clearRevenueCache } from '../../../src/modules/platform-billing/platform-billing.reports';
import { makeSociety } from '../../helpers/access';
import { platformAs } from '../../helpers/societies';
import { billedSociety, idemKey, platformTeam, resetBilling } from '../../helpers/billing';

/** Task 6.4: approvals queue (8.24), dunning list (8.25), revenue (8.26, T06-39), GST summary and TDS receivable (8.27). */
let gw: FakePaymentGateway;
beforeEach(async () => {
  gw = (await resetBilling()) as FakePaymentGateway;
  await clearRevenueCache();
});
afterAll(async () => {
  await drainQueues();
  setNow(null);
  await closeDb();
});

// ------------------------------------------------------------------ revenue fixture
let seq = 0;
interface InvOpts {
  periodStart?: string;
  periodEnd?: string;
  cycle?: 'MONTHLY' | 'ANNUAL';
  plan?: string;
  kind?: 'PERIOD' | 'MANUAL';
  lines?: [string, number][];
  subtotal?: number;
  tax?: number;
  issueDate?: string;
  dueDate?: string;
  amountDue?: number;
  status?: string;
}
async function fixtureInvoice(societyId: number, o: InvOpts) {
  seq += 1;
  const lines = o.lines ?? [];
  const subtotal = o.subtotal ?? lines.reduce((a, [, v]) => a + v, 0);
  const tax = o.tax ?? 0;
  const issueDate = o.issueDate ?? o.periodStart!;
  const inv = await PlatformInvoice.create({
    societyId,
    documentType: 'INVOICE',
    invoiceKind: o.kind ?? 'PERIOD',
    invoiceNo: `FIX/2026-27/${String(seq).padStart(6, '0')}`,
    financialYear: '2026-27',
    status: o.status ?? 'PAID',
    issueDate,
    dueDate: o.dueDate ?? issueDate,
    suspendOn: o.dueDate ?? issueDate,
    periodStart: o.periodStart ?? null,
    periodEnd: o.periodEnd ?? null,
    planKey: o.plan ?? null,
    billingCycle: o.periodStart ? (o.cycle ?? 'MONTHLY') : null,
    billingName: 'Fixture CHS',
    billingAddress: 'Baner Road, Pune',
    billingStateName: 'Maharashtra',
    placeOfSupplyStateCode: '27',
    taxType: 'INTRA_STATE',
    gstRatePct: '18.0000',
    sacCode: '998314',
    subtotalPaise: subtotal,
    cgstPaise: tax / 2,
    sgstPaise: tax / 2,
    igstPaise: 0,
    taxPaise: tax,
    totalPaise: subtotal + tax,
    amountDuePaise: o.amountDue ?? 0,
    pdfStatus: 'PENDING',
    version: 1,
  } as never);
  let n = 0;
  for (const [type, amount] of lines)
    await PlatformInvoiceLine.create({
      societyId,
      invoiceId: inv.id!,
      lineNo: (n += 1),
      lineType: type,
      description: `${type} line`,
      sacCode: '998314',
      quantity: '1',
      unitPricePaise: amount,
      amountPaise: amount,
    } as never);
  return inv;
}
const lifecycle = (societyId: number, toStatus: string, at: string) =>
  SocietyLifecycleEvent.create({
    societyId,
    eventType: 'STATUS_CHANGED',
    fromStatus: null,
    toStatus,
    triggerSource: 'SYSTEM_JOB',
    triggerCode: 'ACCOUNT_CLEARED',
    actorName: 'System',
    createdAt: new Date(`${at}T00:00:00Z`),
  } as never);

/** Seven societies; the October movements are worked out in the test. */
async function revenueFixture() {
  const mk = async (name: string) => (await makeSociety(name)).id!;
  const [a, b, c, d, e, f, g] = [
    await mk('Alpha CHS'),
    await mk('Beta CHS'),
    await mk('Gamma CHS'),
    await mk('Delta CHS'),
    await mk('Epsilon CHS'),
    await mk('Zeta CHS'),
    await mk('Eta CHS'),
  ] as [number, number, number, number, number, number, number];
  for (const id of [a, b, c, d, e]) await lifecycle(id, 'ACTIVE', '2026-08-01');
  await lifecycle(f, 'ACTIVE', '2026-08-01');
  await lifecycle(f, 'SUSPENDED', '2026-10-15'); // not paying on 31 October
  await lifecycle(g, 'PAST_DUE', '2026-08-01'); // past due still counts
  const m = (s: string, e2: string) => ({ periodStart: s, periodEnd: e2 });
  await fixtureInvoice(a, {
    ...m('2026-09-01', '2026-09-30'),
    plan: 'PREMIUM',
    lines: [['PLAN', 1_000_000]],
  });
  await fixtureInvoice(a, {
    ...m('2026-10-01', '2026-10-31'),
    plan: 'PREMIUM',
    lines: [
      ['PLAN', 1_150_000],
      ['ADDON', 50_000],
      ['OVERAGE', 99_999],
    ],
    subtotal: 1_299_999,
    tax: 233_998 + 0, // 2 × 116,999 (CGST = SGST)
  });
  await fixtureInvoice(b, { ...m('2026-09-01', '2026-09-30'), plan: 'STANDARD', lines: [['PLAN', 500_000]] });
  await fixtureInvoice(c, { ...m('2026-10-01', '2026-10-31'), plan: 'STANDARD', lines: [['PLAN', 300_000]] });
  await fixtureInvoice(d, {
    ...m('2026-04-01', '2027-03-31'),
    cycle: 'ANNUAL',
    plan: 'PREMIUM',
    lines: [
      ['PLAN', 16_080_000],
      ['DISCOUNT', -2_680_000],
    ],
  }); // 13,400,000 / 12 = 1,116,666.67 -> 1,116,667
  await fixtureInvoice(e, { ...m('2026-09-01', '2026-09-30'), plan: 'PREMIUM', lines: [['PLAN', 400_000]] });
  await fixtureInvoice(e, { ...m('2026-10-01', '2026-10-31'), plan: 'PREMIUM', lines: [['PLAN', 350_000]] });
  await fixtureInvoice(f, { ...m('2026-10-01', '2026-10-31'), plan: 'STANDARD', lines: [['PLAN', 700_000]] });
  await fixtureInvoice(g, { ...m('2026-10-01', '2026-10-31'), plan: 'STANDARD', lines: [['PLAN', 100_000]] });
  // a VOID invoice never counts
  await fixtureInvoice(b, {
    ...m('2026-10-01', '2026-10-31'),
    plan: 'STANDARD',
    lines: [['PLAN', 999_999]],
    status: 'VOID',
  });
  // open balances for the ageing, as of 31 October
  const open = (due: string, amountDue: number) =>
    fixtureInvoice(a, {
      kind: 'MANUAL',
      subtotal: amountDue,
      issueDate: '2026-07-15',
      dueDate: due,
      amountDue,
      status: 'ISSUED',
    });
  await open('2026-10-20', 200_000); // 11 days late
  await open('2026-11-10', 50_000); // not due
  await open('2026-09-01', 70_000); // 60 days late
  await open('2026-08-01', 30_000); // 91 days late
  await PlatformPayment.create({
    societyId: a,
    kind: 'PAYMENT',
    origin: 'SOCIETY',
    status: 'CAPTURED',
    method: 'UPI',
    amountPaise: 123_456,
    appliedPaise: 0,
    capturedAt: new Date('2026-10-15T06:00:00Z'),
    version: 1,
  } as never);
  const credit = (societyId: number, amountPaise: number, balanceAfterPaise: number, at: string) =>
    PlatformCredit.create({
      societyId,
      entryType: 'PAYMENT_EXCESS',
      status: 'POSTED',
      amountPaise,
      balanceAfterPaise,
      postedAt: new Date(at),
      version: 1,
    } as never);
  await credit(a, 5_000, 5_000, '2026-10-01T00:00:00Z');
  await credit(a, 3_000, 8_000, '2026-10-02T00:00:00Z'); // only the latest row counts
  await credit(b, 3_000, 3_000, '2026-10-03T00:00:00Z');
  return { a, b, c, d, e, f, g };
}

describe('revenue (8.26, BR-06-45, BR-06-46, T06-39)', () => {
  it('T06-39 the October movements add up and every figure matches the fixture', async () => {
    const t = await platformTeam();
    const fx = await revenueFixture();
    const r = await t.checker.c('get', '/platform/billing/revenue?asOf=2026-10-31&months=2');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    // MRR on 31 October: Alpha 1,200,000 (PLAN + ADDON, no OVERAGE), Gamma 300,000, Delta 1,116,667, Epsilon 350,000, Eta 100,000
    expect(d.mrrPaise).toBe(3_066_667);
    expect(d.arrPaise).toBe(36_800_004);
    expect(d.payingSocieties).toBe(5);
    expect(d.asOf).toBe('2026-10-31');
    expect(d.mrrByPlan).toEqual([
      { planKey: 'PREMIUM', mrrPaise: 2_666_667 },
      { planKey: 'STANDARD', mrrPaise: 400_000 },
    ]);
    const oct = d.series[1];
    expect(oct).toEqual({
      month: '2026-10',
      startMrrPaise: 3_016_667, // Alpha 1,000,000 + Beta 500,000 + Delta 1,116,667 + Epsilon 400,000
      newPaise: 400_000, // Gamma 300,000, Eta 100,000
      expansionPaise: 200_000, // Alpha
      contractionPaise: 50_000, // Epsilon
      churnedPaise: 500_000, // Beta has no October invoice
      endMrrPaise: 3_066_667,
      logoChurnPct: '25.00', // 1 of 4
      revenueChurnPct: '18.23', // (500,000 + 50,000) / 3,016,667
    });
    expect(
      oct.startMrrPaise + oct.newPaise + oct.expansionPaise - oct.contractionPaise - oct.churnedPaise,
    ).toBe(oct.endMrrPaise);
    expect(d.series[0]).toMatchObject({ month: '2026-09', endMrrPaise: 3_016_667, startMrrPaise: 1_116_667 });
    // every October invoice, the VOID one included (a credit note would offset it)
    expect(d.billedThisMonthPaise).toBe(
      1_299_999 + 233_998 + 300_000 + 350_000 + 700_000 + 100_000 + 999_999,
    );
    expect(d.gstThisMonthPaise).toBe(233_998);
    expect(d.collectedThisMonthPaise).toBe(123_456);
    expect(d.outstandingPaise).toBe(350_000);
    expect(d.overduePaise).toBe(300_000);
    expect(d.ageing).toEqual({
      notDuePaise: 50_000,
      d1to15Paise: 200_000,
      d16to30Paise: 0,
      d31to60Paise: 70_000,
      over60Paise: 30_000,
    });
    expect(d.creditBalancesPaise).toBe(11_000);
    expect(
      d.topSocieties.map((s: { societyId: number; mrrPaise: number }) => [s.societyId, s.mrrPaise]),
    ).toEqual([
      [fx.a, 1_200_000],
      [fx.d, 1_116_667],
      [fx.e, 350_000],
      [fx.c, 300_000],
      [fx.g, 100_000],
    ]);
    expect(d.topSocieties[0].name).toBe('Alpha CHS');
    expect(d.series[1].month).toBe('2026-10');
    // the revenue answer is cached for ten minutes per (asOf, months)
    await PlatformInvoice.update({ status: 'VOID' } as never, {
      where: { societyId: fx.a, invoiceKind: 'PERIOD' },
    }).catch(() => undefined);
    expect(
      (await t.checker.c('get', '/platform/billing/revenue?asOf=2026-10-31&months=2')).body.data.mrrPaise,
    ).toBe(3_066_667);
  });

  it('the same numbers back getMrrSummary and getMrrSeries (9.3)', async () => {
    await revenueFixture();
    const s = await platformBilling.getMrrSummary({
      asOf: new Date('2026-10-31T10:00:00Z'),
      comparedTo: new Date('2026-09-30T10:00:00Z'),
    });
    expect(s).toEqual({ mrrPaise: 3_066_667, previousMrrPaise: 3_016_667, netChangePaise: 50_000 });
    const day = await platformBilling.getMrrSeries({ from: '2026-09-29', to: '2026-10-02', bucket: 'DAY' });
    expect(day.labels).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(day.mrrPaise).toEqual([3_016_667, 3_016_667, 3_766_667, 3_766_667]);
    // weeks start on Monday; the last bucket is capped at `to`
    const week = await platformBilling.getMrrSeries({ from: '2026-10-01', to: '2026-10-31', bucket: 'WEEK' });
    expect(week.labels).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(week.mrrPaise).toHaveLength(5);
    expect(week.mrrPaise[0]).toBe(3_766_667); // the week of 28 Sep ends on 4 Oct: Zeta is still active until 15 Oct
    expect(week.mrrPaise[4]).toBe(3_066_667);
  });

  it('validates the query; Platform Support can read; a society user is refused', async () => {
    const t = await platformTeam();
    const s = await billedSociety();
    expect((await t.support.c('get', '/platform/billing/revenue')).status).toBe(200);
    expect((await t.support.c('get', '/platform/billing/revenue?months=25')).body.code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await t.support.c('get', '/platform/billing/revenue?months=0')).status).toBe(400);
    expect((await t.support.c('get', '/platform/billing/revenue?asOf=2026-13-40')).status).toBe(400);
    const empty = (await t.support.c('get', '/platform/billing/revenue?months=3')).body.data;
    expect(empty.series).toHaveLength(3);
    expect(empty.asOf).toBe('2026-11-01');
    expect((await s.view('get', '/platform/billing/revenue')).status).toBe(403);
  });
});

// ------------------------------------------------------------------ approvals queue
describe('approvals queue (8.24)', () => {
  it('lists every type with version and canApprove, filters by type, sorts and pages', async () => {
    const { society, invoice, pay, maker, checker, support } = {
      ...(await billedSociety()),
      ...(await platformTeam()),
    };
    const id = society.id!;
    // MANUAL_PAYMENT
    await maker.c(
      'post',
      '/platform/payments',
      {
        societyId: id,
        invoiceId: invoice.id,
        method: 'NEFT',
        amountPaise: 500000,
        receivedOn: '2026-10-30',
        bankReference: 'UTR000011112222',
      },
      { headers: idemKey() },
    );
    // MANUAL_INVOICE and CREDIT_NOTE
    await maker.c(
      'post',
      '/platform/invoices',
      { societyId: id, lines: [{ description: 'Setup assistance', quantity: '1', unitPricePaise: 50000 }] },
      { headers: idemKey() },
    );
    await maker.c(
      'post',
      `/platform/invoices/${invoice.id}/credit-notes`,
      { reason: 'PRICE_CORRECTION', subtotalPaise: 100000, notes: 'Price corrected for October' },
      { headers: idemKey() },
    );
    // GOODWILL_CREDIT, then an approved one that funds a REFUND request
    const g1 = await maker.c(
      'post',
      `/platform/societies/${id}/credits`,
      { amountPaise: 20000, reason: 'Outage compensation for October' },
      { headers: idemKey() },
    );
    const g2 = await maker.c(
      'post',
      `/platform/societies/${id}/credits`,
      { amountPaise: 10000, reason: 'Second compensation to refund' },
      { headers: idemKey() },
    );
    expect(g1.status, JSON.stringify(g1.body)).toBe(201);
    // approving a goodwill credit applies it to the open invoice, so fund the refund with a society that has no invoice
    await checker.c('post', `/platform/credits/${g2.body.data.id}/approve`, { version: 1 });
    // WRITE_OFF
    await maker.c('post', `/platform/invoices/${invoice.id}/write-off`, {
      reason: 'Society dissolved; amount is uncollectable',
      version: (await PlatformInvoice.findByPk(invoice.id))!.version,
    });
    // PAYMENT_MISMATCH
    const o = (
      await pay(
        'post',
        `/subscription/invoices/${invoice.id}/payment-orders`,
        { amountPaise: 100000 },
        { headers: idemKey() },
      )
    ).body.data;
    const p = gw.payOrder(o.gatewayOrderId, { amountPaise: 99900 });
    const v = await pay('post', `/subscription/payments/${o.paymentId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect([v.status, v.body.code]).toEqual([422, 'PAYMENT_MISMATCH']);

    const all = await checker.c('get', '/platform/billing/approvals?limit=100');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const types = all.body.data.map((x: { type: string }) => x.type);
    expect([...new Set(types)].sort()).toEqual(
      [
        'CREDIT_NOTE',
        'GOODWILL_CREDIT',
        'MANUAL_INVOICE',
        'MANUAL_PAYMENT',
        'PAYMENT_MISMATCH',
        'WRITE_OFF',
      ].sort(),
    );
    for (const it of all.body.data)
      expect(it).toEqual(
        expect.objectContaining({
          type: expect.any(String),
          id: expect.any(Number),
          societyId: id,
          societyName: society.name,
          amountPaise: expect.any(Number),
          createdBy: { id: expect.any(Number), name: expect.any(String) },
          createdAt: expect.any(String),
          version: expect.any(Number),
          canApprove: expect.any(Boolean),
        }),
      );
    const one = (t: string) => all.body.data.find((x: { type: string }) => x.type === t);
    expect(one('MANUAL_PAYMENT')).toMatchObject({
      amountPaise: 500000,
      version: 1,
      canApprove: true,
      createdBy: { name: 'Maker Admin' },
    });
    expect(one('PAYMENT_MISMATCH')).toMatchObject({
      id: o.paymentId,
      amountPaise: 100000,
      gatewayAmountPaise: 99900,
      canApprove: false,
    });
    expect(one('GOODWILL_CREDIT')).toMatchObject({ id: g1.body.data.id, amountPaise: 20000, version: 1 });
    expect(one('WRITE_OFF')).toMatchObject({ id: invoice.id, amountPaise: 1229000, canApprove: true });
    const mine = await maker.c('get', '/platform/billing/approvals?limit=100');
    expect(
      mine.body.data.filter(
        (x: { type: string; canApprove: boolean }) => x.type !== 'PAYMENT_MISMATCH' && x.canApprove,
      ),
    ).toEqual([]);

    // filter, order and paging
    const f = await checker.c('get', '/platform/billing/approvals?type=MANUAL_INVOICE');
    expect(f.body.data.map((x: { type: string }) => x.type)).toEqual(['MANUAL_INVOICE']);
    const asc = (await checker.c('get', '/platform/billing/approvals?limit=100&sortOrder=asc')).body.data;
    const desc = (await checker.c('get', '/platform/billing/approvals?limit=100&sortOrder=desc')).body.data;
    expect(desc.map((x: { id: number; type: string }) => `${x.type}${x.id}`).sort()).toEqual(
      asc.map((x: { id: number; type: string }) => `${x.type}${x.id}`).sort(),
    );
    const pg = await checker.c('get', '/platform/billing/approvals?limit=2&page=2');
    expect(pg.body.data).toHaveLength(2);
    expect(pg.body.pagination).toMatchObject({ page: 2, limit: 2, total: all.body.data.length });
    expect((await checker.c('get', '/platform/billing/approvals?type=NOPE')).status).toBe(400);
    expect((await support.c('get', '/platform/billing/approvals')).status).toBe(200);
  });

  it('an item leaves the queue when it is decided', async () => {
    const { society, invoice, maker, checker } = { ...(await billedSociety()), ...(await platformTeam()) };
    const rec = await maker.c(
      'post',
      '/platform/payments',
      {
        societyId: society.id,
        invoiceId: invoice.id,
        method: 'NEFT',
        amountPaise: 500000,
        receivedOn: '2026-10-30',
        bankReference: 'UTR000011113333',
      },
      { headers: idemKey() },
    );
    const q = () => checker.c('get', '/platform/billing/approvals?type=MANUAL_PAYMENT');
    expect((await q()).body.data).toHaveLength(1);
    await checker.c('post', `/platform/payments/${rec.body.data.id}/approve`, { version: 1 });
    expect((await q()).body.data).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ dunning list
describe('dunning list (8.25)', () => {
  it('lists PAST_DUE and SUSPENDED societies with the overdue figures, last step and next suspension date', async () => {
    const s1 = await billedSociety({ name: 'Past Due CHS' });
    const s2 = await billedSociety({ name: 'Later CHS' });
    await billedSociety({ name: 'Fine CHS' });
    await sequelize.query(
      "UPDATE platform_invoices SET dueDate = '2026-10-25', suspendOn = '2026-11-09' WHERE id = :id",
      {
        replacements: { id: s2.invoice.id },
      },
    );
    expect((await s1.view('get', '/platform/billing/dunning')).status).toBe(403);
    setNow('2026-11-02T04:00:00Z');
    await runDunning('2026-11-02'); // s2: 8 days late, past due; s1 and "Fine" are not due yet
    await Society.update(
      { suspensionHoldUntil: new Date('2026-11-20T00:00:00Z') },
      { where: { id: s2.society.id! } },
    );
    await sequelize.query(
      "UPDATE platform_invoices SET dueDate = '2026-10-30', suspendOn = '2026-11-14' WHERE id = :id",
      {
        replacements: { id: s1.invoice.id },
      },
    );
    await runDunning('2026-11-02');
    // the earlier sign-ins are a day old: sign in again at the new date
    const late = await platformAs('super_admin', 'Late Admin');
    const lateSupport = await platformAs('platform_support', 'Late Support');
    const r = await late.c('get', '/platform/billing/dunning');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.map((x: { societyName: string }) => x.societyName)).toEqual([
      'Later CHS',
      'Past Due CHS',
    ]);
    expect(r.body.data[0]).toEqual({
      societyId: s2.society.id,
      societyName: 'Later CHS',
      city: 'Pune',
      status: 'PAST_DUE',
      overduePaise: 1239000,
      overdueInvoiceCount: 1,
      oldestDueDate: '2026-10-25',
      daysLate: 8,
      lastStep: expect.stringMatching(/^(REMINDER [+-]\d+|PAST_DUE)$/),
      nextSuspensionDate: '2026-11-09',
      holdUntil: '2026-11-20',
      pendingManualPaymentPaise: 0,
    });
    const byAmount = await late.c('get', '/platform/billing/dunning?sortBy=nextSuspensionDate&sortOrder=asc');
    expect(byAmount.body.data[0].societyName).toBe('Later CHS');
    expect((await late.c('get', '/platform/billing/dunning?status=SUSPENDED')).body.data).toEqual([]);
    expect((await late.c('get', '/platform/billing/dunning?status=ACTIVE')).status).toBe(400);
    expect((await lateSupport.c('get', '/platform/billing/dunning?limit=1&page=2')).body.data).toHaveLength(
      1,
    );
  });
});

// ------------------------------------------------------------------ GST summary and TDS receivable
describe('GST summary and TDS receivable (8.27)', () => {
  it('groups by supply type and place of supply, reports credit notes as negatives, and exports CSV only with the export permission', async () => {
    const t = await platformTeam();
    const a = await billedSociety();
    const b = await billedSociety();
    await sequelize.query(
      "UPDATE platform_invoices SET billingGstin = '29ABCDE1234F1Z5', placeOfSupplyStateCode = '29', taxType = 'INTER_STATE', igstPaise = taxPaise, cgstPaise = 0, sgstPaise = 0 WHERE id = :id",
      { replacements: { id: b.invoice.id } },
    );
    const cn = await t.maker.c(
      'post',
      `/platform/invoices/${a.invoice.id}/credit-notes`,
      { reason: 'PRICE_CORRECTION', subtotalPaise: 100000, notes: 'Price corrected for November' },
      { headers: idemKey() },
    );
    const ok = await t.checker.c('post', `/platform/invoices/${cn.body.data.id}/approve`, { version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const inv = (await PlatformInvoice.findByPk(a.invoice.id))!;
    const r = await t.support.c('get', '/platform/billing/gst-summary?month=2026-11');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body.data.rows;
    expect(rows).toEqual([
      expect.objectContaining({
        documentType: 'INVOICE',
        supplyType: 'B2B',
        placeOfSupplyStateCode: '29',
        count: 1,
        igstPaise: Number(inv.taxPaise),
        cgstPaise: 0,
      }),
      expect.objectContaining({
        documentType: 'INVOICE',
        supplyType: 'B2C',
        placeOfSupplyStateCode: '27',
        count: 1,
        taxablePaise: Number(inv.subtotalPaise),
        cgstPaise: Number(inv.cgstPaise),
      }),
      expect.objectContaining({
        documentType: 'CREDIT_NOTE',
        supplyType: 'B2C',
        placeOfSupplyStateCode: '27',
        count: 1,
        taxablePaise: -100000,
        cgstPaise: -9000,
        sgstPaise: -9000,
      }),
    ]);
    expect(r.body.data.net.taxablePaise).toBe(Number(inv.subtotalPaise) * 2 - 100000);
    expect((await t.support.c('get', '/platform/billing/gst-summary?month=2026-10')).body.data.rows).toEqual(
      [],
    );
    expect((await t.support.c('get', '/platform/billing/gst-summary')).status).toBe(400);
    expect((await t.support.c('get', '/platform/billing/gst-summary?month=2026-13')).status).toBe(400);
    const no = await t.support.c('get', '/platform/billing/gst-summary?month=2026-11&format=csv');
    expect([no.status, no.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    const csv = await t.checker.c('get', '/platform/billing/gst-summary?month=2026-11&format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toBe(
      'Document type,Supply type,Place of supply,Count,Taxable,CGST,SGST,IGST',
    );
    expect(csv.text.split('\r\n')).toHaveLength(4);
    expect(csv.text).toContain('CREDIT_NOTE,B2C,27,1,-1000.00,-90.00,-90.00,0.00');
    expect(await AuditLog.count({ where: { action: 'platform_billing.report.exported' } })).toBe(1);
  });

  it('TDS receivable by society and section for a financial year or quarter, with CSV', async () => {
    const t = await platformTeam();
    const a = await billedSociety({ name: 'Claimant CHS' });
    const b = await billedSociety({ name: 'Rejected CHS' });
    const claim = (s: typeof a, amount: number, deductedOn: string) =>
      s.pay(
        'post',
        `/subscription/invoices/${s.invoice.id}/tds-claims`,
        { tdsSection: '194J', tdsRatePct: '2', amountPaise: amount, deductedOn },
        { headers: idemKey() },
      );
    const ca = await claim(a, 21000, '2026-10-31');
    const cb = await claim(b, 10000, '2026-10-20');
    await sequelize.query("UPDATE platform_payments SET deductedOn = '2026-07-10' WHERE id = :id", {
      replacements: { id: cb.body.data.id },
    });
    expect(ca.status, JSON.stringify(ca.body)).toBe(201);
    await t.maker.c('post', `/platform/payments/${cb.body.data.id}/tds-decision`, {
      decision: 'REJECTED',
      reason: 'Certificate is not valid',
      version: 1,
    });
    const fy = await t.support.c('get', '/platform/billing/tds-receivable?financialYear=2026-27');
    expect(fy.status, JSON.stringify(fy.body)).toBe(200);
    expect(fy.body.data.rows).toEqual([
      {
        societyId: a.society.id,
        societyName: 'Claimant CHS',
        tdsSection: '194J',
        claimedPaise: 21000,
        verifiedPaise: 0,
        rejectedPaise: 0,
        missingCertificates: 1,
      },
      {
        societyId: b.society.id,
        societyName: 'Rejected CHS',
        tdsSection: '194J',
        claimedPaise: 10000,
        verifiedPaise: 0,
        rejectedPaise: 10000,
        missingCertificates: 0,
      },
    ]);
    await t.maker.c('post', `/platform/payments/${ca.body.data.id}/tds-decision`, {
      decision: 'VERIFIED',
      version: 1,
    });
    const q3 = await t.support.c('get', '/platform/billing/tds-receivable?financialYear=2026-27&quarter=3');
    expect(q3.body.data.rows).toEqual([
      expect.objectContaining({ societyName: 'Claimant CHS', claimedPaise: 21000, verifiedPaise: 21000 }),
    ]);
    const q2 = await t.support.c('get', '/platform/billing/tds-receivable?financialYear=2026-27&quarter=2');
    expect(q2.body.data.rows).toEqual([expect.objectContaining({ societyName: 'Rejected CHS' })]);
    expect(
      (await t.support.c('get', '/platform/billing/tds-receivable?financialYear=2026-27&status=VERIFIED'))
        .body.data.rows,
    ).toHaveLength(1);
    expect(
      (await t.support.c('get', '/platform/billing/tds-receivable?financialYear=2025-26')).body.data.rows,
    ).toEqual([]);
    for (const bad of [
      '',
      '?financialYear=2026-28',
      '?financialYear=2026-27&quarter=5',
      '?financialYear=2026-27&status=X',
    ])
      expect((await t.support.c('get', `/platform/billing/tds-receivable${bad}`)).status, bad).toBe(400);
    expect(
      (await t.support.c('get', '/platform/billing/tds-receivable?financialYear=2026-27&format=csv')).status,
    ).toBe(403);
    const csv = await t.checker.c('get', '/platform/billing/tds-receivable?financialYear=2026-27&format=csv');
    expect(csv.text.split('\r\n')[0]).toBe('Society,Section,Claimed,Verified,Rejected,Missing certificates');
    expect(csv.text).toContain('Claimant CHS,194J,210.00,210.00,0.00,1');
    expect(await AuditLog.count({ where: { action: 'platform_billing.report.exported' } })).toBe(1);
  });
});

// ------------------------------------------------------------------ payment views for the frontend (8.3, 8.7)
describe('payment items carry what the screens need', () => {
  it('version, kind, tdsSection and hasCertificate on lists and invoice detail; societyId and societyName on platform lists', async () => {
    const { society, invoice, pay, maker } = {
      ...(await billedSociety({ name: 'Views CHS' })),
      ...(await platformTeam()),
    };
    const c = await pay(
      'post',
      `/subscription/invoices/${invoice.id}/tds-claims`,
      { tdsSection: '194J', tdsRatePct: '2', amountPaise: 21000, deductedOn: '2026-10-31' },
      { headers: idemKey() },
    );
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const item = {
      id: c.body.data.id,
      kind: 'TDS',
      status: 'CLAIMED',
      tdsSection: '194J',
      hasCertificate: false,
      version: 1,
      amountPaise: 21000,
    };
    const mine = await pay('get', '/subscription/payments');
    expect(mine.body.data).toEqual([expect.objectContaining(item)]);
    expect(mine.body.data[0]).not.toHaveProperty('societyName');
    const all = await maker.c('get', '/platform/payments');
    expect(all.body.data).toEqual([
      expect.objectContaining({ ...item, societyId: society.id, societyName: 'Views CHS' }),
    ]);
    for (const detail of [
      await pay('get', `/subscription/invoices/${invoice.id}`),
      await maker.c('get', `/platform/invoices/${invoice.id}`),
    ])
      expect(detail.body.data.payments).toEqual([expect.objectContaining(item)]);
  });
});
