import { Invoice, InvoiceLine, LateFeePolicy } from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { systemCtx } from '../../src/types/context';
import { sequelize } from '../../src/models';
import { unitLedger } from '../../src/modules/billing/billing.ledger.service';
import type { InvoiceType, InvoiceStatus } from '../../src/modules/billing/billing.constants';
import { registerBillingDues } from '../../src/modules/billing/billing.latefee.jobs';
import { addOwner, resetRuns, runSociety, type RunSociety } from './billing-runs';

/** Fixtures of sub-module 11.5: invoices written directly (with line and ledger entry), policies and a stand-in debit note issuer. */
export const resetDues = async (): Promise<void> => {
  await resetRuns();
  registerBillingDues();
  setNow('2026-11-04T04:30:00Z');
};

export interface DuesWorld extends RunSociety {
  owners: Record<string, { residentId: number; name: string }>;
}

/** A society with `flats` flats A-101..., each with an owner, and the standard heads. */
export async function duesWorld(flats = 3): Promise<DuesWorld> {
  const w = await runSociety({ flats });
  const owners: DuesWorld['owners'] = {};
  for (const u of w.units) {
    const { resident } = await addOwner(w.society.id!, u.id, `Owner ${u.label}`);
    owners[u.label] = { residentId: resident.id!, name: resident.name };
  }
  return { ...w, owners };
}

let seq = 0;
export interface InvoiceSpec {
  unit: { id: number; label: string };
  billTo: { residentId: number; name: string };
  totalPaise?: number;
  invoiceDate?: string;
  dueDate?: string;
  periodStart?: string | null;
  invoiceType?: InvoiceType;
  status?: InvoiceStatus;
  paidPaise?: number;
  settledOn?: string | null;
  isDisputed?: boolean;
  headKey?: string;
}

/** An issued invoice with one CHARGE line of the head and the ledger debit. `outstanding` follows `paidPaise`. */
export async function makeInvoice(w: DuesWorld, s: InvoiceSpec): Promise<Invoice> {
  const total = s.totalPaise ?? 800_000;
  const paid = s.paidPaise ?? 0;
  const head = w.heads[s.headKey ?? 'MAINTENANCE']!;
  const n = ++seq;
  const due = s.dueDate ?? '2026-09-10';
  const invoiceDate = s.invoiceDate ?? (due < '2026-09-01' ? due : '2026-09-01');
  const periodStart = s.periodStart === undefined ? '2026-09-01' : s.periodStart;
  const inv = await Invoice.create({
    societyId: w.society.id!,
    invoiceNo: `INV/2026-27/${String(n).padStart(6, '0')}`,
    financialYear: '2026-27',
    invoiceType: s.invoiceType ?? 'REGULAR',
    billingRunId: null,
    dedupeKey: null,
    unitId: s.unit.id,
    unitLabel: s.unit.label,
    billToResidentId: s.billTo.residentId,
    billToRelation: 'OWNER',
    billToName: s.billTo.name,
    periodStart,
    periodEnd: periodStart ? `${periodStart.slice(0, 7)}-30` : null,
    invoiceDate,
    dueDate: due,
    description: null,
    refType: null,
    refId: null,
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
    paidPaise: paid,
    outstandingPaise: total - paid,
    nonInterestBearingPaise: 0,
    status: s.status ?? (paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED'),
    settledOn: s.settledOn ?? null,
    isDisputed: s.isDisputed ?? false,
    interestPostedToDate: null,
    lateFeeChargedAt: null,
    reminderCount: 0,
    lastReminderAt: null,
    pdfFileId: null,
    pdfStatus: 'PENDING',
    issuedAt: new Date('2026-09-01T00:00:00Z'),
    cancelledAt: null,
    createdBy: null,
    updatedBy: null,
    version: 1,
  } as never);
  await InvoiceLine.create({
    societyId: w.society.id!,
    invoiceId: inv.id!,
    billingNoteId: null,
    lineNo: 1,
    lineKind: 'CHARGE',
    chargeHeadId: head.id!,
    headKey: head.key,
    description: 'Maintenance',
    quantity: null,
    ratePaise: null,
    amountPaise: total,
    isTaxable: false,
    billingRuleVersionId: null,
    periodFrom: null,
    periodTo: null,
    prorationDays: null,
    periodDays: null,
    refInvoiceLineId: null,
    computation: {
      method: 'FLAT_PER_UNIT',
      inputs: { amountPaise: total, months: 1 },
      formula: `${total} x 1`,
      text: 'flat',
    },
    ledgerAccountCode: '4100',
    creditedPaise: 0,
    createdBy: null,
    updatedBy: null,
  } as never);
  await sequelize.transaction(t =>
    unitLedger.post(
      {
        ...systemCtx('t'),
        society: { id: w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
      },
      {
        unitId: s.unit.id,
        entryType: 'INVOICE',
        refType: 'invoice',
        refId: inv.id!,
        debitPaise: total,
        creditPaise: 0,
        date: invoiceDate,
        narration: `Bill ${inv.invoiceNo}`,
      },
      t,
    ),
  );
  return inv;
}

export const makePolicy = (
  societyId: number,
  p: Partial<LateFeePolicy> & { policyType: LateFeePolicy['policyType'] },
) =>
  LateFeePolicy.create({
    societyId,
    interestRatePct: null,
    interestFrom: null,
    flatFeePaise: null,
    graceDays: 15,
    minChargePaise: 100,
    effectiveFrom: '2026-04-01',
    status: 'ACTIVE',
    reason: 'Test policy',
    resolutionRef: null,
    approvalRequestId: null,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...p,
  } as never);

export const interestPolicy = (societyId: number, o: Partial<LateFeePolicy> = {}) =>
  makePolicy(societyId, {
    policyType: 'SIMPLE_INTEREST',
    interestRatePct: '21.0000',
    interestFrom: 'DUE_DATE',
    graceDays: 15,
    ...o,
  });
