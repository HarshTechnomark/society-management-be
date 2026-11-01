import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { AppError } from '../utils/errors';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export type PlanVersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

/**
 * Module 04 section 7.2. `publishedPlanId` and `draftPlanId` are generated columns and are never written.
 * The `beforeUpdate` hook refuses any change to a PUBLISHED or RETIRED row except PUBLISHED -> RETIRED (BR-04-2).
 */
export class PlanVersion extends Model<InferAttributes<PlanVersion>, InferCreationAttributes<PlanVersion>> {
  declare id: number | undefined;
  declare planId: number;
  declare versionNo: number;
  declare status: PlanVersionStatus;
  declare pricePerFlatPaise: number;
  declare minBillableFlats: number;
  declare annualFreeMonths: number;
  declare notes: string | null;
  declare publishedAt: Date | null;
  declare publishedBy: number | null;
  declare retiredAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    PlanVersion.init(
      {
        id: idColumn,
        planId: fkColumn(false),
        versionNo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        pricePerFlatPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        minBillableFlats: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        annualFreeMonths: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 2 },
        notes: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        publishedAt: dateColumn(),
        publishedBy: fkColumn(true),
        retiredAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'plan_versions',
        hooks: {
          beforeUpdate: (v: PlanVersion) => {
            const was = v.previous('status') as PlanVersionStatus | undefined;
            if (was === undefined || was === 'DRAFT') return;
            // a status change to PUBLISHED made by `publish` on a draft is covered above (was = DRAFT)
            const changed = (v.changed() || []).filter(k => k !== 'updatedAt');
            const allowed = ['status', 'retiredAt'];
            if (
              was === 'PUBLISHED' &&
              v.status === 'RETIRED' &&
              changed.every(k => allowed.includes(String(k)))
            )
              return;
            throw new AppError(409, 'PLAN_VERSION_NOT_DRAFT', 'Only a draft plan version can be changed');
          },
        },
      },
    );
  }
}
