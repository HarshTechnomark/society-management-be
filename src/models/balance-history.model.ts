import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn } from './_columns';
import { now } from '../lib/clock';
import type { BalanceDirection } from '../modules/accounts/accounts.constants';

/** Module 13 section 7.5 append-only balance history: no `updatedAt`; update and delete throw. */
export class BalanceHistory extends Model<
  InferAttributes<BalanceHistory>,
  InferCreationAttributes<BalanceHistory>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare journalEntryId: number;
  declare changedAt: Date;
  declare entryDate: string;
  declare direction: BalanceDirection;
  declare deltaTotalPaise: CreationOptional<number>;
  declare inBankPaise: CreationOptional<number>;
  declare clearingPaise: CreationOptional<number>;
  declare cashPaise: CreationOptional<number>;
  declare chequesPaise: CreationOptional<number>;
  declare totalPaise: CreationOptional<number>;
  declare earmarkedFundsPaise: CreationOptional<number>;
  declare label: string;
  declare refType: string;
  declare createdBy: number | null;
  declare createdAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const big = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    BalanceHistory.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        journalEntryId: fkColumn(false),
        changedAt: { type: DataTypes.DATE(3), allowNull: false },
        entryDate: { type: DataTypes.DATEONLY, allowNull: false },
        direction: { type: DataTypes.STRING(30), allowNull: false },
        deltaTotalPaise: big,
        inBankPaise: big,
        clearingPaise: big,
        cashPaise: big,
        chequesPaise: big,
        totalPaise: big,
        earmarkedFundsPaise: big,
        label: { type: DataTypes.STRING(160), allowNull: false },
        refType: { type: DataTypes.STRING(40), allowNull: false },
        createdBy: fkColumn(true),
        createdAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: () => now() },
      },
      {
        sequelize,
        tableName: 'balance_history',
        updatedAt: false,
        hooks: {
          beforeUpdate: () => {
            throw new Error('balance_history rows are append-only');
          },
          beforeBulkUpdate: o => {
            o.individualHooks = true;
          },
          beforeDestroy: () => {
            throw new Error('balance_history rows are never deleted');
          },
          beforeBulkDestroy: () => {
            throw new Error('balance_history rows are never deleted');
          },
        },
      },
    );
  }
}
