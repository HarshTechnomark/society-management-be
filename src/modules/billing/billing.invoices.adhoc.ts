import { ChargeHead, Invoice, InvoiceLine, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { UnprocessableError, ValidationError } from '../../utils/errors';
import { financialYearOf, nextNumber } from '../../utils/numberSequences';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { ensureSeeded } from './billing.heads.service';
import { addDaysYmd } from './billing.calc.period';
import { ownerParty, type LinkRow, type Party } from './billing.calc.segments';
import { AUDIT, type PayerRouting } from './billing.constants';
import { buildDocument, type DocLineInput } from './billing.invoices.build';
import {
  emitInvoiceChanged,
  enqueueRenderPdf,
  notifyBillAfterCommit,
  queueAdvanceApplyAfterCommit,
} from './billing.invoices.effects';
import {
  debitDocumentJournal,
  fundFor,
  gstinOf,
  periodLabelOfInvoice,
  previousDuesOf,
  societyIdOfCall,
} from './billing.invoices.shared';
import { loadInvoiceDetail } from './billing.invoices.detail';
import { unitLedger } from './billing.ledger.service';
import { loadUserHeads } from './billing.notes.debit';
import type { CallCtx } from './billing.notes.shared';
import { billingPorts } from './billing.ports';
import { loadBillingSettings, societyToday } from './billing.runs.shared';
import type { CreateAdHocInput, Transaction } from './billing.types';

/**
 * Ad-hoc invoices (BR-11-48 to BR-11-50, 8.14): `invoices.createAdHoc` for other modules (one head by key, one line) and the
 * admin route (1 to 20 lines). Both go through `issueAdHoc`, which numbers, posts ledger and journal inside the caller's
 * transaction. Side effects (realtime, notification, PDF) run after commit.
 */
export interface AdHocParams {
  unitId: number;
  lines: { head: ChargeHead; description: string; amountPaise: number }[];
  dueDate: string;
  description: string;
  refType: string | null;
  refId: number | null;
  /** The admin route refuses lines that go to different parties (`422 MIXED_BILL_TO`). */
  singleParty: boolean;
}

/** BR-11-9: the party of a head on a date: owner heads go to the owner, the others to the bill-to party. */
export async function partyFor(
  societyId: number,
  unitId: number,
  routing: PayerRouting,
  date: string,
): Promise<Party | null> {
  if (routing === 'OWNER') {
    const links = await residents.listForUnit(societyId, unitId, { relation: ['OWNER', 'CO_OWNER'], date });
    return ownerParty(
      links.map<LinkRow>(l => ({
        linkId: l.linkId,
        residentId: l.residentId,
        name: l.name,
        relation: l.relation,
        isPrimary: l.isPrimary,
        fromDate: l.fromDate,
        toDate: l.toDate,
      })),
    );
  }
  const b = await residents.billToFor(unitId, date);
  return b ? { residentId: b.residentId, relation: b.relation, name: b.name } : null;
}

const noBillTo = () =>
  new UnprocessableError('NO_BILL_TO', 'This flat has no owner or bill-to party', [
    { field: 'unitId', message: 'No owner or bill-to party today' },
  ]);

export async function issueAdHoc(
  ctx: CallCtx,
  societyId: number,
  p: AdHocParams,
  t: Transaction,
): Promise<Invoice> {
  const today = await societyToday(societyId);
  const settings = await loadBillingSettings(societyId);
  const unit = await units.lockActive(societyId, p.unitId, t);
  const parties = new Map<number, Party>();
  const perLine: Party[] = [];
  for (const l of p.lines) {
    const party = await partyFor(societyId, p.unitId, l.head.payerRouting, today);
    if (!party) throw noBillTo();
    parties.set(party.residentId, party);
    perLine.push(party);
  }
  if (p.singleParty && parties.size > 1)
    throw new UnprocessableError('MIXED_BILL_TO', 'These lines go to different people; send two invoices');
  const billTo = perLine[0]!;
  if (await billingPorts().journal.isDateLocked(societyId, today))
    throw new UnprocessableError('PERIOD_LOCKED', 'The books are locked for the invoice date');
  const input: DocLineInput[] = [];
  for (const l of p.lines)
    input.push({
      head: l.head,
      description: l.description,
      amountPaise: l.amountPaise,
      fundId: await fundFor(societyId, l.head, { refType: p.refType, refId: p.refId }),
    });
  const doc = buildDocument(input, {
    applyGst: settings.applyGst,
    exemptLimitPaise: settings.gstExemptLimitPaise,
    roundToRupee: settings.roundToRupee,
    mode: 'ADHOC',
  });
  const userId = ctx.user?.id ?? null;
  const invoiceNo = await nextNumber(societyId, 'INVOICE', {
    date: today,
    prefix: settings.invoicePrefix,
    transaction: t,
  });
  const tax = doc.cgstPaise + doc.sgstPaise;
  const invoice = await Invoice.create(
    {
      societyId,
      invoiceNo,
      financialYear: financialYearOf(today),
      invoiceType: 'ADHOC',
      billingRunId: null,
      dedupeKey: null,
      unitId: p.unitId,
      unitLabel: unit.label,
      billToResidentId: billTo.residentId,
      billToRelation: billTo.relation,
      billToName: billTo.name.slice(0, 150),
      periodStart: null,
      periodEnd: null,
      invoiceDate: today,
      dueDate: p.dueDate,
      description: p.description.slice(0, 300),
      refType: p.refType,
      refId: p.refId,
      societyGstin: tax > 0 ? await gstinOf(societyId, t) : null,
      gstApplied: doc.gstApplied,
      thresholdBasePaise: doc.thresholdBasePaise,
      taxableValuePaise: doc.taxableValuePaise,
      subtotalPaise: doc.subtotalPaise,
      cgstPaise: doc.cgstPaise,
      sgstPaise: doc.sgstPaise,
      taxPaise: tax,
      roundOffPaise: doc.roundOffPaise,
      totalPaise: doc.totalPaise,
      previousDuesPaise: await previousDuesOf(societyId, p.unitId, billTo.residentId, t),
      debitedPaise: 0,
      creditedPaise: 0,
      writtenOffPaise: 0,
      paidPaise: 0,
      outstandingPaise: doc.totalPaise,
      nonInterestBearingPaise: doc.lines
        .filter(l => l.lineKind === 'CHARGE' && !l.interestBearing)
        .reduce((a, l) => a + l.amountPaise, 0),
      status: 'ISSUED',
      settledOn: null,
      isDisputed: false,
      interestPostedToDate: null,
      lateFeeChargedAt: null,
      reminderCount: 0,
      lastReminderAt: null,
      pdfFileId: null,
      pdfStatus: 'PENDING',
      issuedAt: now(),
      cancelledAt: null,
      createdBy: userId,
      updatedBy: userId,
      version: 1,
    } as never,
    { transaction: t },
  );
  let lineNo = 0;
  for (const l of doc.lines)
    await InvoiceLine.create(
      {
        societyId,
        invoiceId: Number(invoice.id),
        billingNoteId: null,
        lineNo: ++lineNo,
        lineKind: l.lineKind,
        chargeHeadId: l.chargeHeadId,
        headKey: l.headKey,
        description: l.description,
        quantity: null,
        ratePaise: null,
        amountPaise: l.amountPaise,
        isTaxable: l.isTaxable,
        billingRuleVersionId: null,
        periodFrom: null,
        periodTo: null,
        prorationDays: null,
        periodDays: null,
        refInvoiceLineId: null,
        computation: null,
        ledgerAccountCode: l.ledgerAccountCode,
        creditedPaise: 0,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction: t },
    );
  await unitLedger.post(
    ctx,
    {
      unitId: p.unitId,
      entryType: 'INVOICE',
      refType: 'invoice',
      refId: Number(invoice.id),
      debitPaise: doc.totalPaise,
      creditPaise: 0,
      date: today,
      narration: `Invoice ${invoiceNo}`,
    },
    t,
  );
  await billingPorts().journal.post(
    ctx as never,
    {
      date: today,
      voucherType: 'INVOICE',
      refType: 'invoice',
      refId: Number(invoice.id),
      narration: `Invoice ${invoiceNo} ${unit.label}`,
      lines: debitDocumentJournal(p.unitId, doc.totalPaise, doc.lines),
    },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.invoiceCreatedAdhoc,
      entityType: 'invoice',
      entityId: Number(invoice.id),
      entityLabel: invoiceNo,
      societyId,
      after: { unitId: p.unitId, totalPaise: doc.totalPaise, refType: p.refType, refId: p.refId },
    },
    t,
  );
  emitInvoiceChanged(t, { ...invoice.get(), societyId });
  enqueueRenderPdf(t, { kind: 'invoice', id: Number(invoice.id), societyId });
  notifyBillAfterCommit(
    t,
    'billing.invoice_issued',
    { societyId, unitId: p.unitId, residentId: billTo.residentId, relation: billTo.relation, date: today },
    {
      invoiceNo,
      amountPaise: doc.totalPaise,
      dueDate: p.dueDate,
      periodLabel: periodLabelOfInvoice(invoice),
    },
  );
  return invoice;
}

// ------------------------------------------------------------------ invoices.createAdHoc (BR-11-48)

const REF_TYPE = /^[a-z_]{2,40}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function createAdHoc(
  ctx: CallCtx,
  input: CreateAdHocInput,
  t: Transaction,
): Promise<{ invoiceId: number; invoiceNo: string; totalPaise: number }> {
  const errors = [];
  if (!Number.isSafeInteger(input.unitId) || input.unitId < 1)
    errors.push({ field: 'unitId', message: 'Must be a positive whole number' });
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < 1 || input.amountPaise > 100_000_000)
    errors.push({ field: 'amountPaise', message: 'Between 1 and 100,000,000 paise' });
  if (typeof input.refType !== 'string' || !REF_TYPE.test(input.refType))
    errors.push({ field: 'refType', message: 'Use lower-case letters and underscores, 2 to 40 characters' });
  if (!Number.isSafeInteger(input.refId) || input.refId < 1)
    errors.push({ field: 'refId', message: 'Must be a positive whole number' });
  if (typeof input.chargeHeadKey !== 'string' || !input.chargeHeadKey)
    errors.push({ field: 'chargeHeadKey', message: 'Required' });
  if (typeof input.dueDate !== 'string' || !YMD.test(input.dueDate))
    errors.push({ field: 'dueDate', message: 'Use YYYY-MM-DD' });
  if (errors.length) throw new ValidationError(errors);
  const societyId = await societyIdOfCall(ctx, input.unitId);
  const today = await societyToday(societyId);
  if (input.dueDate < today)
    throw new ValidationError([{ field: 'dueDate', message: 'The due date cannot be in the past' }]);
  let head = await ChargeHead.findOne({ where: { societyId, key: input.chargeHeadKey }, transaction: t });
  if (!head) {
    await ensureSeeded(societyId, t);
    head = await ChargeHead.findOne({ where: { societyId, key: input.chargeHeadKey }, transaction: t });
  }
  if (!head || head.isSystem)
    throw new UnprocessableError(
      'CHARGE_HEAD_NOT_ALLOWED',
      'This charge head cannot be used for an ad-hoc invoice',
      [{ field: 'chargeHeadKey', message: 'Unknown or system head' }],
    );
  if (head.status !== 'ACTIVE')
    throw new UnprocessableError('CHARGE_HEAD_ARCHIVED', 'This charge head is archived');
  const inv = await issueAdHoc(
    ctx,
    societyId,
    {
      unitId: input.unitId,
      lines: [{ head, description: head.name, amountPaise: input.amountPaise }],
      dueDate: input.dueDate,
      description: head.name,
      refType: input.refType,
      refId: input.refId,
      singleParty: true,
    },
    t,
  );
  return { invoiceId: Number(inv.id), invoiceNo: inv.invoiceNo, totalPaise: Number(inv.totalPaise) };
}

// ------------------------------------------------------------------ 8.14

export async function createAdHocInvoice(
  ctx: CallCtx,
  input: {
    unitId: number;
    lines: { chargeHeadId: number; description: string; amountPaise: number }[];
    dueDate: string;
    description: string;
  },
) {
  const societyId = await societyIdOfCall(ctx);
  const today = await societyToday(societyId);
  if (input.dueDate < today || input.dueDate > addDaysYmd(today, 365))
    throw new ValidationError([{ field: 'dueDate', message: 'Today up to one year ahead' }]);
  const invoiceId = await sequelize.transaction(async t => {
    const heads = await loadUserHeads(
      societyId,
      input.lines.map(l => l.chargeHeadId),
      t,
    );
    const inv = await issueAdHoc(
      ctx,
      societyId,
      {
        unitId: input.unitId,
        lines: input.lines.map(l => ({
          head: heads.get(l.chargeHeadId)!,
          description: l.description,
          amountPaise: l.amountPaise,
        })),
        dueDate: input.dueDate,
        description: input.description,
        refType: null,
        refId: null,
        singleParty: true,
      },
      t,
    );
    queueAdvanceApplyAfterCommit(t, societyId, [input.unitId]);
    return Number(inv.id);
  });
  return loadInvoiceDetail(societyId, invoiceId);
}
