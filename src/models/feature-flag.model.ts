import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export type FeatureFlagType = 'GLOBAL' | 'PLAN' | 'TENANT' | 'PERCENTAGE' | 'KILL_SWITCH';

/** Module 04 section 7.8. Paranoid: archived flags keep their row so the key stays reserved. */
export class FeatureFlag extends Model<InferAttributes<FeatureFlag>, InferCreationAttributes<FeatureFlag>> {
  declare id: number | undefined;
  declare flagKey: string;
  declare description: string;
  declare type: FeatureFlagType;
  declare isEnabled: boolean;
  declare minPlanCode: string | null;
  declare rolloutPercent: number;
  declare isClientVisible: boolean;
  declare ownerTeam: string | null;
  declare expiresOn: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;
  declare deletedAt: Date | null | undefined;

  static initModel(sequelize: Sequelize): void {
    FeatureFlag.init(
      {
        id: idColumn,
        flagKey: { type: DataTypes.STRING(80), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: false },
        type: { type: DataTypes.STRING(20), allowNull: false },
        isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        minPlanCode: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        rolloutPercent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        isClientVisible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        ownerTeam: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        expiresOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'feature_flags', paranoid: true },
    );
  }
}
