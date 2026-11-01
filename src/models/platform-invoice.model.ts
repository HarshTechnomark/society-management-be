import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const DOCUMENT_TYPES = ['INVOICE', 'CREDIT_NOTE'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const INVOICE_KINDS = ['PERIOD', 'PRORATION', 'ONE_TIME', 'MANUAL'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export const INVOICE_STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'VOID',
  'WRITTEN_OFF',
  'REJECTED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const TAX_TYPES = ['INTRA_STATE', 'INTER_STATE'] as const;
export type TaxType = (typeof TAX_TYPES)[number];
export const CREDIT_NOTE_REASONS = [
  'PRICE_CORRECTION',
  'SERVICE_CREDIT',
  'DUPLICATE_INVOICE',
  'CANCELLATION',
  'GOODWILL',
  'OTHER',
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];
export const PDF_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export type PdfStatus = (typeof PDF_STATUSES)[number];

/**
 * BR-06-18: the only columns that may change once a document has a number. Anything else throws in `beforeUpdate`.
 * `updatedAt` is set by Sequelize on every save.
 */
export const ISSUED_MUTABLE_COLUMNS: ReadonlySet<string> = new Set([
  'creditAppliedPaise',
  'paidPaise',
  'tdsPaise',
  'creditNotedPaise',
  'writtenOffPaise',
  'excessToCreditPaise',
  'amountDuePaise',
  'status',
  'paidAt',
  'voidedAt',
  'writeOffRequestedBy',
  'writeOffRequestedAt',
  'writeOffReason',
  'writtenOffBy',
  'writtenOffAt',
  'suspendOn',
  'pdfFileId',
  'pdfStatus',
  'updatedBy',
  'version',
  'updatedAt',
]);

/** Columns a caller tried to change on an issued document that BR-06-18 forbids (empty when the change is allowed). */
export function forbiddenIssuedChanges(inv: PlatformInvoice): string[] {
  if (inv.previous('invoiceNo') == null) return [];
  const changed = inv.changed();
  if (!changed) return [];
  return changed.filter(c => !ISSUED_MUTABLE_COLUMNS.has(c));
}

/**
 * Module 06 section 7.1. Tax invoices and credit notes (`documentType`). Money is integer paise; `gstRatePct` is a
 * DECIMAL string such as "18.0000". Issued documents are immutable apart from settlement columns (BR-06-18) and are
 * never deleted. Raw SQL updates bypass the hook, so services change invoices only through the model.
 */
export class PlatformInvoice extends Model<
  InferAttributes<PlatformInvoice>,
  InferCreationAttributes<PlatformInvoice>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare subscriptionId: number | null;
  declare documentType: DocumentType;
  declare invoiceKind: InvoiceKind | null;
  declare originalInvoiceId: number | null;
  declare dedupeKey: string | null;
  declare invoiceNo: string | null;
  declare financialYear: string | null;
  declare status: InvoiceStatus;
  declare issueDate: string | null;
  declare dueDate: string | null;
  declare suspendOn: string | null;
  declare periodStart: string | null;
  declare periodEnd: string | null;
  declare planKey: string | null;
  declare billingCycle: 'MONTHLY' | 'ANNUAL' | null;
  declare supplierLegalName: string | null;
  declare supplierGstin: string | null;
  declare supplierStateCode: string | null;
  declare supplierAddress: string | null;
  declare billingName: string;
  declare billingGstin: string | null;
  declare billingAddress: string;
  declare billingStateName: string;
  declare placeOfSupplyStateCode: string;
  declare taxType: TaxType;
  declare gstRatePct: string;
  declare sacCode: string;
  declare subtotalPaise: number;
  declare cgstPaise: number;
  declare sgstPaise: number;
  declare igstPaise: number;
  declare taxPaise: number;
  declare totalPaise: number;
  declare creditAppliedPaise: number;
  declare paidPaise: number;
  declare tdsPaise: number;
  declare creditNotedPaise: number;
  declare writtenOffPaise: number;
  declare excessToCreditPaise: number;
  declare amountDuePaise: number;
  declare creditNoteReason: CreditNoteReason | null;
  declare notes: string | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare issuedAt: Date | null;
  declare paidAt: Date | null;
  declare voidedAt: Date | null;
  declare writeOffRequestedBy: number | null;
  declare writeOffRequestedAt: Date | null;
  declare writeOffReason: string | null;
  declare writtenOffBy: number | null;
  declare writtenOffAt: Date | null;
  declare pdfFileId: number | null;
  declare pdfStatus: PdfStatus;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    const date = () => ({ type: DataTypes.DATEONLY, allowNull: true, defaultValue: null });
    const str = (n: number) => ({ type: DataTypes.STRING(n), allowNull: true, defaultValue: null });
    const paise = () => ({ type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });
    PlatformInvoice.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        subscriptionId: fkColumn(true),
        documentType: { type: DataTypes.STRING(20), allowNull: false },
        invoiceKind: str(20),
        originalInvoiceId: fkColumn(true),
        dedupeKey: str(80),
        invoiceNo: str(30),
        financialYear: { type: DataTypes.CHAR(7), allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(20), allowNull: false },
        issueDate: date(),
        dueDate: date(),
        suspendOn: date(),
        periodStart: date(),
        periodEnd: date(),
        planKey: str(20),
        billingCycle: str(10),
        supplierLegalName: str(200),
        supplierGstin: str(15),
        supplierStateCode: { type: DataTypes.CHAR(2), allowNull: true, defaultValue: null },
        supplierAddress: str(300),
        billingName: { type: DataTypes.STRING(200), allowNull: false },
        billingGstin: str(15),
        billingAddress: { type: DataTypes.STRING(400), allowNull: false },
        billingStateName: { type: DataTypes.STRING(60), allowNull: false },
        placeOfSupplyStateCode: { type: DataTypes.CHAR(2), allowNull: false },
        taxType: { type: DataTypes.STRING(12), allowNull: false },
        gstRatePct: { type: DataTypes.DECIMAL(9, 4), allowNull: false, defaultValue: '18.0000' },
        sacCode: { type: DataTypes.CHAR(6), allowNull: false },
        subtotalPaise: paise(),
        cgstPaise: paise(),
        sgstPaise: paise(),
        igstPaise: paise(),
        taxPaise: paise(),
        totalPaise: paise(),
        creditAppliedPaise: paise(),
        paidPaise: paise(),
        tdsPaise: paise(),
        creditNotedPaise: paise(),
        writtenOffPaise: paise(),
        excessToCreditPaise: paise(),
        amountDuePaise: paise(),
        creditNoteReason: str(30),
        notes: str(500),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        rejectedReason: str(500),
        issuedAt: dateColumn(),
        paidAt: dateColumn(),
        voidedAt: dateColumn(),
        writeOffRequestedBy: fkColumn(true),
        writeOffRequestedAt: dateColumn(),
        writeOffReason: str(500),
        writtenOffBy: fkColumn(true),
        writtenOffAt: dateColumn(),
        pdfFileId: fkColumn(true),
        pdfStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING' },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'platform_invoices',
        hooks: {
          beforeUpdate: inv => {
            const bad = forbiddenIssuedChanges(inv);
            if (bad.length)
              throw new Error(`Issued platform invoice ${inv.invoiceNo} is immutable: ${bad.join(', ')}`);
          },
          // bulk updates run the per-row hook so BR-06-18 cannot be bypassed through Model.update
          beforeBulkUpdate: options => {
            options.individualHooks = true;
          },
          beforeDestroy: () => {
            throw new Error('platform_invoices rows are never deleted');
          },
          beforeBulkDestroy: () => {
            throw new Error('platform_invoices rows are never deleted');
          },
        },
      },
    );
  }
}
