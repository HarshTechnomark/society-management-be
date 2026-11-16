import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { AccountSubtype, AccountType } from '../modules/accounts/accounts.constants';

/** Module 13 section 7.1 chart of accounts with a running balance (`balancePaise` = Σdebit − Σcredit, written only by `journal.post` and the verify job). */
export class LedgerAccount extends Model<
  InferAttributes<LedgerAccount>,
  InferCreationAttributes<LedgerAccount>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare code: string;
  declare name: string;
  declare accountType: AccountType;
  declare subtype: CreationOptional<AccountSubtype>;
  declare parentId: number | null;
  declare systemKey: string | null;
  declare isGroup: CreationOptional<boolean>;
  declare isSystem: CreationOptional<boolean>;
  declare isActive: CreationOptional<boolean>;
  declare isCashBookCategory: CreationOptional<boolean>;
  declare transparencyCategory: string | null;
  declare description: string | null;
  declare balancePaise: CreationOptional<number>;
  declare lastPostedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    LedgerAccount.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        code: { type: DataTypes.STRING(12), allowNull: false },
        name: { type: DataTypes.STRING(120), allowNull: false },
        accountType: { type: DataTypes.STRING(30), allowNull: false },
        subtype: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'OTHER' },
        parentId: fkColumn(true),
        systemKey: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        isGroup: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        isCashBookCategory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        transparencyCategory: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        balancePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        lastPostedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'ledger_accounts' },
    );
  }
}
