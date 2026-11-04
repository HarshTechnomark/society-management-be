import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type {
  ConfigStatus,
  ScopeType,
  SplitAmountSource,
  SplitBasis,
} from '../modules/billing/billing.constants';

/** Module 11 section 7.4: how a total bill is divided across flats (BR-11-22). Changes affect the next compute only. */
export class BillSplitRule extends Model<
  InferAttributes<BillSplitRule>,
  InferCreationAttributes<BillSplitRule>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare name: string;
  declare description: string | null;
  declare basis: SplitBasis;
  declare amountSource: SplitAmountSource;
  declare fixedAmountPaise: number | null;
  declare scopeType: ScopeType;
  declare scopeValues: (number | string)[] | null;
  declare weights: Record<string, number> | null;
  declare status: ConfigStatus;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    BillSplitRule.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        name: { type: DataTypes.STRING(100), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        basis: { type: DataTypes.STRING(20), allowNull: false },
        amountSource: { type: DataTypes.STRING(10), allowNull: false },
        fixedAmountPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        scopeType: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ALL_UNITS' },
        scopeValues: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        weights: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'bill_split_rules',
      },
    );
  }
}
