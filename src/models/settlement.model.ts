import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { SettlementSource, SettlementStatus } from '../modules/accounts/accounts.constants';

export interface SettlementItem {
  type: 'payment' | 'refund';
  gatewayPaymentId: string;
  gatewayRefundId?: string;
  amountPaise: number;
  feePaise: number;
  taxPaise: number;
}

/** Module 13 section 7.9 gateway settlements (`items` snapshot with a multi-valued index on the payment ids). */
export class Settlement extends Model<InferAttributes<Settlement>, InferCreationAttributes<Settlement>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare gatewayProvider: string;
  declare gatewaySettlementId: string;
  declare bankAccountId: number | null;
  declare settlementDate: string;
  declare utr: string | null;
  declare grossPaise: CreationOptional<number>;
  declare refundsPaise: CreationOptional<number>;
  declare feePaise: CreationOptional<number>;
  declare feeGstPaise: CreationOptional<number>;
  declare adjustmentPaise: CreationOptional<number>;
  declare netPaise: CreationOptional<number>;
  declare paymentCount: CreationOptional<number>;
  declare items: SettlementItem[];
  declare unmatchedItems: Record<string, unknown>[] | null;
  declare source: SettlementSource;
  declare sourceFileId: number | null;
  declare status: CreationOptional<SettlementStatus>;
  declare differenceAcceptedReason: string | null;
  declare journalEntryId: number | null;
  declare postedAt: Date | null;
  declare lastAttemptAt: Date | null;
  declare attempts: CreationOptional<number>;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const big = () => ({ type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });
    Settlement.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        gatewayProvider: { type: DataTypes.STRING(30), allowNull: false },
        gatewaySettlementId: { type: DataTypes.STRING(60), allowNull: false },
        bankAccountId: fkColumn(true),
        settlementDate: { type: DataTypes.DATEONLY, allowNull: false },
        utr: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        grossPaise: big(),
        refundsPaise: big(),
        feePaise: big(),
        feeGstPaise: big(),
        adjustmentPaise: big(),
        netPaise: big(),
        paymentCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        items: { type: DataTypes.JSON, allowNull: false },
        unmatchedItems: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        source: { type: DataTypes.STRING(30), allowNull: false },
        sourceFileId: fkColumn(true),
        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'RECEIVED' },
        differenceAcceptedReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        journalEntryId: fkColumn(true),
        postedAt: dateColumn(),
        lastAttemptAt: dateColumn(),
        attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'settlements' },
    );
  }
}
