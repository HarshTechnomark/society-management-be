import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { FundStatus, FundType } from '../modules/accounts/accounts.constants';

/** Module 13 section 7.6 funds. The balance of a fund is the negated balance of its ledger account (credit-normal). */
export class Fund extends Model<InferAttributes<Fund>, InferCreationAttributes<Fund>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare fundType: FundType;
  declare name: string;
  declare nameKey: string;
  declare ledgerAccountId: number;
  declare purpose: string | null;
  declare usageRequiresResolution: CreationOptional<boolean>;
  declare showToResidents: CreationOptional<boolean>;
  declare status: CreationOptional<FundStatus>;
  declare closedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Fund.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        fundType: { type: DataTypes.STRING(30), allowNull: false },
        name: { type: DataTypes.STRING(80), allowNull: false },
        nameKey: { type: DataTypes.STRING(80), allowNull: false },
        ledgerAccountId: fkColumn(false),
        purpose: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        usageRequiresResolution: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        showToResidents: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'ACTIVE' },
        closedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'funds' },
    );
  }
}
