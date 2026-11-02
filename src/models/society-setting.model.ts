import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 08 section 7.3. One row per saved key and society; the registry (schema, default) lives in code. */
export class SocietySetting extends Model<
  InferAttributes<SocietySetting>,
  InferCreationAttributes<SocietySetting>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare settingKey: string;
  declare valueJson: unknown;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    SocietySetting.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        settingKey: { type: DataTypes.STRING(80), allowNull: false },
        valueJson: { type: DataTypes.JSON, allowNull: false },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'society_settings' },
    );
  }
}
