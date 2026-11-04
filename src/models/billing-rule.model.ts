import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type { ConfigStatus, ScopeType } from '../modules/billing/billing.constants';

/** Module 11 section 7.2: a billing rule is (charge head, unit scope); rates live in immutable `BillingRuleVersion` rows. */
export class BillingRule extends Model<InferAttributes<BillingRule>, InferCreationAttributes<BillingRule>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare chargeHeadId: number;
  declare name: string;
  declare scopeType: ScopeType;
  declare scopeValues: (number | string)[] | null;
  declare status: ConfigStatus;
  declare sortOrder: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    BillingRule.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        chargeHeadId: fkColumn(false),
        name: { type: DataTypes.STRING(100), allowNull: false },
        scopeType: { type: DataTypes.STRING(12), allowNull: false },
        scopeValues: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 100 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'billing_rules',
      },
    );
  }
}
