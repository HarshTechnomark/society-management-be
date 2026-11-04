import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type {
  BillToRelation,
  InvoiceStatus,
  InvoiceType,
  PdfStatus,
} from '../modules/billing/billing.constants';
import { immutableHooks } from './_immutable';

/** BR-11-6: after issue only these invoice columns change; anything else throws in `beforeUpdate`. */
export const INVOICE_MUTABLE_COLUMNS = [
  'debitedPaise',
  'creditedPaise',
  'writtenOffPaise',
  'paidPaise',
  'outstandingPaise',
  'nonInterestBearingPaise',
  'status',
  'settledOn',
  'isDisputed',
  'interestPostedToDate',
  'lateFeeChargedAt',
  'reminderCount',
  'lastReminderAt',
  'pdfFileId',
  'pdfStatus',
  'cancelledAt',
  'updatedBy',
  'version',
] as const;

/** Module 11 section 7.7: an issued invoice (regular, supplementary, ad hoc or opening). Immutable except the settlement and housekeeping columns of BR-11-6 (hook); never deleted. */
export class Invoice extends Model<InferAttributes<Invoice>, InferCreationAttributes<Invoice>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare invoiceNo: string;
  declare financialYear: string;
  declare invoiceType: InvoiceType;
  declare billingRunId: number | null;
  declare dedupeKey: string | null;
  declare unitId: number;
  declare unitLabel: string;
  declare billToResidentId: number;
  declare billToRelation: BillToRelation;
  declare billToName: string;
  declare periodStart: string | null;
  declare periodEnd: string | null;
  declare invoiceDate: string;
  declare dueDate: string;
  declare description: string | null;
  declare refType: string | null;
  declare refId: number | null;
  declare societyGstin: string | null;
  declare gstApplied: boolean;
  declare thresholdBasePaise: number;
  declare taxableValuePaise: number;
  declare subtotalPaise: number;
  declare cgstPaise: number;
  declare sgstPaise: number;
  declare taxPaise: number;
  declare roundOffPaise: number;
  declare totalPaise: number;
  declare previousDuesPaise: number;
  declare debitedPaise: number;
  declare creditedPaise: number;
  declare writtenOffPaise: number;
  declare paidPaise: number;
  declare outstandingPaise: number;
  declare nonInterestBearingPaise: number;
  declare status: InvoiceStatus;
  declare settledOn: string | null;
  declare isDisputed: boolean;
  declare interestPostedToDate: string | null;
  declare lateFeeChargedAt: string | null;
  declare reminderCount: number;
  declare lastReminderAt: Date | null;
  declare pdfFileId: number | null;
  declare pdfStatus: PdfStatus;
  declare issuedAt: Date;
  declare cancelledAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Invoice.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        invoiceNo: { type: DataTypes.STRING(30), allowNull: false },
        financialYear: { type: DataTypes.CHAR(7), allowNull: false },
        invoiceType: { type: DataTypes.STRING(15), allowNull: false },
        billingRunId: fkColumn(true),
        dedupeKey: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        unitId: fkColumn(false),
        unitLabel: { type: DataTypes.STRING(30), allowNull: false },
        billToResidentId: fkColumn(false),
        billToRelation: { type: DataTypes.STRING(10), allowNull: false },
        billToName: { type: DataTypes.STRING(150), allowNull: false },
        periodStart: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        periodEnd: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        invoiceDate: { type: DataTypes.DATEONLY, allowNull: false },
        dueDate: { type: DataTypes.DATEONLY, allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        refType: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        refId: fkColumn(true),
        societyGstin: { type: DataTypes.STRING(15), allowNull: true, defaultValue: null },
        gstApplied: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        thresholdBasePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        taxableValuePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        subtotalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        cgstPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        sgstPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        taxPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        roundOffPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        totalPaise: { type: DataTypes.BIGINT, allowNull: false },
        previousDuesPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        debitedPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        creditedPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        writtenOffPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        paidPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        outstandingPaise: { type: DataTypes.BIGINT, allowNull: false },
        nonInterestBearingPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'ISSUED' },
        settledOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        isDisputed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        interestPostedToDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        lateFeeChargedAt: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        reminderCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastReminderAt: dateColumn(),
        pdfFileId: fkColumn(true),
        pdfStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING' },
        issuedAt: dateColumn(false),
        cancelledAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'invoices',
        hooks: immutableHooks('invoices', INVOICE_MUTABLE_COLUMNS),
      },
    );
  }
}
