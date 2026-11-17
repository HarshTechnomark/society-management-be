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
  BankAccountKind,
  BankAccountStatus,
  StatementFormat,
  VerificationStatus,
} from '../modules/accounts/accounts.constants';

/**
 * Module 13 section 7.8 bank accounts. `accountNumberEnc` (AES-256-GCM) is excluded from the default scope; load it with
 * `BankAccount.unscoped()` only where the full number is needed. The generated column `collectionFlagKey` is not mapped.
 */
export class BankAccount extends Model<InferAttributes<BankAccount>, InferCreationAttributes<BankAccount>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare ledgerAccountId: number;
  declare displayName: string;
  declare bankName: string;
  declare branchName: string | null;
  declare ifsc: string;
  declare accountKind: CreationOptional<BankAccountKind>;
  declare accountHolderName: string;
  declare accountNumberEnc: Buffer;
  declare accountNumberLast4: string;
  declare accountNumberHash: string;
  declare isCollectionAccount: CreationOptional<boolean>;
  declare statementFormat: CreationOptional<StatementFormat>;
  declare openingBalancePaise: CreationOptional<number>;
  declare openingBalanceDate: string | null;
  declare verificationStatus: CreationOptional<VerificationStatus>;
  declare verifiedBy: number | null;
  declare verifiedAt: Date | null;
  declare lastReconciledDate: string | null;
  declare lastReconciledBalancePaise: number | null;
  declare status: CreationOptional<BankAccountStatus>;
  declare closedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    BankAccount.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        ledgerAccountId: fkColumn(false),
        displayName: { type: DataTypes.STRING(60), allowNull: false },
        bankName: { type: DataTypes.STRING(100), allowNull: false },
        branchName: { type: DataTypes.STRING(100), allowNull: true, defaultValue: null },
        ifsc: { type: DataTypes.CHAR(11), allowNull: false },
        accountKind: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'CURRENT' },
        accountHolderName: { type: DataTypes.STRING(150), allowNull: false },
        accountNumberEnc: { type: DataTypes.BLOB, allowNull: false },
        accountNumberLast4: { type: DataTypes.CHAR(4), allowNull: false },
        accountNumberHash: { type: DataTypes.CHAR(64), allowNull: false },
        isCollectionAccount: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        statementFormat: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'GENERIC_CSV' },
        openingBalancePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        openingBalanceDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        verificationStatus: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'UNVERIFIED' },
        verifiedBy: fkColumn(true),
        verifiedAt: dateColumn(),
        lastReconciledDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        lastReconciledBalancePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'ACTIVE' },
        closedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'bank_accounts',
        defaultScope: { attributes: { exclude: ['accountNumberEnc'] } },
      },
    );
  }
}
