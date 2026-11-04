import type { Transaction } from 'sequelize';
import type { Ctx, SystemCtx } from '../../types/context';
import type {
  BillToRelation,
  InvoiceStatus,
  InvoiceType,
  LedgerEntryType,
  LedgerRefType,
  LineKind,
  MeterType,
  PdfStatus,
} from './billing.constants';

export type { Ctx, SystemCtx, Transaction };
/** `YYYY-MM-DD`. */
export type YmdString = string;

export interface LedgerPostInput {
  unitId: number;
  entryType: LedgerEntryType;
  refType: LedgerRefType;
  refId: number;
  debitPaise: number;
  creditPaise: number;
  date: YmdString;
  narration: string;
}

export interface InvoiceBalanceDto {
  id: number;
  invoiceNo: string;
  status: InvoiceStatus;
  totalPaise: number;
  paidPaise: number;
  creditedPaise: number;
  debitedPaise: number;
  outstandingPaise: number;
  settledOn: YmdString | null;
}

export interface InvoiceLineDto {
  id: number;
  lineNo: number;
  lineKind: LineKind;
  chargeHeadId: number | null;
  headKey: string | null;
  description: string;
  quantity: string | null;
  ratePaise: number | null;
  amountPaise: number;
  creditedPaise: number;
  isTaxable: boolean;
  periodFrom: YmdString | null;
  periodTo: YmdString | null;
  prorationDays: number | null;
  periodDays: number | null;
  /** Omitted when `billing.explain_my_bill` is off. */
  computation?: unknown;
}

export interface InvoiceDto extends InvoiceBalanceDto {
  societyId: number;
  invoiceType: InvoiceType;
  financialYear: string;
  billingRunId: number | null;
  unitId: number;
  unitLabel: string;
  billToResidentId: number;
  billToRelation: BillToRelation;
  billToName: string;
  periodStart: YmdString | null;
  periodEnd: YmdString | null;
  invoiceDate: YmdString;
  dueDate: YmdString;
  description: string | null;
  refType: string | null;
  refId: number | null;
  gstApplied: boolean;
  taxableValuePaise: number;
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  previousDuesPaise: number;
  writtenOffPaise: number;
  isDisputed: boolean;
  pdfStatus: PdfStatus;
  lines: InvoiceLineDto[];
}

export interface OpenInvoiceDto {
  id: number;
  invoiceNo: string;
  periodLabel: string;
  issueDate: YmdString;
  dueDate: YmdString;
  outstandingPaise: number;
  isDisputed: boolean;
}

export interface CreateAdHocInput {
  unitId: number;
  chargeHeadKey: string;
  amountPaise: number;
  refType: string;
  refId: number;
  dueDate: YmdString;
}

/** Module 21 meter source (BR-11-17). */
export interface MeterConsumption {
  quantityMilli: bigint;
  readingIds: number[];
  isEstimated: boolean;
}
export interface MeterSource {
  consumptionForPeriod(
    societyId: number,
    periodStart: YmdString,
    periodEnd: YmdString,
  ): Promise<Map<number, MeterConsumption>>;
}
export type MeterSourceType = MeterType;
