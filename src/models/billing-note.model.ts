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
  NoteApprovalType,
  NoteReasonCode,
  NoteStatus,
  NoteType,
  PdfStatus,
} from '../modules/billing/billing.constants';
import { immutableHooks } from './_immutable';

/** Module 11 section 7.9: credit and debit notes. Once ISSUED only the PDF columns, `updatedBy` and `version` change (hook); never deleted. */
export class BillingNote extends Model<InferAttributes<BillingNote>, InferCreationAttributes<BillingNote>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare noteType: NoteType;
  declare noteNo: string | null;
  declare financialYear: string | null;
  declare invoiceId: number;
  declare unitId: number;
  declare billToResidentId: number;
  declare billToName: string;
  declare reasonCode: NoteReasonCode;
  declare status: NoteStatus;
  declare approvalType: NoteApprovalType | null;
  declare approvalRequestId: number | null;
  declare noteDate: string | null;
  declare subtotalPaise: number;
  declare cgstPaise: number;
  declare sgstPaise: number;
  declare taxPaise: number;
  declare roundOffPaise: number;
  declare totalPaise: number;
  declare appliedToInvoicePaise: number;
  declare excessToAdvancePaise: number;
  declare interestFromDate: string | null;
  declare interestToDate: string | null;
  declare lateFeePolicyId: number | null;
  declare dedupeKey: string | null;
  declare remarks: string;
  declare rejectedReason: string | null;
  declare issuedAt: Date | null;
  declare pdfFileId: number | null;
  declare pdfStatus: PdfStatus;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    BillingNote.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        noteType: { type: DataTypes.STRING(6), allowNull: false },
        noteNo: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        financialYear: { type: DataTypes.CHAR(7), allowNull: true, defaultValue: null },
        invoiceId: fkColumn(false),
        unitId: fkColumn(false),
        billToResidentId: fkColumn(false),
        billToName: { type: DataTypes.STRING(150), allowNull: false },
        reasonCode: { type: DataTypes.STRING(20), allowNull: false },
        status: { type: DataTypes.STRING(18), allowNull: false },
        approvalType: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        approvalRequestId: fkColumn(true),
        noteDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        subtotalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        cgstPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        sgstPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        taxPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        roundOffPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        totalPaise: { type: DataTypes.BIGINT, allowNull: false },
        appliedToInvoicePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        excessToAdvancePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        interestFromDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        interestToDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        lateFeePolicyId: fkColumn(true),
        dedupeKey: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
        remarks: { type: DataTypes.STRING(500), allowNull: false },
        rejectedReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        issuedAt: dateColumn(),
        pdfFileId: fkColumn(true),
        pdfStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING' },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'billing_notes',
        hooks: immutableHooks<BillingNote>(
          'billing_notes',
          ['pdfFileId', 'pdfStatus', 'updatedBy', 'version'],
          note => note.previous('status') === 'ISSUED',
        ),
      },
    );
  }
}
