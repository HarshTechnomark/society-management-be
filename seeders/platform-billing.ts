import type { Transaction } from 'sequelize';
import {
  Plan,
  PlanVersion,
  PlatformCredit,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  Society,
  Subscription,
  User,
  sequelize,
} from '../src/models';
import { istDate, now } from '../src/lib/clock';
import { nextNumber, financialYearOf } from '../src/utils/numberSequences';
import { addDaysYmd, addMonthsAnchored, zonedDayStart } from '../src/modules/subscriptions/pricing';
import { chargedOf, priceOf } from '../src/modules/subscriptions/subscriptions.util';
import { computeTax, placeOfSupply } from '../src/modules/platform-billing/pricing';
import { percentOf } from '../src/lib/money';
import { BILLING_SETTING_DEFAULTS as S } from '../src/modules/platform-billing/platform-billing.settings';

/**
 * Module 06 demo seed (section 7.6), not run in production. For Sky Heights CHS (Premium) and Green Park CHS
 * (Starter): three monthly PERIOD invoices each (the two past ones PAID, the current one ISSUED).
 * Sky Heights: month −2 paid by UPI, then a SERVICE_CREDIT credit note on it (the excess becomes credit), month −1
 * settled by that credit, a 194J TDS claim and a UPI payment. Green Park: month −2 paid by UPI, month −1 paid by NEFT
 * with a manual payment entered by Platform Admin and approved by Isha Kapoor.
 * Settings are the section 5.3 code defaults (module 07 does not exist yet); tax and place of supply come from the
 * module 06 calculator (`pricing.ts`). Idempotent: a society that already has a PERIOD invoice is skipped.
 */
const SUPPLIER = {
  supplierLegalName: S['company.legalName'],
  supplierGstin: S['company.gstin'],
  supplierStateCode: S['company.stateCode'],
  supplierAddress: S['company.address'],
};
const SAC = S['billing.sacCode'];
const GST_RATE = S['billing.gstRatePct'];
const NET_TERMS_DAYS = S['billing.netTermsDays'];
const SUSPEND_AFTER_DAYS = S['billing.suspendAfterDays'];

interface Settlement {
  creditAppliedPaise?: number;
  paidPaise?: number;
  tdsPaise?: number;
  creditNotedPaise?: number;
  excessToCreditPaise?: number;
}
const amountDue = (total: number, s: Settlement): number =>
  total -
  (s.creditNotedPaise ?? 0) -
  (s.creditAppliedPaise ?? 0) -
  (s.paidPaise ?? 0) -
  (s.tdsPaise ?? 0) +
  (s.excessToCreditPaise ?? 0);

/** BR-06-15 amounts (subtotal, CGST/SGST or IGST, tax, total) from the module 06 calculator. */
const taxOf = (subtotal: number, taxType: 'INTRA_STATE' | 'INTER_STATE') =>
  computeTax(subtotal, taxType, GST_RATE);

interface SeedCtx {
  society: Society;
  sub: Subscription;
  version: PlanVersion;
  planKey: string;
  t: Transaction;
}

function buyer(s: Society) {
  const pos = placeOfSupply({ gstin: s.gstin, state: s.state }, S['company.stateCode']);
  return {
    billingName: s.legalName ?? s.name,
    billingGstin: s.gstin,
    billingAddress: [s.addressLine1, s.addressLine2, s.city, s.pincode].filter(Boolean).join(', '),
    billingStateName: s.state,
    placeOfSupplyStateCode: pos.stateCode,
    taxType: pos.taxType,
  };
}

async function issuePeriodInvoice(c: SeedCtx, periodStart: string): Promise<PlatformInvoice> {
  const { society, sub, version, t } = c;
  const periodEnd = addDaysYmd(addMonthsAnchored(periodStart, 1, 1), -1);
  const flats = chargedOf(sub, version, sub.billableFlats);
  const unit = priceOf(sub, version);
  const subtotal = flats * unit;
  const b = buyer(society);
  const issueDate = periodStart;
  const dueDate = addDaysYmd(issueDate, NET_TERMS_DAYS);
  const tax = taxOf(subtotal, b.taxType);
  const invoiceNo = await nextNumber(0, 'PLATFORM_INVOICE', { date: issueDate, transaction: t });
  const inv = await PlatformInvoice.create(
    {
      societyId: society.id!,
      subscriptionId: sub.id!,
      documentType: 'INVOICE',
      invoiceKind: 'PERIOD',
      dedupeKey: `PERIOD:${sub.id}:${periodStart}`,
      invoiceNo,
      financialYear: financialYearOf(issueDate),
      status: 'ISSUED',
      issueDate,
      dueDate,
      suspendOn: addDaysYmd(dueDate, SUSPEND_AFTER_DAYS),
      periodStart,
      periodEnd,
      planKey: c.planKey,
      billingCycle: 'MONTHLY',
      ...SUPPLIER,
      ...b,
      gstRatePct: GST_RATE,
      sacCode: SAC,
      ...tax,
      amountDuePaise: tax.totalPaise,
      issuedAt: zonedDayStart(issueDate),
      pdfStatus: 'PENDING',
    } as never,
    { transaction: t },
  );
  await PlatformInvoiceLine.create(
    {
      societyId: society.id!,
      invoiceId: inv.id!,
      lineNo: 1,
      lineType: 'PLAN',
      description: `${c.planKey[0]}${c.planKey.slice(1).toLowerCase()} plan, ${flats} flats × ₹${unit / 100} × 1 month (${periodStart} to ${periodEnd})`,
      sacCode: SAC,
      quantity: String(flats),
      unitPricePaise: unit,
      amountPaise: subtotal,
      planVersionId: version.id!,
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
    } as never,
    { transaction: t },
  );
  return inv;
}

/** Writes settlement amounts and the derived status (BR-06-21, BR-06-22 without the overdue branch for past invoices). */
async function settle(inv: PlatformInvoice, s: Settlement, paidOn: string, t: Transaction): Promise<void> {
  const next = {
    creditAppliedPaise: inv.creditAppliedPaise + (s.creditAppliedPaise ?? 0),
    paidPaise: inv.paidPaise + (s.paidPaise ?? 0),
    tdsPaise: inv.tdsPaise + (s.tdsPaise ?? 0),
    creditNotedPaise: inv.creditNotedPaise + (s.creditNotedPaise ?? 0),
    excessToCreditPaise: inv.excessToCreditPaise + (s.excessToCreditPaise ?? 0),
  };
  const due = amountDue(Number(inv.totalPaise), next);
  await inv.update(
    {
      ...next,
      amountDuePaise: due,
      status: due === 0 ? 'PAID' : 'PARTIALLY_PAID',
      paidAt: due === 0 ? (inv.paidAt ?? zonedDayStart(paidOn)) : null,
      version: inv.version + 1,
    },
    { transaction: t },
  );
}

async function upiPayment(inv: PlatformInvoice, amount: number, on: string, t: Transaction): Promise<void> {
  const ref = inv.invoiceNo!.replace(/\//g, '');
  await PlatformPayment.create(
    {
      societyId: inv.societyId,
      invoiceId: inv.id!,
      kind: 'PAYMENT',
      origin: 'SOCIETY',
      status: 'CAPTURED',
      method: 'UPI',
      amountPaise: amount,
      appliedPaise: amount,
      gatewayOrderId: `order_demo_${ref}`,
      gatewayPaymentId: `pay_demo_${ref}`,
      capturedAt: zonedDayStart(on),
    } as never,
    { transaction: t },
  );
  await settle(inv, { paidPaise: amount }, on, t);
}

async function seedSkyHeights(c: SeedCtx, starts: string[]): Promise<void> {
  const { t, society } = c;
  // month −2: paid in full by UPI three days after issue
  const m2 = await issuePeriodInvoice(c, starts[0]!);
  await upiPayment(m2, Number(m2.totalPaise), addDaysYmd(starts[0]!, 3), t);

  // credit note on month −2 (SMS outage): the invoice is already paid, so the whole note becomes credit (BR-06-35)
  const cnDate = addDaysYmd(starts[0]!, 20);
  const cnSubtotal = 50000;
  const cnTax = taxOf(cnSubtotal, m2.taxType);
  const cn = await PlatformInvoice.create(
    {
      societyId: society.id!,
      subscriptionId: c.sub.id!,
      documentType: 'CREDIT_NOTE',
      invoiceKind: null,
      originalInvoiceId: m2.id!,
      invoiceNo: await nextNumber(0, 'PLATFORM_CREDIT_NOTE', { date: cnDate, transaction: t }),
      financialYear: financialYearOf(cnDate),
      status: 'ISSUED',
      issueDate: cnDate,
      periodStart: m2.periodStart,
      periodEnd: m2.periodEnd,
      planKey: m2.planKey,
      billingCycle: m2.billingCycle,
      ...SUPPLIER,
      ...buyer(society),
      taxType: m2.taxType,
      placeOfSupplyStateCode: m2.placeOfSupplyStateCode,
      gstRatePct: m2.gstRatePct,
      sacCode: SAC,
      ...cnTax,
      amountDuePaise: 0,
      creditNoteReason: 'SERVICE_CREDIT',
      notes: 'Service credit for the SMS delivery outage',
      approvedAt: zonedDayStart(cnDate),
      issuedAt: zonedDayStart(cnDate),
    } as never,
    { transaction: t },
  );
  await PlatformInvoiceLine.create(
    {
      societyId: society.id!,
      invoiceId: cn.id!,
      lineNo: 1,
      lineType: 'CREDIT_NOTE',
      description: `Service credit against ${m2.invoiceNo} (SMS delivery outage)`,
      sacCode: SAC,
      quantity: '1',
      unitPricePaise: cnSubtotal,
      amountPaise: cnSubtotal,
    } as never,
    { transaction: t },
  );
  await settle(
    m2,
    { creditNotedPaise: cnTax.totalPaise, excessToCreditPaise: cnTax.totalPaise },
    m2.issueDate!,
    t,
  );
  await PlatformCredit.create(
    {
      societyId: society.id!,
      entryType: 'CREDIT_NOTE',
      status: 'POSTED',
      amountPaise: cnTax.totalPaise,
      balanceAfterPaise: cnTax.totalPaise,
      invoiceId: cn.id!,
      postedAt: zonedDayStart(cnDate),
    } as never,
    { transaction: t },
  );

  // month −1: the credit is applied at issue (BR-06-26), 194J TDS at 10 % of the taxable value, the rest by UPI
  const m1 = await issuePeriodInvoice(c, starts[1]!);
  await PlatformCredit.create(
    {
      societyId: society.id!,
      entryType: 'APPLIED',
      status: 'POSTED',
      amountPaise: -cnTax.totalPaise,
      balanceAfterPaise: 0,
      invoiceId: m1.id!,
      postedAt: zonedDayStart(starts[1]!),
    } as never,
    { transaction: t },
  );
  await settle(m1, { creditAppliedPaise: cnTax.totalPaise }, starts[1]!, t);
  const tds = percentOf(Number(m1.subtotalPaise), S['billing.tdsMaxRatePct']);
  const tdsOn = addDaysYmd(starts[1]!, 4);
  await PlatformPayment.create(
    {
      societyId: society.id!,
      invoiceId: m1.id!,
      kind: 'TDS',
      origin: 'SOCIETY',
      status: 'CLAIMED',
      method: 'TDS',
      amountPaise: tds,
      appliedPaise: tds,
      tdsSection: '194J',
      tdsRatePct: S['billing.tdsMaxRatePct'],
      deductedOn: tdsOn,
      notes: 'TDS u/s 194J deducted by the society; certificate to follow',
    } as never,
    { transaction: t },
  );
  await settle(m1, { tdsPaise: tds }, tdsOn, t);
  await upiPayment(m1, Number(m1.amountDuePaise), tdsOn, t);

  // current month: open
  await issuePeriodInvoice(c, starts[2]!);
}

async function seedGreenPark(c: SeedCtx, starts: string[]): Promise<void> {
  const { t } = c;
  const m2 = await issuePeriodInvoice(c, starts[0]!);
  await upiPayment(m2, Number(m2.totalPaise), addDaysYmd(starts[0]!, 5), t);

  const m1 = await issuePeriodInvoice(c, starts[1]!);
  const maker = await User.findOne({ where: { mobile: '9000000001' }, transaction: t });
  const checker = await User.findOne({ where: { mobile: '9000000003' }, transaction: t });
  const receivedOn = addDaysYmd(starts[1]!, 6);
  const utr = `HDFCN${starts[1]!.replace(/-/g, '')}0042`;
  await PlatformPayment.create(
    {
      societyId: c.society.id!,
      invoiceId: m1.id!,
      kind: 'PAYMENT',
      origin: 'PLATFORM',
      status: 'CAPTURED',
      method: 'NEFT',
      amountPaise: Number(m1.totalPaise),
      appliedPaise: Number(m1.totalPaise),
      bankReference: utr,
      bankRefKey: `NEFT:${utr}`,
      payerBankName: 'HDFC Bank',
      receivedOn,
      capturedAt: zonedDayStart(addDaysYmd(receivedOn, 1)),
      createdBy: maker?.id ?? null,
      approvedBy: checker?.id ?? null,
      approvedAt: zonedDayStart(addDaysYmd(receivedOn, 1)),
      notes: 'NEFT from the society current account',
    } as never,
    { transaction: t },
  );
  await settle(m1, { paidPaise: Number(m1.totalPaise) }, receivedOn, t);

  await issuePeriodInvoice(c, starts[2]!);
}

const DEMO: Array<{ slug: string; run: (c: SeedCtx, starts: string[]) => Promise<void> }> = [
  { slug: 'sky-heights', run: seedSkyHeights },
  { slug: 'green-park', run: seedGreenPark },
];

export async function seedPlatformBilling(): Promise<{ created: string[]; skipped: string[] }> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('demo platform billing must not run in production');
  const created: string[] = [];
  const skipped: string[] = [];
  const thisMonth = `${istDate(now()).slice(0, 8)}01`;
  const starts = [-2, -1, 0].map(m => addMonthsAnchored(thisMonth, 1, m));
  for (const d of DEMO) {
    const society = await Society.findOne({ where: { slug: d.slug } });
    const sub = society
      ? await Subscription.findOne({ where: { societyId: society.id!, status: 'ACTIVE' } })
      : null;
    if (!society || !sub) continue;
    if (await PlatformInvoice.findOne({ where: { societyId: society.id!, invoiceKind: 'PERIOD' } })) {
      skipped.push(d.slug);
      continue;
    }
    const version = (await PlanVersion.findByPk(sub.planVersionId))!;
    const plan = (await Plan.findByPk(sub.planId))!;
    await sequelize.transaction(async t => {
      await Society.findByPk(society.id!, { transaction: t, lock: t.LOCK.UPDATE });
      await d.run({ society, sub, version, planKey: plan.code, t }, starts);
    });
    created.push(d.slug);
  }
  return { created, skipped };
}
