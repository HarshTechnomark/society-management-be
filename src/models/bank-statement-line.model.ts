import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { MatchMethod, MatchStatus } from '../modules/accounts/accounts.constants';

/** Module 13 section 7.11 statement lines. */
export class BankStatementLine extends Model<
  InferAttributes<BankStatementLine>,
  InferCreationAttributes<BankStatementLine>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare importId: number;
  declare bankAccountId: number;
  declare lineNo: number;
  declare txnDate: string;
  declare valueDate: string | null;
  declare description: string;
  declare reference: string | null;
  declare chequeNumber: string | null;
  declare debitPaise: CreationOptional<number>;
  declare creditPaise: CreationOptional<number>;
  declare runningBalancePaise: number | null;
  declare dedupeHash: string;
  declare matchStatus: CreationOptional<MatchStatus>;
  declare matchMethod: MatchMethod | null;
  declare matchConfidence: number | null;
  declare matchedJournalLineId: number | null;
  declare matchedBy: number | null;
  declare matchedAt: Date | null;
  declare ignoredReason: string | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    BankStatementLine.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        importId: fkColumn(false),
        bankAccountId: fkColumn(false),
        lineNo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        txnDate: { type: DataTypes.DATEONLY, allowNull: false },
        valueDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        description: { type: DataTypes.STRING(300), allowNull: false },
        reference: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        chequeNumber: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        debitPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        creditPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        runningBalancePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        dedupeHash: { type: DataTypes.CHAR(64), allowNull: false },
        matchStatus: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'UNMATCHED' },
        matchMethod: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        matchConfidence: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        matchedJournalLineId: fkColumn(true),
        matchedBy: fkColumn(true),
        matchedAt: dateColumn(),
        ignoredReason: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'bank_statement_lines' },
    );
  }
}
