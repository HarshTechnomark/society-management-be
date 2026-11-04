import { randomUUID } from 'node:crypto';
import {
  BillingNote,
  BillingRule,
  BillingRuleVersion,
  BillingRun,
  BillSplitRule,
  ChargeHead,
  Invoice,
  InvoiceLine,
  LateFeePolicy,
  OpeningBalance,
  UnitLedgerEntry,
} from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { registerBilling } from '../../src/modules/billing/billing.public';
import {
  billingPortCalls,
  clearMeterSources,
  setBillingPorts,
} from '../../src/modules/billing/billing.ports';
import { resetResidents, residentSociety } from './residents';

/**
 * Module 11 fixtures (not `billing.ts`, which belongs to module 06). The `raw*` helpers insert rows through the models
 * with consistent defaults so tests can override one field at a time; sub-modules 11.1 to 11.3 add their own helpers here.
 */
export async function resetBillingTests(): Promise<void> {
  await resetResidents();
  registerBilling();
  setBillingPorts();
  clearMeterSources();
  billingPortCalls.length = 0;
  setNow('2026-11-01T04:30:00Z');
}

/** A PREMIUM society with its chairman and `flats` flats (module 08 and 09 fixtures). */
export const billingWorld = (o: Parameters<typeof residentSociety>[0] = {}) =>
  residentSociety({ flats: 3, ...o });
export type BillingWorld = Awaited<ReturnType<typeof billingWorld>>;

export const idem = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${++seq}`;

export const rawHead = (societyId: number, o: Partial<ChargeHead> = {}) =>
  ChargeHead.create({
    societyId,
    key: `HEAD_${uniq().toUpperCase()}`,
    name: 'Test head',
    headType: 'MAINTENANCE',
    payerRouting: 'BILL_TO',
    gstTreatment: 'NONE',
    ledgerAccountCode: '4100',
    ...o,
  } as never);

export const rawRule = (societyId: number, chargeHeadId: number, o: Partial<BillingRule> = {}) =>
  BillingRule.create({
    societyId,
    chargeHeadId,
    name: `Rule ${uniq()}`,
    scopeType: 'ALL_UNITS',
    ...o,
  } as never);

export const rawVersion = (societyId: number, billingRuleId: number, o: Partial<BillingRuleVersion> = {}) =>
  BillingRuleVersion.create({
    societyId,
    billingRuleId,
    versionNo: 1,
    rateType: 'FLAT_PER_UNIT',
    amountPaise: 250_000,
    effectiveFrom: '2026-04-01',
    status: 'APPROVED',
    reason: 'Initial rate',
    ...o,
  } as never);

export const rawSplitRule = (societyId: number, o: Partial<BillSplitRule> = {}) =>
  BillSplitRule.create({
    societyId,
    name: `Split ${uniq()}`,
    basis: 'EQUAL',
    amountSource: 'FIXED',
    fixedAmountPaise: 1_000_000,
    ...o,
  } as never);

export const rawPolicy = (societyId: number, o: Partial<LateFeePolicy> = {}) =>
  LateFeePolicy.create({
    societyId,
    policyType: 'SIMPLE_INTEREST',
    interestRatePct: '18.0000',
    interestFrom: 'DUE_DATE',
    graceDays: 5,
    effectiveFrom: '2026-04-01',
    status: 'ACTIVE',
    reason: 'Setup',
    ...o,
  } as never);

let runSeq = 0;
export const rawRun = (societyId: number, o: Partial<BillingRun> = {}) => {
  const n = ++runSeq;
  return BillingRun.create({
    societyId,
    runLabel: `BR-T-${n}`,
    runType: 'SUPPLEMENTARY',
    cycle: 'MONTHLY',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    billDate: '2026-11-01',
    scopeType: 'ALL_UNITS',
    ...o,
  } as never);
};

/** An ISSUED invoice of 1,000 rupees (subtotal 100,000 paise, no tax), outstanding in full. */
export const rawInvoice = (societyId: number, unitId: number, o: Partial<Invoice> = {}) =>
  Invoice.create({
    societyId,
    invoiceNo: `INV/2026-27/${String(++seq).padStart(6, '0')}`,
    financialYear: '2026-27',
    invoiceType: 'ADHOC',
    unitId,
    unitLabel: 'A-101',
    billToResidentId: 1,
    billToRelation: 'OWNER',
    billToName: 'Test Owner',
    invoiceDate: '2026-11-01',
    dueDate: '2026-11-10',
    subtotalPaise: 100_000,
    totalPaise: 100_000,
    outstandingPaise: 100_000,
    issuedAt: new Date('2026-11-01T04:30:00Z'),
    ...o,
  } as never);

export const rawLine = (societyId: number, o: Partial<InvoiceLine> & { chargeHeadId: number }) =>
  InvoiceLine.create({
    societyId,
    lineNo: 1,
    lineKind: 'CHARGE',
    description: 'Maintenance',
    amountPaise: 100_000,
    ledgerAccountCode: '4100',
    ...o,
  } as never);

export const rawNote = (societyId: number, invoiceId: number, unitId: number, o: Partial<BillingNote> = {}) =>
  BillingNote.create({
    societyId,
    noteType: 'CREDIT',
    invoiceId,
    unitId,
    billToResidentId: 1,
    billToName: 'Test Owner',
    reasonCode: 'BILLING_ERROR',
    status: 'PENDING_APPROVAL',
    totalPaise: 50_000,
    subtotalPaise: 50_000,
    remarks: 'Wrong parking charge',
    ...o,
  } as never);

export const rawLedger = (societyId: number, unitId: number, o: Partial<UnitLedgerEntry> = {}) =>
  UnitLedgerEntry.create({
    societyId,
    unitId,
    entryDate: '2026-11-01',
    entryType: 'INVOICE',
    refType: 'invoice',
    refId: ++seq,
    debitPaise: 100_000,
    narration: 'Bill',
    ...o,
  } as never);

export const rawOpening = (societyId: number, o: Partial<OpeningBalance> = {}) =>
  OpeningBalance.create({
    societyId,
    unitLabelInput: 'A-101',
    importFileId: 1,
    importRowNo: 2,
    asOfDate: '2026-03-31',
    status: 'INVALID',
    ...o,
  } as never);
