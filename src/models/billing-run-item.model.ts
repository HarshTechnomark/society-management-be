import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type { BillToRelation, ExceptionCode, ItemStatus } from '../modules/billing/billing.constants';

/** Module 11 section 7.6: one computed bill (flat and party) of a run. Rebuilt by recompute; only rows of runs that never issued are deleted. */
export class BillingRunItem extends Model<
  InferAttributes<BillingRunItem>,
  InferCreationAttributes<BillingRunItem>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare billingRunId: number;
  declare unitId: number;
  declare unitLabel: string;
  declare itemKey: string;
  declare billToResidentId: number | null;
  declare billToRelation: BillToRelation | null;
  declare billToName: string | null;
  declare status: ItemStatus;
  declare exceptionCode: ExceptionCode | null;
  declare exceptionMessage: string | null;
  declare warningCodes: string | null;
  declare linesSnapshot: unknown[];
  declare thresholdBasePaise: number;
  declare gstApplied: boolean;
  declare subtotalPaise: number;
  declare taxPaise: number;
  declare roundOffPaise: number;
  declare totalPaise: number;
  declare previousTotalPaise: number | null;
  declare variancePct: string | null;
  declare excludedReason: string | null;
  declare excludedBy: number | null;
  declare invoiceId: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    BillingRunItem.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        billingRunId: fkColumn(false),
        unitId: fkColumn(false),
        unitLabel: { type: DataTypes.STRING(30), allowNull: false },
        itemKey: { type: DataTypes.STRING(45), allowNull: false },
        billToResidentId: fkColumn(true),
        billToRelation: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        billToName: { type: DataTypes.STRING(150), allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(10), allowNull: false },
        exceptionCode: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        exceptionMessage: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        warningCodes: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        linesSnapshot: { type: DataTypes.JSON, allowNull: false },
        thresholdBasePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        gstApplied: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        subtotalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        taxPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        roundOffPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        totalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        previousTotalPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        variancePct: { type: DataTypes.DECIMAL(9, 4), allowNull: true, defaultValue: null },
        excludedReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        excludedBy: fkColumn(true),
        invoiceId: fkColumn(true),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'billing_run_items',
      },
    );
  }
}
