import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type { AdvanceEntryType } from '../modules/payments/payments.constants';
import { immutableHooks } from './_immutable';

/** Module 12 section 7.7 the append-only unit wallet ledger (latest row = balance). Update and delete throw. */
export class UnitAdvance extends Model<InferAttributes<UnitAdvance>, InferCreationAttributes<UnitAdvance>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare entryType: AdvanceEntryType;
  declare amountPaise: number;
  declare balanceAfterPaise: number;
  declare paymentId: number | null;
  declare refundId: number | null;
  declare invoiceId: number | null;
  declare dedupeKey: string;
  declare narration: string;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    UnitAdvance.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        entryType: { type: DataTypes.STRING(20), allowNull: false },
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        balanceAfterPaise: { type: DataTypes.BIGINT, allowNull: false },
        paymentId: fkColumn(true),
        refundId: fkColumn(true),
        invoiceId: fkColumn(true),
        dedupeKey: { type: DataTypes.STRING(80), allowNull: false },
        narration: { type: DataTypes.STRING(200), allowNull: false },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'unit_advances', hooks: immutableHooks('unit_advances', []) },
    );
  }
}
