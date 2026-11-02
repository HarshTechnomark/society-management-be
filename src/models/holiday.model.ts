import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export const HOLIDAY_TYPES = ['NATIONAL', 'FESTIVAL', 'SOCIETY', 'OTHER'] as const;
export type HolidayType = (typeof HOLIDAY_TYPES)[number];

/** Module 08 section 7.5. `holidayDate` is a society-local calendar date. */
export class Holiday extends Model<InferAttributes<Holiday>, InferCreationAttributes<Holiday>> {
  declare id: number | undefined;
  declare societyId: number;
  declare holidayDate: string;
  declare name: string;
  declare holidayType: HolidayType;
  declare isOfficeClosed: boolean;
  declare notes: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Holiday.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        holidayDate: { type: DataTypes.DATEONLY, allowNull: false },
        name: { type: DataTypes.STRING(80), allowNull: false },
        holidayType: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'FESTIVAL' },
        isOfficeClosed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        notes: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'holidays' },
    );
  }
}
