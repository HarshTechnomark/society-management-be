import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { ExpensePaymentMode, ExpenseStatus, ExpenseType } from '../modules/accounts/accounts.constants';

/** Module 13 section 7.7 expenses (cash book, vendor bills, statutory dues). Shown as `EXP-<id>`. */
export class Expense extends Model<InferAttributes<Expense>, InferCreationAttributes<Expense>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare expenseType: CreationOptional<ExpenseType>;
  declare expenseDate: string;
  declare payee: string;
  declare ledgerAccountId: number;
  declare description: string | null;
  declare grossAmountPaise: number;
  declare gstPaise: CreationOptional<number>;
  declare tdsPaise: CreationOptional<number>;
  declare tdsSection: string | null;
  declare challanNo: string | null;
  declare netPaidPaise: number;
  declare paidFromLedgerAccountId: number;
  declare bankAccountId: number | null;
  declare paymentMode: ExpensePaymentMode;
  declare paymentReference: string | null;
  declare fundId: number | null;
  declare collectionId: number | null;
  declare vendorId: number | null;
  declare vendorBillId: number | null;
  declare billFileCount: CreationOptional<number>;
  declare status: CreationOptional<ExpenseStatus>;
  declare approvalRequestId: number | null;
  declare approvedBy: number | null;
  declare journalEntryId: number | null;
  declare voucherNo: string | null;
  declare reversalJournalEntryId: number | null;
  declare postedAt: Date | null;
  declare rejectionReason: string | null;
  declare cancelReason: string | null;
  declare reversalReason: string | null;
  declare reversedBy: number | null;
  declare reversedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const str = (n: number) => ({ type: DataTypes.STRING(n), allowNull: true, defaultValue: null });
    Expense.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        expenseType: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'DIRECT' },
        expenseDate: { type: DataTypes.DATEONLY, allowNull: false },
        payee: { type: DataTypes.STRING(150), allowNull: false },
        ledgerAccountId: fkColumn(false),
        description: str(500),
        grossAmountPaise: { type: DataTypes.BIGINT, allowNull: false },
        gstPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        tdsPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        tdsSection: str(10),
        challanNo: str(30),
        netPaidPaise: { type: DataTypes.BIGINT, allowNull: false },
        paidFromLedgerAccountId: fkColumn(false),
        bankAccountId: fkColumn(true),
        paymentMode: { type: DataTypes.STRING(30), allowNull: false },
        paymentReference: str(30),
        fundId: fkColumn(true),
        collectionId: fkColumn(true),
        vendorId: fkColumn(true),
        vendorBillId: fkColumn(true),
        billFileCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'DRAFT' },
        approvalRequestId: fkColumn(true),
        approvedBy: fkColumn(true),
        journalEntryId: fkColumn(true),
        voucherNo: str(30),
        reversalJournalEntryId: fkColumn(true),
        postedAt: dateColumn(),
        rejectionReason: str(500),
        cancelReason: str(500),
        reversalReason: str(500),
        reversedBy: fkColumn(true),
        reversedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(false),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'expenses' },
    );
  }
}
