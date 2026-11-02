/**
 * Module 06 invoicing (sections 5.1, 5.2, 6.1, 6.2, 6.7, 9.3): PERIOD, PRORATION and ONE_TIME invoices issued on
 * request of module 04 and by the generation job, MANUAL drafts and credit notes with maker-checker. Every function
 * runs inside the caller's transaction and locks the society row first (BR-06-23). Numbers are taken at issue
 * (BR-06-17); issued documents are never edited, only settled (BR-06-18).
 */
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { Plan, PlatformInvoice, PlatformInvoiceLine, Society, Subscription, sequelize } from '../../models';
import type { InvoiceKind } from '../../models/platform-invoice.model';
import { now } from '../../lib/clock';
import { enqueueAfterCommit } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { financialYearOf, nextNumber } from '../../utils/numberSequences';
import type { Ctx } from '../../types/context';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { CREDIT_NOTE_SERIES, INVOICE_SERIES } from './platform-billing.constants';
import { notifySubscriptionViewers } from './platform-billing.notify';
import { billingSettings, type BillingSettings } from './platform-billing.settings';
import {
  addDaysYmd,
  buildOneTimeLine,
  buildPeriodLines,
  buildProrationLines,
  computeTax,
  creditNoteAmounts,
  creditNoteDeadline,
  manualLineAmount,
  placeOfSupply,
  subtotalOf,
  type BillingSnapshot,
  type DocumentAmounts,
  type LineDraft,
  type ProrationItemInput,
} from './pricing';
import {
  afterSettlement,
  applyCredits,
  emitBillingChanged,
  lockSociety,
  postCredit,
  settleInvoice,
  todayIst,
} from './platform-billing.settlement';
import {
  invoiceDto,
  type CreditNoteInput,
  type ManualInvoiceInput,
  type PlatformInvoiceDto,
} from './platform-billing.types';

export const PLATFORM_BILLING_QUEUE = 'platform-billing';
export const RENDER_PDF_JOB = 'platform-billing:render-pdf';

const num = (v: unknown): number => Number(v ?? 0);
const actorId = (ctx: Ctx): number | null => ctx.user?.id ?? null;

export const invoiceNotFound = () =>
  new NotFoundError('PLATFORM_INVOICE_NOT_FOUND', 'Invoice or credit note not found');
const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);

// ------------------------------------------------------------------ snapshots (BR-06-19)
const supplierOf = (s: BillingSettings) => ({
  supplierLegalName: s['company.legalName'],
  supplierGstin: s['company.gstin'],
  supplierStateCode: s['company.stateCode'],
  supplierAddress: s['company.address'],
});

/** Buyer snapshot and place of supply (BR-06-14, BR-06-19). */
export function buyerOf(society: Society, companyStateCode: string) {
  const pos = placeOfSupply({ gstin: society.gstin, state: society.state }, companyStateCode);
  return {
    billingName: (society.legalName ?? society.name).slice(0, 200),
    billingGstin: society.gstin ?? null,
    billingAddress: [society.addressLine1, society.addressLine2, society.city, society.pincode]
      .filter(Boolean)
      .join(', ')
      .slice(0, 400),
    billingStateName: society.state.slice(0, 60),
    placeOfSupplyStateCode: pos.stateCode,
    taxType: pos.taxType,
  };
}

/** Module 04 `previewTax` (quote): the GST a new invoice of this subtotal would carry today. */
export async function previewTax(societyId: number, subtotalPaise: number) {
  const society = await Society.findByPk(societyId);
  if (!society) return null;
  const s = await billingSettings();
  const b = buyerOf(society, s['company.stateCode']);
  const tax = computeTax(subtotalPaise, b.taxType, s['billing.gstRatePct']);
  return {
    mode: b.taxType,
    cgstPaise: tax.cgstPaise,
    sgstPaise: tax.sgstPaise,
    igstPaise: tax.igstPaise,
  };
}

async function writeLines(
  ctx: Ctx,
  inv: PlatformInvoice,
  lines: LineDraft[],
  sacCode: string,
  t: Transaction,
): Promise<PlatformInvoiceLine[]> {
  const out: PlatformInvoiceLine[] = [];
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    out.push(
      await PlatformInvoiceLine.create(
        {
          societyId: inv.societyId,
          invoiceId: inv.id!,
          lineNo,
          lineType: l.lineType,
          description: l.description.slice(0, 300),
          sacCode,
          quantity: String(l.quantity),
          unitPricePaise: l.unitPricePaise,
          amountPaise: l.amountPaise,
          planVersionId: l.planVersionId ?? null,
          addonKey: l.addonKey ?? null,
          limitKey: l.limitKey ?? null,
          servicePeriodStart: l.servicePeriodStart ?? null,
          servicePeriodEnd: l.servicePeriodEnd ?? null,
          prorationDays: l.prorationDays ?? null,
          periodDays: l.periodDays ?? null,
          createdBy: actorId(ctx),
        } as never,
        { transaction: t },
      ),
    );
  }
  return out;
}

/** After commit: the PDF job (task 6.x renders it; until then the document stays `pdfStatus = PENDING`). */
function enqueuePdf(t: Transaction, inv: PlatformInvoice, originalInvoiceNo: string | null = null): void {
  const credit = inv.documentType === 'CREDIT_NOTE';
  notifySubscriptionViewers(
    t,
    credit ? 'platform_billing.credit_note_issued' : 'platform_billing.invoice_issued',
    inv.societyId,
    {
      invoiceNo: inv.invoiceNo,
      totalPaise: num(inv.totalPaise),
      dueDate: inv.dueDate,
      societyName: inv.billingName,
      originalInvoiceNo,
      link: '/settings/subscription',
    },
  );
  enqueueAfterCommit(
    t,
    PLATFORM_BILLING_QUEUE,
    RENDER_PDF_JOB,
    { invoiceId: inv.id! },
    { jobId: `pdf-${inv.id}` },
  );
}

async function auditIssued(ctx: Ctx, inv: PlatformInvoice, t: Transaction): Promise<void> {
  await audit(
    ctx,
    {
      action:
        inv.documentType === 'CREDIT_NOTE'
          ? 'platform_billing.credit_note.issued'
          : 'platform_billing.invoice.issued',
      entityType: 'platform_invoice',
      entityId: inv.id!,
      entityLabel: inv.invoiceNo,
      societyId: inv.societyId,
      after: {
        invoiceNo: inv.invoiceNo,
        documentType: inv.documentType,
        invoiceKind: inv.invoiceKind,
        originalInvoiceId: inv.originalInvoiceId,
        subtotalPaise: num(inv.subtotalPaise),
        taxPaise: num(inv.taxPaise),
        totalPaise: num(inv.totalPaise),
        dueDate: inv.dueDate,
      },
    },
    t,
  );
}

/**
 * BR-06-2 / 8 / 9: an existing document with the dedupe key. A plain read: a locking read of a missing key would take
 * a gap lock, and two issuers of different keys holding the same gap deadlock on their inserts. A concurrent commit
 * this read misses is caught by the unique key in `issueSystemInvoice`.
 */
async function byDedupeKey(dedupeKey: string, t: Transaction): Promise<PlatformInvoice | null> {
  return PlatformInvoice.findOne({ where: { dedupeKey }, transaction: t });
}

interface IssueInput {
  society: Society;
  kind: Exclude<InvoiceKind, 'MANUAL'>;
  subscriptionId: number;
  dedupeKey: string;
  lines: LineDraft[];
  periodStart?: string | null;
  periodEnd?: string | null;
  planKey?: string | null;
  billingCycle?: 'MONTHLY' | 'ANNUAL' | null;
}

/**
 * Inserts an ISSUED system invoice with its lines (6.7): number, due date and `suspendOn` from settings, then
 * `applyCredits` and BR-06-40. Returns null when the subtotal is not positive (BR-06-8, BR-06-12).
 */
async function issueSystemInvoice(
  ctx: Ctx,
  input: IssueInput,
  t: Transaction,
): Promise<{ inv: PlatformInvoice | null; created: boolean }> {
  const subtotal = subtotalOf(input.lines);
  if (subtotal <= 0) {
    logger.info({ dedupeKey: input.dedupeKey, subtotal }, 'platform invoice not issued: nothing to invoice');
    return { inv: null, created: false };
  }
  const s = await billingSettings();
  const buyer = buyerOf(input.society, s['company.stateCode']);
  const amounts = computeTax(subtotal, buyer.taxType, s['billing.gstRatePct']);
  const issueDate = todayIst();
  const dueDate = addDaysYmd(issueDate, s['billing.netTermsDays']);
  let inv: PlatformInvoice;
  try {
    // savepoint: when a concurrent issuer committed the same dedupe key, the number goes back with the insert
    inv = await sequelize.transaction({ transaction: t }, async sp => {
      const invoiceNo = await nextNumber(0, INVOICE_SERIES, { date: issueDate, transaction: sp });
      return PlatformInvoice.create(
        {
          societyId: input.society.id!,
          subscriptionId: input.subscriptionId,
          documentType: 'INVOICE',
          invoiceKind: input.kind,
          originalInvoiceId: null,
          dedupeKey: input.dedupeKey,
          invoiceNo,
          financialYear: financialYearOf(issueDate),
          status: 'ISSUED',
          issueDate,
          dueDate,
          suspendOn: addDaysYmd(dueDate, s['billing.suspendAfterDays']),
          periodStart: input.periodStart ?? null,
          periodEnd: input.periodEnd ?? null,
          planKey: input.planKey ?? null,
          billingCycle: input.billingCycle ?? null,
          ...supplierOf(s),
          ...buyer,
          gstRatePct: s['billing.gstRatePct'],
          sacCode: s['billing.sacCode'],
          ...amounts,
          amountDuePaise: amounts.totalPaise,
          issuedAt: now(),
          pdfStatus: 'PENDING',
          createdBy: actorId(ctx),
          updatedBy: actorId(ctx),
          version: 1,
        } as never,
        { transaction: sp },
      );
    });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const existing = await PlatformInvoice.findOne({
      where: { dedupeKey: input.dedupeKey },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!existing) throw err;
    return { inv: existing, created: false };
  }
  await writeLines(ctx, inv, input.lines, s['billing.sacCode'], t);
  await auditIssued(ctx, inv, t);
  enqueuePdf(t, inv);
  emitBillingChanged(t, inv.societyId, inv.id!);
  await settleWithCredits(ctx, inv.societyId, t);
  await inv.reload({ transaction: t });
  return { inv, created: true };
}

/** BR-06-26 then, when credit settled anything, BR-06-40. */
async function settleWithCredits(
  ctx: Ctx,
  societyId: number,
  t: Transaction,
  alsoPaid: PlatformInvoice[] = [],
) {
  const r = await applyCredits(ctx, societyId, t);
  if (r.applied > 0 || alsoPaid.length) await afterSettlement(ctx, societyId, [...alsoPaid, ...r.paid], t);
}

async function loadSub(subscriptionId: number, t: Transaction): Promise<Subscription> {
  const sub = await Subscription.findByPk(subscriptionId, { transaction: t });
  if (!sub) throw new NotFoundError('SUBSCRIPTION_NOT_FOUND', 'No subscription found');
  return sub;
}

async function planKeyOf(sub: Subscription, t: Transaction): Promise<string | null> {
  const plan = await Plan.findByPk(sub.planId, { attributes: ['id', 'code'], transaction: t });
  return plan?.code ?? null;
}

/** PLAN quantity of the PERIOD invoice of the previous period (BR-06-6 `billed`), null when there is none. */
async function previousBilledFlats(
  subscriptionId: number,
  previousPeriodStart: string,
  t: Transaction,
): Promise<number | null> {
  const prev = await PlatformInvoice.findOne({
    attributes: ['id'],
    where: { dedupeKey: `PERIOD:${subscriptionId}:${previousPeriodStart}` },
    transaction: t,
  });
  if (!prev) return null;
  const plan = await PlatformInvoiceLine.findOne({
    where: { invoiceId: prev.id!, lineType: 'PLAN' },
    transaction: t,
  });
  return plan ? Math.round(Number(plan.quantity)) : null;
}

// ------------------------------------------------------------------ 9.3 functions module 04 calls
/**
 * BR-06-1 to BR-06-7, 6.7: the PERIOD invoice of `periodStart`. A second call for the same period returns the
 * existing invoice and changes nothing (BR-06-2). Null when the subtotal is 0 (BR-06-12).
 */
export async function issuePeriodInvoice(
  ctx: Ctx,
  input: { subscriptionId: number; periodStart: string },
  t: Transaction,
): Promise<PlatformInvoiceDto | null> {
  return (await issuePeriod(ctx, input, t)).invoice;
}

/** `issuePeriodInvoice` that also tells whether this call created the invoice (the generation job counts it). */
export async function issuePeriod(
  ctx: Ctx,
  input: { subscriptionId: number; periodStart: string },
  t: Transaction,
): Promise<{ invoice: PlatformInvoiceDto | null; created: boolean }> {
  const sub = await loadSub(input.subscriptionId, t);
  const society = await lockSociety(sub.societyId, t);
  const dedupeKey = `PERIOD:${input.subscriptionId}:${input.periodStart}`;
  const existing = await byDedupeKey(dedupeKey, t);
  if (existing) return { invoice: invoiceDto(existing), created: false };
  const snap = (await subscriptions.getBillingSnapshot(
    input.subscriptionId,
    input.periodStart,
    t,
  )) as BillingSnapshot;
  const billed = snap.previousPeriod
    ? await previousBilledFlats(input.subscriptionId, snap.previousPeriod.periodStart, t)
    : null;
  const r = await issueSystemInvoice(
    ctx,
    {
      society,
      kind: 'PERIOD',
      subscriptionId: input.subscriptionId,
      dedupeKey,
      lines: buildPeriodLines(snap, billed),
      periodStart: snap.periodStart,
      periodEnd: snap.periodEnd,
      planKey: snap.planKey,
      billingCycle: snap.billingCycle,
    },
    t,
  );
  return { invoice: r.inv ? invoiceDto(r.inv) : null, created: r.created };
}

/** BR-06-8: proration of a mid-period upgrade or recurring add-on; null when the subtotal is ≤ 0. */
export async function issueProrationInvoice(
  ctx: Ctx,
  input: { subscriptionId: number; changeRef: string; effectiveDate: string; items: ProrationItemInput[] },
  t: Transaction,
): Promise<PlatformInvoiceDto | null> {
  const sub = await loadSub(input.subscriptionId, t);
  const society = await lockSociety(sub.societyId, t);
  const dedupeKey = `PRORATION:${input.changeRef}`;
  const existing = await byDedupeKey(dedupeKey, t);
  if (existing) return invoiceDto(existing);
  if (!sub.currentPeriodStart || !sub.currentPeriodEnd)
    throw invalidState('The subscription has no current period to prorate');
  if (input.effectiveDate < sub.currentPeriodStart || input.effectiveDate > sub.currentPeriodEnd)
    throw new UnprocessableError('VALIDATION_FAILED', 'The effective date is outside the current period');
  const lines = buildProrationLines({
    items: input.items,
    effectiveDate: input.effectiveDate,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
  });
  const { inv } = await issueSystemInvoice(
    ctx,
    {
      society,
      kind: 'PRORATION',
      subscriptionId: sub.id!,
      dedupeKey,
      lines,
      periodStart: input.effectiveDate,
      periodEnd: sub.currentPeriodEnd,
      planKey: await planKeyOf(sub, t),
      billingCycle: sub.billingCycle,
    },
    t,
  );
  return inv ? invoiceDto(inv) : null;
}

/**
 * BR-06-9: add-on pack or monthly overage of an annual subscription; idempotent on `purchaseRef`. Module 04's
 * `lineType: 'ADDON'` means ONE_TIME. For OVERAGE `addonKey` is ignored and `limitKey` defaults to the last segment
 * of `OVERAGE:<subscriptionId>:<periodKey>:<limitKey>`. Null only when the amount is 0.
 */
export async function issueOneTimeInvoice(
  ctx: Ctx,
  input: {
    subscriptionId: number;
    purchaseRef: string;
    addonKey?: string;
    label: string;
    quantity: number;
    unitPricePaise: number;
    lineType?: 'ONE_TIME' | 'ADDON' | 'OVERAGE';
    limitKey?: string;
  },
  t: Transaction,
): Promise<PlatformInvoiceDto | null> {
  const sub = await loadSub(input.subscriptionId, t);
  const society = await lockSociety(sub.societyId, t);
  const dedupeKey = `ONE_TIME:${input.purchaseRef}`.slice(0, 80);
  const existing = await byDedupeKey(dedupeKey, t);
  if (existing) return invoiceDto(existing);
  const lineType = input.lineType === 'OVERAGE' ? 'OVERAGE' : 'ONE_TIME';
  const limitKey =
    lineType === 'OVERAGE' ? (input.limitKey ?? input.purchaseRef.split(':').pop() ?? null) : null;
  const { inv } = await issueSystemInvoice(
    ctx,
    {
      society,
      kind: 'ONE_TIME',
      subscriptionId: sub.id!,
      dedupeKey,
      lines: buildOneTimeLine({
        lineType,
        label: input.label,
        quantity: input.quantity,
        unitPricePaise: input.unitPricePaise,
        addonKey: input.addonKey ?? null,
        limitKey,
      }),
      planKey: await planKeyOf(sub, t),
      billingCycle: sub.billingCycle,
    },
    t,
  );
  return inv ? invoiceDto(inv) : null;
}

/** Module 04 platform add-on list: Σ add-on line amounts on invoices issued this IST month (not void). */
export async function addonRevenueThisMonth(addonCode: string): Promise<number> {
  const monthStart = `${todayIst().slice(0, 8)}01`;
  const [rows] = await sequelize.query(
    `SELECT COALESCE(SUM(l.amountPaise), 0) AS total
       FROM platform_invoice_lines l JOIN platform_invoices i ON i.id = l.invoiceId
      WHERE l.addonKey = ? AND l.lineType IN ('ADDON','ONE_TIME','PRORATION')
        AND i.documentType = 'INVOICE' AND i.status NOT IN ('DRAFT','REJECTED','VOID')
        AND i.issueDate >= ?`,
    { replacements: [addonCode, monthStart] },
  );
  return Number((rows as { total: number | string }[])[0]?.total ?? 0);
}

// ------------------------------------------------------------------ manual invoices (BR-06-10, 8.12)
const MAX_MANUAL_LINE_PAISE = 100_000_000;

/** Creates a MANUAL invoice DRAFT without a number (computed totals, buyer snapshot of today). */
export async function createManualInvoice(ctx: Ctx, input: ManualInvoiceInput): Promise<PlatformInvoiceDto> {
  if (!input.lines.length || input.lines.length > 20)
    throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
      { field: 'lines', message: '1 to 20 lines' },
    ]);
  const lines: LineDraft[] = input.lines.map((l, i) => {
    const amountPaise = manualLineAmount(l.quantity, l.unitPricePaise);
    if (amountPaise < 1 || amountPaise > MAX_MANUAL_LINE_PAISE)
      throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
        { field: `lines.${i}.unitPricePaise`, message: 'Line amount must be ₹0.01 to ₹10,00,000' },
      ]);
    return {
      lineType: 'MANUAL',
      description: l.description,
      quantity: Number(l.quantity),
      unitPricePaise: l.unitPricePaise,
      amountPaise,
      servicePeriodStart: input.serviceDate ?? null,
      servicePeriodEnd: input.serviceDate ?? null,
    };
  });
  const subtotal = subtotalOf(lines);
  if (subtotal <= 0) throw new UnprocessableError('NOTHING_TO_INVOICE', 'The invoice subtotal is 0');
  return sequelize.transaction(async t => {
    const society = await lockSociety(input.societyId, t);
    if (society.status === 'CLOSED' && society.purgedAt)
      throw new NotFoundError('NOT_FOUND', 'Society not found');
    if (input.subscriptionId) {
      const sub = await Subscription.findByPk(input.subscriptionId, { transaction: t });
      if (!sub || sub.societyId !== society.id)
        throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
          { field: 'subscriptionId', message: 'Not a subscription of this society' },
        ]);
    }
    const s = await billingSettings();
    const buyer = buyerOf(society, s['company.stateCode']);
    const inv = await PlatformInvoice.create(
      {
        societyId: society.id!,
        subscriptionId: input.subscriptionId ?? null,
        documentType: 'INVOICE',
        invoiceKind: 'MANUAL',
        status: 'DRAFT',
        ...supplierOf(s),
        ...buyer,
        gstRatePct: s['billing.gstRatePct'],
        sacCode: s['billing.sacCode'],
        ...computeTax(subtotal, buyer.taxType, s['billing.gstRatePct']),
        amountDuePaise: 0,
        notes: input.notes ?? null,
        pdfStatus: 'PENDING',
        createdBy: actorId(ctx),
        updatedBy: actorId(ctx),
        version: 1,
      } as never,
      { transaction: t },
    );
    const rows = await writeLines(ctx, inv, lines, s['billing.sacCode'], t);
    await audit(
      ctx,
      {
        action: 'platform_billing.invoice.drafted',
        entityType: 'platform_invoice',
        entityId: inv.id!,
        societyId: society.id!,
        after: { invoiceKind: 'MANUAL', subtotalPaise: subtotal, lines: lines.length },
      },
      t,
    );
    return invoiceDto(inv, rows);
  });
}

// ------------------------------------------------------------------ credit notes (BR-06-20, 8.13)
async function creditNotesOf(
  invoiceId: number,
  statuses: string[],
  excludeId: number | null,
  t: Transaction,
) {
  return PlatformInvoice.findAll({
    where: {
      originalInvoiceId: invoiceId,
      documentType: 'CREDIT_NOTE',
      status: statuses,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
    transaction: t,
  });
}
const sumOf = (rows: PlatformInvoice[], k: 'subtotalPaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise') =>
  rows.reduce((a, r) => a + num(r[k]), 0);

const CREDITABLE = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'PAID'];

function assertCreditable(inv: PlatformInvoice, today: string): void {
  if (inv.documentType !== 'INVOICE' || !CREDITABLE.includes(inv.status))
    throw invalidState('A credit note needs an issued, unpaid, overdue or paid invoice');
  if (today > creditNoteDeadline(inv.financialYear!))
    throw new UnprocessableError(
      'CREDIT_NOTE_TIME_BARRED',
      `Credit notes for ${inv.financialYear} invoices had to be issued by ${creditNoteDeadline(inv.financialYear!)}`,
    );
}

/** Credit note amounts for `subtotalPaise`, given the other credit notes counted against the invoice. */
function cnAmounts(inv: PlatformInvoice, others: PlatformInvoice[], subtotalPaise: number): DocumentAmounts {
  const credited = sumOf(others, 'subtotalPaise');
  if (subtotalPaise < 1 || credited + subtotalPaise > num(inv.subtotalPaise))
    throw new UnprocessableError(
      'CREDIT_NOTE_EXCEEDS_INVOICE',
      `At most ${num(inv.subtotalPaise) - credited} paise can still be credited on ${inv.invoiceNo}`,
    );
  return creditNoteAmounts({
    invoice: {
      subtotalPaise: num(inv.subtotalPaise),
      cgstPaise: num(inv.cgstPaise),
      sgstPaise: num(inv.sgstPaise),
      igstPaise: num(inv.igstPaise),
      taxPaise: num(inv.taxPaise),
      totalPaise: num(inv.totalPaise),
      taxType: inv.taxType,
      gstRatePct: String(inv.gstRatePct),
    },
    creditedSubtotalPaise: credited,
    creditedTax: {
      cgstPaise: sumOf(others, 'cgstPaise'),
      sgstPaise: sumOf(others, 'sgstPaise'),
      igstPaise: sumOf(others, 'igstPaise'),
    },
    subtotalPaise,
  });
}

/** Locks the society, then the document (BR-06-23); 404 when unknown. */
async function lockDocument(id: number, t: Transaction): Promise<{ society: Society; doc: PlatformInvoice }> {
  const pre = await PlatformInvoice.findByPk(id, { attributes: ['id', 'societyId'], transaction: t });
  if (!pre) throw invoiceNotFound();
  const society = await lockSociety(pre.societyId, t);
  const doc = await PlatformInvoice.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!doc) throw invoiceNotFound();
  return { society, doc };
}

/** 8.13: a CREDIT_NOTE draft with one line, tax per BR-06-20 (issued and draft credit notes count against the limit). */
export async function createCreditNote(
  ctx: Ctx,
  invoiceId: number,
  input: CreditNoteInput,
): Promise<PlatformInvoiceDto> {
  return sequelize.transaction(async t => {
    const { doc: inv } = await lockDocument(invoiceId, t);
    assertCreditable(inv, todayIst());
    const others = await creditNotesOf(inv.id!, ['DRAFT', 'ISSUED'], null, t);
    const amounts = cnAmounts(inv, others, input.subtotalPaise);
    const cn = await PlatformInvoice.create(
      {
        societyId: inv.societyId,
        subscriptionId: inv.subscriptionId,
        documentType: 'CREDIT_NOTE',
        invoiceKind: null,
        originalInvoiceId: inv.id!,
        status: 'DRAFT',
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        planKey: inv.planKey,
        billingCycle: inv.billingCycle,
        supplierLegalName: inv.supplierLegalName,
        supplierGstin: inv.supplierGstin,
        supplierStateCode: inv.supplierStateCode,
        supplierAddress: inv.supplierAddress,
        billingName: inv.billingName,
        billingGstin: inv.billingGstin,
        billingAddress: inv.billingAddress,
        billingStateName: inv.billingStateName,
        placeOfSupplyStateCode: inv.placeOfSupplyStateCode,
        taxType: inv.taxType,
        gstRatePct: inv.gstRatePct,
        sacCode: inv.sacCode,
        ...amounts,
        amountDuePaise: 0,
        creditNoteReason: input.reason,
        notes: input.notes,
        pdfStatus: 'PENDING',
        createdBy: actorId(ctx),
        updatedBy: actorId(ctx),
        version: 1,
      } as never,
      { transaction: t },
    );
    const reason = input.reason.toLowerCase().replace(/_/g, ' ');
    const rows = await writeLines(
      ctx,
      cn,
      [
        {
          lineType: 'CREDIT_NOTE',
          description: `Credit against ${inv.invoiceNo}: ${reason}`,
          quantity: 1,
          unitPricePaise: input.subtotalPaise,
          amountPaise: input.subtotalPaise,
          servicePeriodStart: inv.periodStart,
          servicePeriodEnd: inv.periodEnd,
        },
      ],
      inv.sacCode,
      t,
    );
    await audit(
      ctx,
      {
        action: 'platform_billing.credit_note.drafted',
        entityType: 'platform_invoice',
        entityId: cn.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        after: { originalInvoiceId: inv.id, reason: input.reason, ...amounts },
      },
      t,
    );
    return invoiceDto(cn, rows);
  });
}

// ------------------------------------------------------------------ approve / reject drafts (8.14)
function assertDecidable(ctx: Ctx, doc: PlatformInvoice, version: number): void {
  if (doc.status !== 'DRAFT') throw invalidState('Only a draft can be approved or rejected');
  if (doc.version !== version)
    throw new ConflictError('STALE_VERSION', 'Someone else changed this document. Reload to see the change.');
  if (!ctx.user || doc.createdBy === ctx.user.id)
    throw new ConflictError('MAKER_CHECKER_VIOLATION', 'A second person must approve this');
}

/** Numbers and issues a MANUAL invoice draft (snapshot and tax of the approval day). */
async function issueManualDraft(ctx: Ctx, society: Society, inv: PlatformInvoice, t: Transaction) {
  const s = await billingSettings();
  const buyer = buyerOf(society, s['company.stateCode']);
  const amounts = computeTax(num(inv.subtotalPaise), buyer.taxType, s['billing.gstRatePct']);
  const issueDate = todayIst();
  const dueDate = addDaysYmd(issueDate, s['billing.netTermsDays']);
  inv.set({
    invoiceNo: await nextNumber(0, INVOICE_SERIES, { date: issueDate, transaction: t }),
    financialYear: financialYearOf(issueDate),
    status: 'ISSUED',
    issueDate,
    dueDate,
    suspendOn: addDaysYmd(dueDate, s['billing.suspendAfterDays']),
    ...supplierOf(s),
    ...buyer,
    gstRatePct: s['billing.gstRatePct'],
    ...amounts,
    amountDuePaise: amounts.totalPaise,
    approvedBy: ctx.user!.id,
    approvedAt: now(),
    issuedAt: now(),
    updatedBy: ctx.user!.id,
    version: inv.version + 1,
  });
  await inv.save({ transaction: t });
  await auditIssued(ctx, inv, t);
  enqueuePdf(t, inv);
  emitBillingChanged(t, inv.societyId, inv.id!);
  await settleWithCredits(ctx, inv.societyId, t);
}

/** Numbers a credit note and settles the original invoice (BR-06-20 re-checked, BR-06-35, VOID when fully credited). */
async function issueCreditNoteDraft(ctx: Ctx, cn: PlatformInvoice, t: Transaction) {
  const orig = await PlatformInvoice.findByPk(cn.originalInvoiceId!, { transaction: t, lock: t.LOCK.UPDATE });
  if (!orig) throw invoiceNotFound();
  const issueDate = todayIst();
  assertCreditable(orig, issueDate);
  const issued = await creditNotesOf(orig.id!, ['ISSUED'], cn.id!, t);
  const drafts = await creditNotesOf(orig.id!, ['DRAFT'], cn.id!, t);
  cnAmounts(orig, [...issued, ...drafts], num(cn.subtotalPaise)); // limit with drafts still counted
  const amounts = cnAmounts(orig, issued, num(cn.subtotalPaise)); // tax: exact remainder against issued notes
  cn.set({
    invoiceNo: await nextNumber(0, CREDIT_NOTE_SERIES, { date: issueDate, transaction: t }),
    financialYear: financialYearOf(issueDate),
    status: 'ISSUED',
    issueDate,
    ...amounts,
    approvedBy: ctx.user!.id,
    approvedAt: now(),
    issuedAt: now(),
    updatedBy: ctx.user!.id,
    version: cn.version + 1,
  });
  await cn.save({ transaction: t });
  const dueBefore = num(orig.amountDuePaise);
  const excess = Math.max(0, amounts.totalPaise - dueBefore);
  const r = await settleInvoice(
    ctx,
    orig,
    { creditNotedPaise: amounts.totalPaise, excessToCreditPaise: excess },
    t,
  );
  if (excess > 0)
    await postCredit(
      ctx,
      { societyId: cn.societyId, entryType: 'CREDIT_NOTE', amountPaise: excess, invoiceId: cn.id! },
      t,
    );
  await auditIssued(ctx, cn, t);
  enqueuePdf(t, cn, orig.invoiceNo);
  // the credit note itself is a settlement change of the original invoice (BR-06-40)
  const r2 = await applyCredits(ctx, cn.societyId, t);
  await afterSettlement(ctx, cn.societyId, [...(r.becamePaid ? [orig] : []), ...r2.paid], t);
}

/** 8.14 approve: a MANUAL invoice draft or a credit note draft. Step-up is checked by the route (task 6.x). */
export async function approveDocument(
  ctx: Ctx,
  id: number,
  input: { version: number },
): Promise<PlatformInvoiceDto> {
  return sequelize.transaction(async t => {
    const { society, doc } = await lockDocument(id, t);
    assertDecidable(ctx, doc, input.version);
    if (doc.documentType === 'CREDIT_NOTE') await issueCreditNoteDraft(ctx, doc, t);
    else await issueManualDraft(ctx, society, doc, t);
    await doc.reload({ transaction: t });
    const lines = await PlatformInvoiceLine.findAll({
      where: { invoiceId: doc.id! },
      order: [['lineNo', 'ASC']],
      transaction: t,
    });
    return invoiceDto(doc, lines);
  });
}

/** 8.14 reject: the draft becomes REJECTED (final; it never had a number, so no gap). */
export async function rejectDocument(
  ctx: Ctx,
  id: number,
  input: { version: number; reason: string },
): Promise<PlatformInvoiceDto> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500)
    throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
      { field: 'reason', message: '10 to 500 characters' },
    ]);
  return sequelize.transaction(async t => {
    const { doc } = await lockDocument(id, t);
    assertDecidable(ctx, doc, input.version);
    doc.set({
      status: 'REJECTED',
      rejectedReason: reason,
      approvedBy: ctx.user!.id,
      approvedAt: now(),
      updatedBy: ctx.user!.id,
      version: doc.version + 1,
    });
    await doc.save({ transaction: t });
    await audit(
      ctx,
      {
        action:
          doc.documentType === 'CREDIT_NOTE'
            ? 'platform_billing.credit_note.rejected'
            : 'platform_billing.invoice.rejected',
        entityType: 'platform_invoice',
        entityId: doc.id!,
        societyId: doc.societyId,
        reason,
        after: { status: 'REJECTED' },
      },
      t,
    );
    return invoiceDto(doc);
  });
}
