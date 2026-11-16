import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 13 section 7.4 live society balance and the control state of the books (lock date, closed year, chart seeding). One row per society. */
export class SocietyBalance extends Model<
  InferAttributes<SocietyBalance>,
  InferCreationAttributes<SocietyBalance>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare inBankPaise: CreationOptional<number>;
  declare clearingPaise: CreationOptional<number>;
  declare cashPaise: CreationOptional<number>;
  declare chequesPaise: CreationOptional<number>;
  declare totalPaise: CreationOptional<number>;
  declare investmentsPaise: CreationOptional<number>;
  declare earmarkedFundsPaise: CreationOptional<number>;
  declare lastJournalEntryId: number | null;
  declare lastChangedAt: Date | null;
  declare booksLockedThrough: string | null;
  declare unlockFromDate: string | null;
  declare unlockUntil: Date | null;
  declare unlockApprovalRequestId: number | null;
  declare lastClosedFinancialYear: string | null;
  declare chartSeededAt: Date | null;
  declare chartTemplateVersion: CreationOptional<number>;
  declare lastVerifiedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const big = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    SocietyBalance.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        inBankPaise: big,
        clearingPaise: big,
        cashPaise: big,
        chequesPaise: big,
        totalPaise: big,
        investmentsPaise: big,
        earmarkedFundsPaise: big,
        lastJournalEntryId: fkColumn(true),
        lastChangedAt: dateColumn(),
        booksLockedThrough: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        unlockFromDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        unlockUntil: dateColumn(),
        unlockApprovalRequestId: fkColumn(true),
        lastClosedFinancialYear: { type: DataTypes.CHAR(7), allowNull: true, defaultValue: null },
        chartSeededAt: dateColumn(),
        chartTemplateVersion: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        lastVerifiedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'society_balances' },
    );
  }
}
