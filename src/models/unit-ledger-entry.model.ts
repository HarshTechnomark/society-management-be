import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type { LedgerEntryType, LedgerRefType } from '../modules/billing/billing.constants';
import { immutableHooks } from './_immutable';

/** Module 11 section 7.11: the append-only per-flat ledger (BR-11-57). No `updatedAt`; update and delete throw. */
export class UnitLedgerEntry extends Model<
  InferAttributes<UnitLedgerEntry>,
  InferCreationAttributes<UnitLedgerEntry>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare entryDate: string;
  declare entryType: LedgerEntryType;
  declare refType: LedgerRefType;
  declare refId: number;
  declare debitPaise: number;
  declare creditPaise: number;
  declare narration: string;
  declare createdBy: number | null;
  declare createdAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    UnitLedgerEntry.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        entryDate: { type: DataTypes.DATEONLY, allowNull: false },
        entryType: { type: DataTypes.STRING(20), allowNull: false },
        refType: { type: DataTypes.STRING(30), allowNull: false },
        refId: fkColumn(false),
        debitPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        creditPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        narration: { type: DataTypes.STRING(300), allowNull: false },
        createdBy: fkColumn(true),
        createdAt: timestampColumns.createdAt,
      },
      {
        sequelize,
        tableName: 'unit_ledger_entries',
        updatedAt: false,
        hooks: immutableHooks('unit_ledger_entries', []),
      },
    );
  }
}
