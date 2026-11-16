import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { DepositKind, DepositRefundMode, DepositStatus } from '../modules/accounts/accounts.constants';

export interface DepositAdjustment {
  kind: 'DEDUCTION' | 'FORFEIT' | 'REFUND';
  amountPaise: number;
  reason: string;
  journalEntryId: number;
  at: string;
  by: number | null;
}

/** Module 13 section 7.12 refundable deposits. Shown as `DEP-<id>`. */
export class Deposit extends Model<InferAttributes<Deposit>, InferCreationAttributes<Deposit>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare residentId: number | null;
  declare kind: DepositKind;
  declare ledgerAccountId: number;
  declare title: string;
  declare refType: string | null;
  declare refId: number | null;
  declare amountPaise: number;
  declare receivedPaise: CreationOptional<number>;
  declare deductedPaise: CreationOptional<number>;
  declare refundedPaise: CreationOptional<number>;
  declare refundRequestedPaise: CreationOptional<number>;
  declare invoiceId: number | null;
  declare isOpening: CreationOptional<boolean>;
  declare dueDate: string | null;
  declare status: CreationOptional<DepositStatus>;
  declare adjustments: CreationOptional<DepositAdjustment[]>;
  declare refundApprovalRequestId: number | null;
  declare refundMode: DepositRefundMode | null;
  declare refundReference: string | null;
  declare refundPaidFromLedgerAccountId: number | null;
  declare receivedAt: Date | null;
  declare refundedAt: Date | null;
  declare cancelReason: string | null;
  declare notes: string | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const big = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    Deposit.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        residentId: fkColumn(true),
        kind: { type: DataTypes.STRING(30), allowNull: false },
        ledgerAccountId: fkColumn(false),
        title: { type: DataTypes.STRING(120), allowNull: false },
        refType: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        refId: fkColumn(true),
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        receivedPaise: big,
        deductedPaise: big,
        refundedPaise: big,
        refundRequestedPaise: big,
        invoiceId: fkColumn(true),
        isOpening: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        dueDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'AWAITING_PAYMENT' },
        adjustments: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
        refundApprovalRequestId: fkColumn(true),
        refundMode: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        refundReference: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        refundPaidFromLedgerAccountId: fkColumn(true),
        receivedAt: dateColumn(),
        refundedAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        notes: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'deposits' },
    );
  }
}
