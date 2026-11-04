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
  MeterType,
  MissingReadingPolicy,
  RateType,
  RuleVersionStatus,
} from '../modules/billing/billing.constants';
import { immutableHooks } from './_immutable';

/** Module 11 section 7.3: an immutable version of a billing rule. Only status, effectiveTo and the approval columns change (hook). */
export class BillingRuleVersion extends Model<
  InferAttributes<BillingRuleVersion>,
  InferCreationAttributes<BillingRuleVersion>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare billingRuleId: number;
  declare versionNo: number;
  declare rateType: RateType;
  declare amountPaise: number | null;
  declare ratePerSqftPaise: number | null;
  declare unitTypeRates: Record<string, number> | null;
  declare meterType: MeterType | null;
  declare slabs: { uptoMilli: number | null; ratePaise: number }[] | null;
  declare minimumChargePaise: number | null;
  declare missingReadingPolicy: MissingReadingPolicy | null;
  declare billSplitRuleId: number | null;
  declare percent: string | null;
  declare baseChargeHeadIds: number[] | null;
  declare effectiveFrom: string;
  declare effectiveTo: string | null;
  declare status: RuleVersionStatus;
  declare reason: string;
  declare resolutionRef: string | null;
  declare approvalRequestId: number | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    BillingRuleVersion.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        billingRuleId: fkColumn(false),
        versionNo: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
        rateType: { type: DataTypes.STRING(20), allowNull: false },
        amountPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        ratePerSqftPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        unitTypeRates: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        meterType: { type: DataTypes.STRING(12), allowNull: true, defaultValue: null },
        slabs: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        minimumChargePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        missingReadingPolicy: { type: DataTypes.STRING(16), allowNull: true, defaultValue: null },
        billSplitRuleId: fkColumn(true),
        percent: { type: DataTypes.DECIMAL(9, 4), allowNull: true, defaultValue: null },
        baseChargeHeadIds: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        effectiveFrom: { type: DataTypes.DATEONLY, allowNull: false },
        effectiveTo: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PENDING_APPROVAL' },
        reason: { type: DataTypes.STRING(500), allowNull: false },
        resolutionRef: { type: DataTypes.STRING(100), allowNull: true, defaultValue: null },
        approvalRequestId: fkColumn(true),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        rejectedReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'billing_rule_versions',
        hooks: immutableHooks('billing_rule_versions', [
          'status',
          'effectiveTo',
          'approvalRequestId',
          'approvedBy',
          'approvedAt',
          'rejectedReason',
          'updatedBy',
        ]),
      },
    );
  }
}
