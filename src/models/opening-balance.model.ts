import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { OpeningStatus } from '../modules/billing/billing.constants';

/** Module 11 section 7.12: one imported opening balance per flat. DRAFT and INVALID rows may be deleted; POSTED and REVERSED rows are kept. */
export class OpeningBalance extends Model<
  InferAttributes<OpeningBalance>,
  InferCreationAttributes<OpeningBalance>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number | null;
  declare unitLabelInput: string;
  declare importFileId: number;
  declare importRowNo: number;
  declare asOfDate: string;
  declare arrearsPrincipalPaise: number;
  declare arrearsInterestPaise: number;
  declare advancePaise: number;
  declare status: OpeningStatus;
  declare validationError: string | null;
  declare activeKey: string | null;
  declare invoiceId: number | null;
  declare postedAt: Date | null;
  declare postedBy: number | null;
  declare reversedAt: Date | null;
  declare reversedBy: number | null;
  declare reverseReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    OpeningBalance.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(true),
        unitLabelInput: { type: DataTypes.STRING(30), allowNull: false },
        importFileId: fkColumn(false),
        importRowNo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        asOfDate: { type: DataTypes.DATEONLY, allowNull: false },
        arrearsPrincipalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        arrearsInterestPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        advancePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        status: { type: DataTypes.STRING(10), allowNull: false },
        validationError: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        activeKey: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        invoiceId: fkColumn(true),
        postedAt: dateColumn(),
        postedBy: fkColumn(true),
        reversedAt: dateColumn(),
        reversedBy: fkColumn(true),
        reverseReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'opening_balances',
        hooks: {
          beforeDestroy: row => {
            if (row.status === 'POSTED' || row.status === 'REVERSED')
              throw new Error('A posted or reversed opening balance is never deleted');
          },
        },
      },
    );
  }
}
