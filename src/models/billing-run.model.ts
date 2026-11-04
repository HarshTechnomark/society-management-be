import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { BillingCycle, RunScopeType, RunStatus, RunType } from '../modules/billing/billing.constants';

/** Module 11 section 7.5: one billing run (a period for all flats, or a supplementary run). Never deleted; cancelled runs keep their row. */
export class BillingRun extends Model<InferAttributes<BillingRun>, InferCreationAttributes<BillingRun>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare runLabel: string;
  declare runType: RunType;
  declare cycle: BillingCycle;
  declare periodStart: string;
  declare periodEnd: string;
  declare billDate: string;
  declare scopeType: RunScopeType;
  declare scopeValues: number[] | null;
  declare splitInputs: { billSplitRuleId: number; amountPaise: number }[] | null;
  declare status: RunStatus;
  declare activeKey: string | null;
  declare itemCount: number;
  declare readyCount: number;
  declare exceptionCount: number;
  declare excludedCount: number;
  declare warningCount: number;
  declare skippedCount: number;
  declare issuedCount: number;
  declare subtotalPaise: number;
  declare taxPaise: number;
  declare roundOffPaise: number;
  declare totalPaise: number;
  declare previousRunTotalPaise: number | null;
  declare computedAt: Date | null;
  declare computeError: string | null;
  declare notes: string | null;
  declare approvalRequestId: number | null;
  declare publishedBy: number | null;
  declare publishedAt: Date | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare issueStartedAt: Date | null;
  declare issuedAt: Date | null;
  declare lastError: string | null;
  declare cancelReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    BillingRun.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        runLabel: { type: DataTypes.STRING(30), allowNull: false },
        runType: { type: DataTypes.STRING(15), allowNull: false },
        cycle: { type: DataTypes.STRING(12), allowNull: false },
        periodStart: { type: DataTypes.DATEONLY, allowNull: false },
        periodEnd: { type: DataTypes.DATEONLY, allowNull: false },
        billDate: { type: DataTypes.DATEONLY, allowNull: false },
        scopeType: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ALL_UNITS' },
        scopeValues: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        splitInputs: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        activeKey: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        itemCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        readyCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        exceptionCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        excludedCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        warningCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        skippedCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        issuedCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        subtotalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        taxPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        roundOffPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        totalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        previousRunTotalPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        computedAt: dateColumn(),
        computeError: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        notes: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        approvalRequestId: fkColumn(true),
        publishedBy: fkColumn(true),
        publishedAt: dateColumn(),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        issueStartedAt: dateColumn(),
        issuedAt: dateColumn(),
        lastError: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        cancelReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'billing_runs',
        hooks: {
          beforeDestroy: () => {
            throw new Error('billing_runs rows are never deleted');
          },
          beforeBulkDestroy: () => {
            throw new Error('billing_runs rows are never deleted');
          },
        },
      },
    );
  }
}
