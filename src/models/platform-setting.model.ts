import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export const SETTING_CATEGORIES = [
  'GENERAL',
  'BILLING',
  'LIFECYCLE',
  'SECURITY',
  'NOTIFICATIONS',
  'SUPPORT',
  'DATA',
  'STATUS',
] as const;
export type SettingCategory = (typeof SETTING_CATEGORIES)[number];
export type SettingValueType = 'STRING' | 'INTEGER' | 'BOOLEAN' | 'JSON';

/** Module 07 section 7.1. One row per registry key; not paranoid (keys are never deleted). */
export class PlatformSetting extends Model<
  InferAttributes<PlatformSetting>,
  InferCreationAttributes<PlatformSetting>
> {
  declare id: number | undefined;
  declare settingKey: string;
  declare category: SettingCategory;
  declare valueType: SettingValueType;
  declare valueJson: unknown;
  declare isReadOnly: boolean;
  declare description: string;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    PlatformSetting.init(
      {
        id: idColumn,
        settingKey: { type: DataTypes.STRING(80), allowNull: false },
        category: { type: DataTypes.STRING(20), allowNull: false },
        valueType: { type: DataTypes.STRING(10), allowNull: false },
        valueJson: { type: DataTypes.JSON, allowNull: false },
        isReadOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        description: { type: DataTypes.STRING(300), allowNull: false },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'platform_settings' },
    );
  }
}
