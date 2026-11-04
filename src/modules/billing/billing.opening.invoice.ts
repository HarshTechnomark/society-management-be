import { UniqueConstraintError } from 'sequelize';
import { BillingNote, ChargeHead, Invoice, InvoiceLine } from '../../models';
import { istDate, now } from '../../lib/clock';
import { financialYearOf, nextNumber } from '../../utils/numberSequences';
import { NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { unitLedger } from './billing.ledger.service';
import { ACCOUNT, OPENING_ARREARS_HEAD, OPENING_INTEREST_HEAD } from './billing.ledger.types';
import type { Transaction, YmdString } from './billing.types';

/**
 * MINIMAL internal helper of sub-module 11.2 (BR-11-66, BR-11-71): the `OPENING` arrears invoice of one flat and the direct
 * `CANCELLATION` credit note that closes it when an opening balance is reversed. It exists only so opening balances can
 * be posted and reversed; the general issue core (billing runs, ad-hoc invoices, credit and debit note routes, PDFs) is
 * 11.3 and 11.4 and does not use this file. What it does, inside the caller's transaction:
 *
 * - invoice number `OB/<unit label>` (no number series, BR-11-5; a repeat after a reversal gets `OB/<unit label>/2`, ...);
 * - one `CHARGE` line (head `OPENING_ARREARS`) for the principal and one `INTEREST` line for the arrears interest;
 * - no tax, no round-off, `invoiceDate = dueDate = asOfDate`, `pdfStatus = READY` with no file;
 * - one `OPENING_BALANCE` ledger debit (`refType = 'opening_balance'`, not a second `INVOICE` entry);
 * - the journal is posted by the caller (the opening balance service), not here.
 */

export interface OpeningInvoiceInput {
  openingBalanceId: number;
  unit: { id: number; label: string };
  principalPaise: number;
  interestPaise: number;
  asOfDate: YmdString;
  billTo: { residentId: number; name: string; relation: 'OWNER' | 'CO_OWNER' | 'TENANT' };
}

const SYSTEM_HEADS: Record<
  string,
  Pick<
    ChargeHead,
    'name' | 'headType' | 'gstTreatment' | 'interestBearing' | 'ledgerAccountCode' | 'sortOrder'
  >
> = {
  [OPENING_ARREARS_HEAD]: {
    name: 'Arrears brought forward',
    headType: 'OPENING_ARREARS',
    gstTreatment: 'NONE',
    interestBearing: true,
    ledgerAccountCode: ACCOUNT.openingAdjustment,
    sortOrder: 990,
  },
  [OPENING_INTEREST_HEAD]: {
    name: 'Interest on arrears',
    headType: 'INTEREST',
    gstTreatment: 'FOLLOW_SOURCE',
    interestBearing: false,
    ledgerAccountCode: '4140',
    sortOrder: 991,
  },
};

/**
 * The society's system charge head of this key. Sub-module 11.1 seeds the full list (`chargeHeads.ensureSeeded`, section
 * 7.13); until the society has it, this creates only the one row the arrears invoice needs, with the seeded values.
 */
export async function systemHead(societyId: number, key: string, t: Transaction): Promise<ChargeHead> {
  const found = await ChargeHead.findOne({ where: { societyId, key }, transaction: t });
  if (found) return found;
  const def = SYSTEM_HEADS[key];
  if (!def) throw new Error(`unknown system charge head ${key}`);
  try {
    return await ChargeHead.create(
      {
        societyId,
        key,
        description: null,
        payerRouting: 'BILL_TO',
        sacCode: null,
        prorate: false,
        fundId: null,
        isSystem: true,
        status: 'ACTIVE',
        createdBy: null,
        updatedBy: null,
        version: 1,
        ...def,
      },
      { transaction: t },
    );
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    return (await ChargeHead.findOne({ where: { societyId, key }, transaction: t, lock: t.LOCK.SHARE }))!;
  }
}

/** `OB/<label>` and, when a reversed opening balance of the flat already used it, `OB/<label>/2`, `/3` ... (30 characters at most). */
async function arrearsInvoiceNo(societyId: number, label: string, t: Transaction): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const no = n === 1 ? `OB/${label}` : `OB/${label}/${n}`;
    if (no.length > 30)
      throw new UnprocessableError(
        'OPENING_BALANCE_INVALID',
        'The flat label is too long for an arrears invoice number',
        [{ field: 'unit', message: `${label} is longer than 27 characters` }],
      );
    if (!(await Invoice.findOne({ where: { societyId, invoiceNo: no }, attributes: ['id'], transaction: t })))
      return no;
  }
  throw new Error('no free arrears invoice number');
}

/** Creates the arrears invoice, its lines and the `OPENING_BALANCE` ledger debit. Lock the unit first (lock order, section 13). */
export async function createOpeningArrearsInvoice(
  ctx: Ctx,
  societyId: number,
  input: OpeningInvoiceInput,
  t: Transaction,
): Promise<{ invoiceId: number; invoiceNo: string; totalPaise: number }> {
  const { principalPaise, interestPaise } = input;
  const total = principalPaise + interestPaise;
  if (total <= 0) throw new Error('an arrears invoice needs an amount');
  const invoiceNo = await arrearsInvoiceNo(societyId, input.unit.label, t);
  const userId = ctx.user?.id ?? null;
  const invoice = await Invoice.create(
    {
      societyId,
      invoiceNo,
      financialYear: financialYearOf(input.asOfDate),
      invoiceType: 'OPENING',
      billingRunId: null,
      dedupeKey: `OB:${input.unit.id}:${input.openingBalanceId}`,
      unitId: input.unit.id,
      unitLabel: input.unit.label,
      billToResidentId: input.billTo.residentId,
      billToRelation: input.billTo.relation,
      billToName: input.billTo.name.slice(0, 150),
      periodStart: null,
      periodEnd: null,
      invoiceDate: input.asOfDate,
      dueDate: input.asOfDate,
      description: 'Arrears brought forward',
      refType: 'opening_balance',
      refId: input.openingBalanceId,
      societyGstin: null,
      gstApplied: false,
      thresholdBasePaise: 0,
      taxableValuePaise: 0,
      subtotalPaise: total,
      cgstPaise: 0,
      sgstPaise: 0,
      taxPaise: 0,
      roundOffPaise: 0,
      totalPaise: total,
      previousDuesPaise: 0,
      debitedPaise: 0,
      creditedPaise: 0,
      writtenOffPaise: 0,
      paidPaise: 0,
      outstandingPaise: total,
      // BR-11-47: interest lines never bear interest again
      nonInterestBearingPaise: interestPaise,
      status: 'ISSUED',
      settledOn: null,
      isDisputed: false,
      interestPostedToDate: null,
      lateFeeChargedAt: null,
      reminderCount: 0,
      lastReminderAt: null,
      pdfFileId: null,
      pdfStatus: 'READY',
      issuedAt: now(),
      cancelledAt: null,
      createdBy: userId,
      updatedBy: userId,
      version: 1,
    },
    { transaction: t },
  );
  const invoiceId = Number(invoice.id);
  let lineNo = 0;
  const line = async (
    head: ChargeHead,
    kind: 'CHARGE' | 'INTEREST',
    amountPaise: number,
    description: string,
  ) =>
    InvoiceLine.create(
      {
        societyId,
        invoiceId,
        billingNoteId: null,
        lineNo: ++lineNo,
        lineKind: kind,
        chargeHeadId: Number(head.id),
        headKey: head.key,
        description,
        quantity: null,
        ratePaise: null,
        amountPaise,
        isTaxable: false,
        billingRuleVersionId: null,
        periodFrom: null,
        periodTo: null,
        prorationDays: null,
        periodDays: null,
        refInvoiceLineId: null,
        computation: null,
        // both lines credit "Opening balance adjustment" (BR-11-70: Dr 1300 / Cr 3900)
        ledgerAccountCode: ACCOUNT.openingAdjustment,
        creditedPaise: 0,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction: t },
    );
  if (principalPaise > 0)
    await line(
      await systemHead(societyId, OPENING_ARREARS_HEAD, t),
      'CHARGE',
      principalPaise,
      'Arrears brought forward',
    );
  if (interestPaise > 0)
    await line(
      await systemHead(societyId, OPENING_INTEREST_HEAD, t),
      'INTEREST',
      interestPaise,
      'Interest on arrears brought forward',
    );
  await unitLedger.post(
    ctx,
    {
      unitId: input.unit.id,
      entryType: 'OPENING_BALANCE',
      refType: 'opening_balance',
      refId: input.openingBalanceId,
      debitPaise: total,
      creditPaise: 0,
      date: input.asOfDate,
      narration: `Arrears brought forward as of ${input.asOfDate} (${invoiceNo})`,
    },
    t,
  );
  return { invoiceId, invoiceNo, totalPaise: total };
}

/**
 * BR-11-66: closes an untouched arrears invoice with a `CANCELLATION` credit note issued directly (no approval): the note
 * (`CN/...` from the `CREDIT_NOTE` series, one line per invoice line), the invoice becomes `CANCELLED` with the whole total
 * credited. The ledger credit and the journal are the opening balance reversal's own (`ADJUSTMENT`), posted by the caller.
 * The caller has locked the unit and loaded this invoice `FOR UPDATE` and checked it is untouched.
 */
export async function cancelOpeningArrearsInvoice(
  ctx: Ctx,
  invoice: Invoice,
  reason: string,
  t: Transaction,
): Promise<{ noteId: number; noteNo: string }> {
  const societyId = Number(invoice.societyId);
  const today = istDate(now());
  const total = Number(invoice.totalPaise);
  const userId = ctx.user?.id ?? null;
  const noteNo = await nextNumber(societyId, 'CREDIT_NOTE', { date: today, transaction: t });
  const note = await BillingNote.create(
    {
      societyId,
      noteType: 'CREDIT',
      noteNo,
      financialYear: financialYearOf(today),
      invoiceId: Number(invoice.id),
      unitId: Number(invoice.unitId),
      billToResidentId: Number(invoice.billToResidentId),
      billToName: invoice.billToName,
      reasonCode: 'CANCELLATION',
      status: 'ISSUED',
      approvalType: null,
      approvalRequestId: null,
      noteDate: today,
      subtotalPaise: total,
      cgstPaise: 0,
      sgstPaise: 0,
      taxPaise: 0,
      roundOffPaise: 0,
      totalPaise: total,
      appliedToInvoicePaise: total,
      excessToAdvancePaise: 0,
      interestFromDate: null,
      interestToDate: null,
      lateFeePolicyId: null,
      dedupeKey: `OBREV:${invoice.id}`,
      remarks: reason.slice(0, 500),
      rejectedReason: null,
      issuedAt: now(),
      pdfFileId: null,
      pdfStatus: 'READY',
      createdBy: userId,
      updatedBy: userId,
      version: 1,
    },
    { transaction: t },
  );
  const lines = await InvoiceLine.findAll({
    where: { invoiceId: invoice.id },
    order: [['lineNo', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  let lineNo = 0;
  for (const l of lines) {
    await InvoiceLine.create(
      {
        societyId,
        invoiceId: null,
        billingNoteId: Number(note.id),
        lineNo: ++lineNo,
        lineKind: l.lineKind,
        chargeHeadId: l.chargeHeadId,
        headKey: l.headKey,
        description: l.description,
        quantity: null,
        ratePaise: null,
        amountPaise: Number(l.amountPaise),
        isTaxable: false,
        billingRuleVersionId: null,
        periodFrom: null,
        periodTo: null,
        prorationDays: null,
        periodDays: null,
        refInvoiceLineId: Number(l.id),
        computation: null,
        ledgerAccountCode: l.ledgerAccountCode,
        creditedPaise: 0,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction: t },
    );
    l.creditedPaise = Number(l.amountPaise);
    l.updatedBy = userId;
    await l.save({ transaction: t });
  }
  invoice.creditedPaise = total;
  invoice.outstandingPaise = 0;
  invoice.status = 'CANCELLED';
  invoice.cancelledAt = now();
  invoice.updatedBy = userId;
  invoice.version = Number(invoice.version) + 1;
  await invoice.save({ transaction: t });
  return { noteId: Number(note.id), noteNo };
}

export const invoiceNotFound = () => new NotFoundError('INVOICE_NOT_FOUND', 'Invoice not found');
