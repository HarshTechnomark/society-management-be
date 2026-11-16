import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { StatementFileFormat, StatementImportStatus } from '../modules/accounts/accounts.constants';

/** Module 13 section 7.10 bank statement imports. */
export class BankStatementImport extends Model<
  InferAttributes<BankStatementImport>,
  InferCreationAttributes<BankStatementImport>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare bankAccountId: number;
  declare fileId: number;
  declare fileSha256: string;
  declare fileFormat: StatementFileFormat;
  declare parserKey: string;
  declare periodFrom: string | null;
  declare periodTo: string | null;
  declare openingBalancePaise: number | null;
  declare closingBalancePaise: number | null;
  declare lineCount: CreationOptional<number>;
  declare duplicateCount: CreationOptional<number>;
  declare creditTotalPaise: CreationOptional<number>;
  declare debitTotalPaise: CreationOptional<number>;
  declare matchedCount: CreationOptional<number>;
  declare status: CreationOptional<StatementImportStatus>;
  declare errorMessage: string | null;
  declare reconciledBy: number | null;
  declare reconciledAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const big = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const int = { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 };
    BankStatementImport.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        bankAccountId: fkColumn(false),
        fileId: fkColumn(false),
        fileSha256: { type: DataTypes.CHAR(64), allowNull: false },
        fileFormat: { type: DataTypes.STRING(30), allowNull: false },
        parserKey: { type: DataTypes.STRING(30), allowNull: false },
        periodFrom: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        periodTo: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        openingBalancePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        closingBalancePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        lineCount: int,
        duplicateCount: int,
        creditTotalPaise: big,
        debitTotalPaise: big,
        matchedCount: int,
        status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'UPLOADED' },
        errorMessage: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        reconciledBy: fkColumn(true),
        reconciledAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'bank_statement_imports' },
    );
  }
}
