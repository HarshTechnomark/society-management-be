import type {
  CreditNoteReason,
  DocumentType,
  InvoiceKind,
  InvoiceStatus,
  PdfStatus,
  PlatformInvoice,
  TaxType,
} from '../../models/platform-invoice.model';
import type { LineType, PlatformInvoiceLine } from '../../models/platform-invoice-line.model';

export interface PlatformInvoiceLineDto {
  lineNo: number;
  lineType: LineType;
  description: string;
  sacCode: string;
  quantity: string;
  unitPricePaise: number;
  amountPaise: number;
  planVersionId: number | null;
  addonKey: string | null;
  limitKey: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  prorationDays: number | null;
  periodDays: number | null;
}

/** What the issue functions return to other modules (module 04 reads `id`, `invoiceNo`, `totalPaise`, `dueDate`). */
export interface PlatformInvoiceDto {
  id: number;
  societyId: number;
  subscriptionId: number | null;
  invoiceNo: string;
  documentType: DocumentType;
  invoiceKind: InvoiceKind | null;
  originalInvoiceId: number | null;
  status: InvoiceStatus;
  financialYear: string | null;
  issueDate: string | null;
  dueDate: string;
  suspendOn: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  planKey: string | null;
  billingCycle: 'MONTHLY' | 'ANNUAL' | null;
  placeOfSupplyStateCode: string;
  taxType: TaxType;
  gstRatePct: string;
  sacCode: string;
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  creditAppliedPaise: number;
  paidPaise: number;
  tdsPaise: number;
  creditNotedPaise: number;
  writtenOffPaise: number;
  excessToCreditPaise: number;
  amountDuePaise: number;
  creditNoteReason: CreditNoteReason | null;
  notes: string | null;
  pdfStatus: PdfStatus;
  version: number;
  lines?: PlatformInvoiceLineDto[];
}

const n = (v: unknown): number => Number(v ?? 0);

export function lineDto(l: PlatformInvoiceLine): PlatformInvoiceLineDto {
  return {
    lineNo: l.lineNo,
    lineType: l.lineType,
    description: l.description,
    sacCode: l.sacCode,
    quantity: String(l.quantity),
    unitPricePaise: n(l.unitPricePaise),
    amountPaise: n(l.amountPaise),
    planVersionId: l.planVersionId,
    addonKey: l.addonKey,
    limitKey: l.limitKey,
    servicePeriodStart: l.servicePeriodStart,
    servicePeriodEnd: l.servicePeriodEnd,
    prorationDays: l.prorationDays,
    periodDays: l.periodDays,
  };
}

/** `invoiceNo` and `dueDate` are empty strings while a document is a draft (never returned to module 04). */
export function invoiceDto(i: PlatformInvoice, lines?: PlatformInvoiceLine[]): PlatformInvoiceDto {
  return {
    id: i.id!,
    societyId: i.societyId,
    subscriptionId: i.subscriptionId,
    invoiceNo: i.invoiceNo ?? '',
    documentType: i.documentType,
    invoiceKind: i.invoiceKind,
    originalInvoiceId: i.originalInvoiceId,
    status: i.status,
    financialYear: i.financialYear,
    issueDate: i.issueDate,
    dueDate: i.dueDate ?? '',
    suspendOn: i.suspendOn,
    periodStart: i.periodStart,
    periodEnd: i.periodEnd,
    planKey: i.planKey,
    billingCycle: i.billingCycle,
    placeOfSupplyStateCode: i.placeOfSupplyStateCode,
    taxType: i.taxType,
    gstRatePct: String(i.gstRatePct),
    sacCode: i.sacCode,
    subtotalPaise: n(i.subtotalPaise),
    cgstPaise: n(i.cgstPaise),
    sgstPaise: n(i.sgstPaise),
    igstPaise: n(i.igstPaise),
    taxPaise: n(i.taxPaise),
    totalPaise: n(i.totalPaise),
    creditAppliedPaise: n(i.creditAppliedPaise),
    paidPaise: n(i.paidPaise),
    tdsPaise: n(i.tdsPaise),
    creditNotedPaise: n(i.creditNotedPaise),
    writtenOffPaise: n(i.writtenOffPaise),
    excessToCreditPaise: n(i.excessToCreditPaise),
    amountDuePaise: n(i.amountDuePaise),
    creditNoteReason: i.creditNoteReason,
    notes: i.notes,
    pdfStatus: i.pdfStatus,
    version: i.version,
    ...(lines ? { lines: lines.map(lineDto) } : {}),
  };
}

export interface ManualInvoiceInput {
  societyId: number;
  subscriptionId?: number | null;
  lines: { description: string; quantity: string; unitPricePaise: number }[];
  notes?: string | null;
  serviceDate?: string | null;
}

export interface CreditNoteInput {
  reason: CreditNoteReason;
  subtotalPaise: number;
  notes: string;
}
