import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 04 section 7.9. Removing an override deletes the row (the audit row keeps the before value). */
export class FeatureFlagOverride extends Model<
  InferAttributes<FeatureFlagOverride>,
  InferCreationAttributes<FeatureFlagOverride>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare flagId: number;
  declare value: boolean;
  declare reason: string;
  declare expiresAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    FeatureFlagOverride.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        flagId: fkColumn(false),
        value: { type: DataTypes.BOOLEAN, allowNull: false },
        reason: { type: DataTypes.STRING(500), allowNull: false },
        expiresAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'feature_flag_overrides' },
    );
  }
}
