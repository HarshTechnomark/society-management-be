import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { InterestFrom, LateFeePolicyType, LateFeeStatus } from '../modules/billing/billing.constants';

/** Module 11 section 7.10: simple interest p.a. (max 21 %) or a flat fee, with grace days (BR-11-51). */
export class LateFeePolicy extends Model<
  InferAttributes<LateFeePolicy>,
  InferCreationAttributes<LateFeePolicy>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare policyType: LateFeePolicyType;
  declare interestRatePct: string | null;
  declare interestFrom: InterestFrom | null;
  declare flatFeePaise: number | null;
  declare graceDays: number;
  declare minChargePaise: number;
  declare effectiveFrom: string;
  declare status: LateFeeStatus;
  declare reason: string;
  declare resolutionRef: string | null;
  declare approvalRequestId: number | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    LateFeePolicy.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        policyType: { type: DataTypes.STRING(16), allowNull: false },
        interestRatePct: { type: DataTypes.DECIMAL(9, 4), allowNull: true, defaultValue: null },
        interestFrom: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        flatFeePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        graceDays: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        minChargePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 100 },
        effectiveFrom: { type: DataTypes.DATEONLY, allowNull: false },
        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'PENDING_APPROVAL' },
        reason: { type: DataTypes.STRING(500), allowNull: false },
        resolutionRef: { type: DataTypes.STRING(100), allowNull: true, defaultValue: null },
        approvalRequestId: fkColumn(true),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        rejectedReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'late_fee_policies',
      },
    );
  }
}
