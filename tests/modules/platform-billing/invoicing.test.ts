import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  DunningEvent,
  PlatformCredit,
  PlatformInvoice,
  PlatformInvoiceLine,
  Society,
  Subscription,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { setRealtimeSink, type RealtimeEvent } from '../../../src/lib/realtime';
import type { Ctx } from '../../../src/types/context';
import { consumeLimit, setAbsoluteUsage } from '../../../src/modules/subscriptions/entitlements.service';
import { quote } from '../../../src/modules/subscriptions/subscriptions.society.service';
import { closeUsageMonths } from '../../../src/modules/subscriptions/subscriptions.usage';
import { societyPorts } from '../../../src/modules/societies/societies.ports';
import { registerPlatformBilling } from '../../../src/modules/platform-billing/platform-billing.public';
import {
  approveDocument,
  createCreditNote,
  createManualInvoice,
  issueOneTimeInvoice,
  issuePeriodInvoice,
  issueProrationInvoice,
  rejectDocument,
} from '../../../src/modules/platform-billing/platform-billing.service';
import {
  applyCredits,
  creditBalance,
  getOutstanding,
  hasOverdueInvoice,
  postCredit,
} from '../../../src/modules/platform-billing/platform-billing.settlement';
import { runGenerateInvoices } from '../../../src/modules/platform-billing/platform-billing.jobs';
import { computeTax, periodValue } from '../../../src/modules/platform-billing/pricing';
import { resetSocieties } from '../../helpers/societies';
import { subSociety } from '../../helpers/subscriptions';
import { makeUser } from '../../helpers/auth';

/** Task 6.2: invoice service, generation job and the module 04 / 05 ports (sections 5.1, 5.2, 6.1, 6.2, 6.7, 9.3). */
const SYSTEM: Ctx = { requestId: 'test', ip: '', userAgent: '' };
const tx = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);
const events: RealtimeEvent[] = [];

async function admin(name: string): Promise<Ctx> {
  const u = await makeUser({ name });
  return {
    requestId: 'test',
    ip: '127.0.0.1',
    userAgent: 'vitest',
    user: { id: u.id, name, mobile: u.mobile, email: u.email, platformRoleId: null, status: 'ACTIVE' },
    actorRoleKey: 'super_admin',
  };
}

const period = (subscriptionId: number, periodStart = '2026-11-01') =>
  tx(t => issuePeriodInvoice(SYSTEM, { subscriptionId, periodStart }, t));
const linesOf = async (invoiceId: number) =>
  (await PlatformInvoiceLine.findAll({ where: { invoiceId }, order: [['lineNo', 'ASC']] })).map(l => [
    l.lineType,
    Number(l.quantity),
    l.amountPaise,
  ]);

beforeEach(async () => {
  await resetSocieties();
  setNow('2026-11-01T06:00:00Z'); // after the reset, which returns the clock to real time
  registerPlatformBilling();
  events.length = 0;
  setRealtimeSink({ emit: e => events.push(e), disconnectSession: () => undefined });
});
afterAll(async () => {
  await drainQueues();
  setRealtimeSink(undefined);
  setNow(null);
  await closeDb();
});

describe('PERIOD invoices (BR-06-1 to BR-06-7, 6.7)', () => {
  it('issues a numbered, taxed invoice from the module 04 snapshot with the supplier and buyer snapshot', async () => {
    const { society, sub } = await subSociety({ plan: 'PREMIUM', flats: 420 });
    const dto = (await period(sub.id!))!;
    expect(dto).toMatchObject({
      invoiceNo: 'PLT/2026-27/000001',
      status: 'ISSUED',
      invoiceKind: 'PERIOD',
      issueDate: '2026-11-01',
      dueDate: '2026-11-16',
      suspendOn: '2026-12-01',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      planKey: 'PREMIUM',
      billingCycle: 'MONTHLY',
      taxType: 'INTRA_STATE',
      placeOfSupplyStateCode: '27',
      gstRatePct: '18.0000',
      sacCode: '998314',
      subtotalPaise: 1050000,
      cgstPaise: 94500,
      sgstPaise: 94500,
      totalPaise: 1239000,
      amountDuePaise: 1239000,
      pdfStatus: 'PENDING',
    });
    const inv = (await PlatformInvoice.findByPk(dto.id))!;
    expect(inv).toMatchObject({
      dedupeKey: `PERIOD:${sub.id}:2026-11-01`,
      financialYear: '2026-27',
      supplierLegalName: 'SocietyApp Technologies Pvt Ltd',
      supplierGstin: '27ABCDE1234F1Z5',
      billingName: society.name,
      billingAddress: 'Baner Road, Pune, 411045',
      billingStateName: 'Maharashtra',
    });
    expect(await linesOf(dto.id)).toEqual([['PLAN', 420, 1050000]]);
    const a = await AuditLog.findOne({ where: { action: 'platform_billing.invoice.issued' } });
    expect([a?.entityId, a?.actorRole, a?.societyId]).toEqual([String(dto.id), 'system', society.id]);
    expect(events).toContainEqual({
      room: `society:${society.id}:admin`,
      event: 'platform_billing.billing.changed',
      payload: { invoiceId: dto.id },
    });
  });

  it('BR-06-2 a second call for the same period returns the same invoice and writes nothing', async () => {
    const { sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    const a = await period(sub.id!);
    const b = await period(sub.id!);
    expect(b!.id).toBe(a!.id);
    expect(await PlatformInvoice.count()).toBe(1);
    expect(await AuditLog.count({ where: { action: 'platform_billing.invoice.issued' } })).toBe(1);
  });

  it('a GSTIN of another state makes the invoice inter-state (IGST only)', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    await Society.update({ gstin: '29ABCDE1234F1Z5' }, { where: { id: society.id! } });
    const dto = (await period(sub.id!))!;
    expect(dto).toMatchObject({
      taxType: 'INTER_STATE',
      placeOfSupplyStateCode: '29',
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 16200,
      totalPaise: 106200,
    });
  });

  it('T06-03a annual Standard ₹15, 240 flats: PLAN and DISCOUNT lines, ₹42,480', async () => {
    const { sub } = await subSociety({ plan: 'STANDARD', flats: 240, cycle: 'ANNUAL' });
    const dto = (await period(sub.id!))!;
    expect(await linesOf(dto.id)).toEqual([
      ['PLAN', 240, 4320000],
      ['DISCOUNT', 240, -720000],
    ]);
    expect(dto).toMatchObject({ subtotalPaise: 3600000, cgstPaise: 324000, totalPaise: 4248000 });
  });

  it('module 04 renewal issues the next invoice with a FLAT_TRUE_UP line; the job adds nothing (T06-08)', async () => {
    setNow('2026-10-05T06:00:00Z');
    const { society, sub } = await subSociety({ plan: 'PREMIUM', flats: 412, periodStart: '2026-10-01' });
    const oct = (await period(sub.id!, '2026-10-01'))!;
    expect(await linesOf(oct.id)).toEqual([['PLAN', 412, 1030000]]);
    // 8 flats added on 22 October (module 04 keeps the segments; module 08 the count)
    await Subscription.update(
      {
        flatSegments: [
          { fromDate: '2026-10-01', toDate: '2026-10-21', billableFlats: 412 },
          { fromDate: '2026-10-22', toDate: null, billableFlats: 420 },
        ],
      },
      { where: { id: sub.id! } },
    );
    await setAbsoluteUsage(society.id!, 'limit.flats', 420);
    setNow('2026-11-01T00:30:00Z');
    const first = await runGenerateInvoices('2026-11-01');
    expect(first).toMatchObject({ due: 1, failed: 0 });
    const second = await runGenerateInvoices('2026-11-01');
    expect(second).toMatchObject({ due: 1, issued: 0, existing: 1, failed: 0 });
    const invoices = await PlatformInvoice.findAll({ order: [['id', 'ASC']] });
    expect(invoices.map(i => [i.invoiceNo, i.periodStart])).toEqual([
      ['PLT/2026-27/000001', '2026-10-01'],
      ['PLT/2026-27/000002', '2026-11-01'],
    ]);
    expect(await linesOf(invoices[1]!.id!)).toEqual([
      ['PLAN', 420, 1050000],
      ['FLAT_TRUE_UP', 80, 6452],
    ]);
    expect(invoices[1]!.totalPaise).toBe(computeTax(1056452, 'INTRA_STATE', '18.0000').totalPaise);
    expect((await Subscription.findByPk(sub.id!))!.lastInvoicedPeriodStart).toBe('2026-11-01');
  });

  it('T06-08 the job issues a missed period once; a rerun the same day changes nothing', async () => {
    const { sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    await Subscription.update({ lastInvoicedPeriodStart: null }, { where: { id: sub.id! } });
    expect(await runGenerateInvoices('2026-11-01')).toEqual({
      due: 1,
      issued: 1,
      existing: 0,
      nothingToInvoice: 0,
      failed: 0,
    });
    expect(await runGenerateInvoices('2026-11-01')).toMatchObject({ issued: 0, existing: 1 });
    expect(await PlatformInvoice.count()).toBe(1);
  });

  it('BR-06-7 monthly overage of the previous period is billed on the renewal invoice', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    await tx(t =>
      consumeLimit(SYSTEM, 'limit.sms_per_month', 2300, { transaction: t, societyId: society.id! }),
    );
    setNow('2026-12-01T00:30:00Z');
    await runGenerateInvoices('2026-12-01');
    const dec = (await PlatformInvoice.findOne({ where: { dedupeKey: `PERIOD:${sub.id}:2026-12-01` } }))!;
    expect(await linesOf(dec.id!)).toEqual([
      ['PLAN', 60, 90000],
      ['OVERAGE', 300, 7500],
    ]);
  });

  it('T06-03b annual overage: one OVERAGE invoice per month and limit; the period invoice has none', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60, cycle: 'ANNUAL' });
    const annual = (await period(sub.id!))!;
    expect((await linesOf(annual.id)).map(l => l[0])).toEqual(['PLAN', 'DISCOUNT']);
    await tx(t =>
      consumeLimit(SYSTEM, 'limit.sms_per_month', 2300, { transaction: t, societyId: society.id! }),
    );
    setNow('2026-12-01T00:30:00Z');
    await closeUsageMonths();
    await closeUsageMonths();
    const ref = `OVERAGE:${sub.id}:2026-11-01:limit.sms_per_month`;
    const again = await tx(t =>
      issueOneTimeInvoice(
        SYSTEM,
        {
          subscriptionId: sub.id!,
          purchaseRef: ref,
          label: 'SMS',
          quantity: 300,
          unitPricePaise: 25,
          lineType: 'OVERAGE',
        },
        t,
      ),
    );
    const overage = await PlatformInvoice.findAll({ where: { invoiceKind: 'ONE_TIME' } });
    expect(overage).toHaveLength(1);
    expect(again!.id).toBe(overage[0]!.id);
    const line = (await PlatformInvoiceLine.findOne({ where: { invoiceId: overage[0]!.id! } }))!;
    expect([line.lineType, line.limitKey, line.amountPaise, line.addonKey]).toEqual([
      'OVERAGE',
      'limit.sms_per_month',
      7500,
      null,
    ]);
  });

  it('two concurrent calls for the same period create one invoice and no gap', async () => {
    const { sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    const [a, b] = await Promise.all([period(sub.id!), period(sub.id!)]);
    expect(a!.id).toBe(b!.id);
    const { sub: other } = await subSociety({ plan: 'STANDARD', flats: 60, name: 'Green Park CHS' });
    expect((await period(other.id!))!.invoiceNo).toBe('PLT/2026-27/000002');
  });

  it('T06-09 parallel issue for many subscriptions: contiguous numbers, no duplicates', async () => {
    const subs = [];
    for (let i = 0; i < 50; i++)
      subs.push((await subSociety({ plan: 'STARTER', flats: 30, name: `Society ${i}` })).sub);
    const out = await Promise.all(subs.map(s => period(s.id!)));
    const numbers = out.map(o => o!.invoiceNo).sort();
    expect(numbers).toEqual(
      Array.from({ length: 50 }, (_, i) => `PLT/2026-27/${String(i + 1).padStart(6, '0')}`),
    );
  }, 120_000);
});

describe('credits at issue and BR-06-40', () => {
  it('BR-06-26 a credit balance is applied to the new invoice', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    await tx(t =>
      postCredit(SYSTEM, { societyId: society.id!, entryType: 'PAYMENT_EXCESS', amountPaise: 50000 }, t),
    );
    const dto = (await period(sub.id!))!;
    expect(dto).toMatchObject({
      status: 'PARTIALLY_PAID',
      creditAppliedPaise: 50000,
      amountDuePaise: 106200 - 50000,
    });
    const credits = await PlatformCredit.findAll({ order: [['id', 'ASC']] });
    expect(credits.map(c => [c.entryType, c.amountPaise, c.balanceAfterPaise, c.invoiceId])).toEqual([
      ['PAYMENT_EXCESS', 50000, 50000, null],
      ['APPLIED', -50000, 0, dto.id],
    ]);
    expect(await getOutstanding(society.id!)).toEqual({ outstandingPaise: 56200, overduePaise: 0 });
  });

  it('credit covering the whole total: PAID at issue, audit .invoice.paid, TRIAL society becomes ACTIVE', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60, societyStatus: 'TRIAL' });
    await tx(t =>
      postCredit(SYSTEM, { societyId: society.id!, entryType: 'PAYMENT_EXCESS', amountPaise: 200000 }, t),
    );
    const dto = (await period(sub.id!))!;
    expect(dto).toMatchObject({ status: 'PAID', amountDuePaise: 0, creditAppliedPaise: 106200 });
    expect((await PlatformInvoice.findByPk(dto.id))!.paidAt).not.toBeNull();
    expect(await creditBalance(society.id!)).toBe(200000 - 106200);
    expect(await AuditLog.count({ where: { action: 'platform_billing.invoice.paid' } })).toBe(1);
    expect((await Society.findByPk(society.id!))!.status).toBe('ACTIVE');
  });
});

describe('PRORATION and ONE_TIME invoices (BR-06-8, BR-06-9)', () => {
  it('T06-04 Green Park Starter → Standard, 96 flats, 20 of 30 days: ₹453.12', async () => {
    setNow('2026-11-11T06:00:00Z');
    const { sub } = await subSociety({ plan: 'STANDARD', flats: 96, periodStart: '2026-11-01' });
    const input = {
      subscriptionId: sub.id!,
      changeRef: `UPGRADE:${sub.id}:2`,
      effectiveDate: '2026-11-11',
      items: [
        {
          label: 'Starter to Standard',
          fromPeriodValuePaise: periodValue(96, 900, 1, 0),
          toPeriodValuePaise: periodValue(96, 1500, 1, 0),
        },
      ],
    };
    const dto = (await tx(t => issueProrationInvoice(SYSTEM, input, t)))!;
    expect(dto).toMatchObject({
      invoiceKind: 'PRORATION',
      periodStart: '2026-11-11',
      periodEnd: '2026-11-30',
      subtotalPaise: 38400,
      cgstPaise: 3456,
      sgstPaise: 3456,
      totalPaise: 45312,
    });
    expect(await linesOf(dto.id)).toEqual([
      ['PRORATION', 1, -57600],
      ['PRORATION', 1, 96000],
    ]);
    const again = await tx(t => issueProrationInvoice(SYSTEM, input, t));
    expect(again!.id).toBe(dto.id);
    // a downgrade-shaped request (subtotal ≤ 0) issues nothing
    const none = await tx(t =>
      issueProrationInvoice(
        SYSTEM,
        {
          ...input,
          changeRef: 'X',
          items: [{ ...input.items[0]!, fromPeriodValuePaise: 144000, toPeriodValuePaise: 86400 }],
        },
        t,
      ),
    );
    expect(none).toBeNull();
    expect(await PlatformInvoice.count()).toBe(1);
  });

  it('a module 04 add-on pack (lineType ADDON) is a ONE_TIME line; paying it calls module 04', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    const input = {
      subscriptionId: sub.id!,
      purchaseRef: 'ADDON:77',
      addonKey: 'WHATSAPP_PACK_5000',
      label: 'WhatsApp pack 5,000',
      quantity: 1,
      unitPricePaise: 49900,
      lineType: 'ADDON' as const,
    };
    const dto = (await tx(t => issueOneTimeInvoice(SYSTEM, input, t)))!;
    expect(dto).toMatchObject({ invoiceKind: 'ONE_TIME', subtotalPaise: 49900, totalPaise: 58882 });
    expect(await linesOf(dto.id)).toEqual([['ONE_TIME', 1, 49900]]);
    expect((await tx(t => issueOneTimeInvoice(SYSTEM, input, t)))!.id).toBe(dto.id);
    // settled by credit at the next issue: module 04 onPlatformInvoicePaid runs in the same transaction
    await tx(t =>
      postCredit(SYSTEM, { societyId: society.id!, entryType: 'PAYMENT_EXCESS', amountPaise: 58882 }, t),
    );
    await tx(t => applyCredits(SYSTEM, society.id!, t));
    expect((await PlatformInvoice.findByPk(dto.id))!.status).toBe('PAID');
  });
});

describe('MANUAL invoices (BR-06-10, 8.12, 8.14)', () => {
  it('draft without a number, approved by a second person, numbered at approval', async () => {
    const maker = await admin('Asha Admin');
    const checker = await admin('Isha Kapoor');
    const { society } = await subSociety({ plan: 'STANDARD', flats: 60 });
    const draft = await createManualInvoice(maker, {
      societyId: society.id!,
      lines: [
        { description: 'Setup fee', quantity: '1', unitPricePaise: 500000 },
        { description: 'Data migration', quantity: '1.5', unitPricePaise: 333 },
      ],
      notes: 'Onboarding',
    });
    expect(draft).toMatchObject({ status: 'DRAFT', invoiceNo: '', subtotalPaise: 500500, amountDuePaise: 0 });
    expect(draft.lines!.map(l => [l.lineType, l.amountPaise])).toEqual([
      ['MANUAL', 500000],
      ['MANUAL', 500],
    ]);
    await expect(approveDocument(maker, draft.id, { version: 1 })).rejects.toMatchObject({
      status: 409,
      code: 'MAKER_CHECKER_VIOLATION',
    });
    await expect(approveDocument(checker, draft.id, { version: 2 })).rejects.toMatchObject({
      code: 'STALE_VERSION',
    });
    const issued = await approveDocument(checker, draft.id, { version: 1 });
    expect(issued).toMatchObject({
      status: 'ISSUED',
      invoiceNo: 'PLT/2026-27/000001',
      dueDate: '2026-11-16',
      totalPaise: 590590,
      amountDuePaise: 590590,
      version: 2,
    });
    expect((await PlatformInvoice.findByPk(draft.id))!.approvedBy).toBe(checker.user!.id);
    await expect(approveDocument(checker, draft.id, { version: 2 })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('a rejected draft never takes a number; 21 lines are refused', async () => {
    const maker = await admin('Asha Admin');
    const checker = await admin('Isha Kapoor');
    const { society } = await subSociety({ plan: 'STANDARD', flats: 60 });
    const draft = await createManualInvoice(maker, {
      societyId: society.id!,
      lines: [{ description: 'Custom report', quantity: '1', unitPricePaise: 100000 }],
    });
    await expect(rejectDocument(checker, draft.id, { version: 1, reason: 'short' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const r = await rejectDocument(checker, draft.id, { version: 1, reason: 'Duplicate of the setup fee' });
    expect(r).toMatchObject({ status: 'REJECTED', invoiceNo: '' });
    const { sub } = await subSociety({ plan: 'STANDARD', flats: 60, name: 'Green Park CHS' });
    expect((await period(sub.id!))!.invoiceNo).toBe('PLT/2026-27/000001');
    await expect(
      createManualInvoice(maker, {
        societyId: society.id!,
        lines: Array.from({ length: 21 }, () => ({
          description: 'Line',
          quantity: '1',
          unitPricePaise: 100,
        })),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('credit notes (BR-06-20, BR-06-35, 6.2)', () => {
  it('T06-07 partial then completing credit notes: exact tax, invoice VOID, paid money becomes credit', async () => {
    const maker = await admin('Asha Admin');
    const checker = await admin('Isha Kapoor');
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    const inv = (await period(sub.id!))!; // subtotal 90,000, CGST = SGST 8,100, total 1,06,200
    const cn1 = await createCreditNote(maker, inv.id, {
      reason: 'SERVICE_CREDIT',
      subtotalPaise: 33333,
      notes: 'SMS delivery outage for three days',
    });
    expect(cn1).toMatchObject({
      documentType: 'CREDIT_NOTE',
      status: 'DRAFT',
      cgstPaise: 3000,
      totalPaise: 39333,
    });
    expect(cn1.lines![0]!.description).toBe(`Credit against ${inv.invoiceNo}: service credit`);
    await expect(
      createCreditNote(maker, inv.id, {
        reason: 'OTHER',
        subtotalPaise: 56668,
        notes: 'Too much to credit here',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'CREDIT_NOTE_EXCEEDS_INVOICE' });
    const issued1 = await approveDocument(checker, cn1.id, { version: 1 });
    expect(issued1).toMatchObject({ invoiceNo: 'PCN/2026-27/000001', status: 'ISSUED' });
    let orig = (await PlatformInvoice.findByPk(inv.id))!;
    expect([orig.status, orig.creditNotedPaise, orig.amountDuePaise]).toEqual([
      'ISSUED',
      39333,
      106200 - 39333,
    ]);
    const cn2 = await createCreditNote(maker, inv.id, {
      reason: 'CANCELLATION',
      subtotalPaise: 90000 - 33333,
      notes: 'Society cancelled the month',
    });
    // 9 % of 56,667 = 5,100.03 → 5,100 by BR-06-15; the exact remainder is 8,100 − 3,000 = 5,100 as well
    const issued2 = await approveDocument(checker, cn2.id, { version: 1 });
    expect(issued2.cgstPaise + 3000).toBe(8100);
    orig = (await PlatformInvoice.findByPk(inv.id))!;
    expect([orig.status, orig.creditNotedPaise, orig.amountDuePaise, orig.voidedAt !== null]).toEqual([
      'VOID',
      106200,
      0,
      true,
    ]);
    expect(await creditBalance(society.id!)).toBe(0);
    expect(await AuditLog.count({ where: { action: 'platform_billing.credit_note.issued' } })).toBe(2);
  });

  it('BR-06-35 a credit note on a PAID invoice moves the credited amount to the credit balance', async () => {
    const maker = await admin('Asha Admin');
    const checker = await admin('Isha Kapoor');
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    await tx(t =>
      postCredit(SYSTEM, { societyId: society.id!, entryType: 'PAYMENT_EXCESS', amountPaise: 106200 }, t),
    );
    const inv = (await period(sub.id!))!;
    expect(inv.status).toBe('PAID');
    const cn = await createCreditNote(maker, inv.id, {
      reason: 'PRICE_CORRECTION',
      subtotalPaise: 10000,
      notes: 'Wrong flat count billed',
    });
    await approveDocument(checker, cn.id, { version: 1 });
    const orig = (await PlatformInvoice.findByPk(inv.id))!;
    expect([orig.status, orig.excessToCreditPaise, orig.amountDuePaise]).toEqual(['PAID', 11800, 0]);
    const last = (await PlatformCredit.findOne({ order: [['id', 'DESC']] }))!;
    expect([last.entryType, last.amountPaise, last.invoiceId, last.balanceAfterPaise]).toEqual([
      'CREDIT_NOTE',
      11800,
      cn.id,
      11800,
    ]);
  });

  it('a full credit note clears a PAST_DUE society (BR-06-40, CLEARED event)', async () => {
    const maker = await admin('Asha Admin');
    const checker = await admin('Isha Kapoor');
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60, societyStatus: 'PAST_DUE' });
    const inv = (await period(sub.id!))!;
    setNow('2026-11-20T06:00:00Z');
    expect(await hasOverdueInvoice(society.id!)).toBe(true);
    expect(await societyPorts().billing.hasOverdueInvoice(society.id!)).toBe(true);
    expect(await getOutstanding(society.id!)).toEqual({ outstandingPaise: 106200, overduePaise: 106200 });
    const cn = await createCreditNote(maker, inv.id, {
      reason: 'DUPLICATE_INVOICE',
      subtotalPaise: 90000,
      notes: 'Billed twice for November',
    });
    await approveDocument(checker, cn.id, { version: 1 });
    expect((await PlatformInvoice.findByPk(inv.id))!.status).toBe('VOID');
    expect(await hasOverdueInvoice(society.id!)).toBe(false);
    expect((await Society.findByPk(society.id!))!.status).toBe('ACTIVE');
    expect((await DunningEvent.findAll()).map(e => [e.step, e.invoiceId, e.scheduledFor])).toEqual([
      ['CLEARED', null, '2026-11-20'],
    ]);
  });

  it('T06-25 time-barred after 30 November following the FY; T06-37 approving an issued note; reject', async () => {
    const maker = await admin('Asha Admin');
    const checker = await admin('Isha Kapoor');
    const { sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    const inv = (await period(sub.id!))!;
    const cn = await createCreditNote(maker, inv.id, {
      reason: 'OTHER',
      subtotalPaise: 100,
      notes: 'Rounding correction',
    });
    await expect(
      rejectDocument(maker, cn.id, { version: 1, reason: 'Not needed after all' }),
    ).rejects.toMatchObject({
      code: 'MAKER_CHECKER_VIOLATION',
    });
    await approveDocument(checker, cn.id, { version: 1 });
    await expect(approveDocument(checker, cn.id, { version: 2 })).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_STATE',
    });
    await expect(
      createCreditNote(maker, cn.id, { reason: 'OTHER', subtotalPaise: 1, notes: 'A note on a note' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    setNow('2027-11-30T12:00:00Z');
    const ok = await createCreditNote(maker, inv.id, {
      reason: 'OTHER',
      subtotalPaise: 100,
      notes: 'Last day allowed',
    });
    await rejectDocument(checker, ok.id, { version: 1, reason: 'Raised by mistake' });
    setNow('2027-12-01T06:00:00Z');
    await expect(
      createCreditNote(maker, inv.id, { reason: 'OTHER', subtotalPaise: 100, notes: 'Too late for GST' }),
    ).rejects.toMatchObject({ status: 422, code: 'CREDIT_NOTE_TIME_BARRED' });
  });
});

describe('ports for modules 04 and 05', () => {
  it('module 04 quote now carries real GST (T06-03a amounts)', async () => {
    const { society } = await subSociety({ plan: 'STARTER', flats: 240 });
    const q = await quote(society.id!, { planCode: 'STANDARD', billingCycle: 'ANNUAL' });
    expect(q).toMatchObject({
      subtotalPaise: 3600000,
      tax: { mode: 'INTRA_STATE', cgstPaise: 324000, sgstPaise: 324000, igstPaise: 0 },
      totalPaise: 4248000,
    });
  });

  it('module 05 hasOverdueInvoice ignores balances below dunningMinDuePaise (BR-06-38)', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    await tx(t =>
      postCredit(
        SYSTEM,
        { societyId: society.id!, entryType: 'PAYMENT_EXCESS', amountPaise: 106200 - 5000 },
        t,
      ),
    );
    await period(sub.id!);
    setNow('2026-11-17T06:00:00Z');
    expect(await getOutstanding(society.id!)).toEqual({ outstandingPaise: 5000, overduePaise: 5000 });
    expect(await hasOverdueInvoice(society.id!)).toBe(false);
  });

  it('past-due day is dueDate + pastDueAfterDays', async () => {
    const { society, sub } = await subSociety({ plan: 'STANDARD', flats: 60 });
    await period(sub.id!);
    setNow('2026-11-16T06:00:00Z');
    expect(await hasOverdueInvoice(society.id!)).toBe(false);
    setNow('2026-11-17T06:00:00Z');
    expect(await hasOverdueInvoice(society.id!)).toBe(true);
  });
});
