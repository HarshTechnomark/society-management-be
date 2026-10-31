import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 04 section 7.10. Rows change only through atomic SQL updates (entitlements service) and the close job. */
export class UsageCounter extends Model<
  InferAttributes<UsageCounter>,
  InferCreationAttributes<UsageCounter>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare limitKey: string;
  declare periodKey: string;
  declare used: number;
  declare lastWarnedPct: number;
  declare closedAt: Date | null;
  declare limitAtClose: number | null;
  declare overageUnits: number;
  declare cycleAtClose: 'MONTHLY' | 'ANNUAL' | null;
  declare overageInvoiceId: number | null;
  declare lastReconciledAt: Date | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    UsageCounter.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        limitKey: { type: DataTypes.STRING(80), allowNull: false },
        periodKey: { type: DataTypes.STRING(10), allowNull: false },
        used: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastWarnedPct: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        closedAt: dateColumn(),
        limitAtClose: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, defaultValue: null },
        overageUnits: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        cycleAtClose: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        overageInvoiceId: fkColumn(true),
        lastReconciledAt: dateColumn(),
        ...timestampColumns,
      },
      { sequelize, tableName: 'usage_counters' },
    );
  }
}
