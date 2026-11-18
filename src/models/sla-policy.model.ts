import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { PolicyStatus } from '../modules/helpdesk/helpdesk.constants';
import type { SlaCalendar } from '../modules/helpdesk/helpdesk.constants';

/** Module 15 section 7.2: one SLA policy holds the targets of all four priorities. The generated columns `defaultKey` and `activeNameKey` are not mapped. */
export class SlaPolicy extends Model<InferAttributes<SlaPolicy>, InferCreationAttributes<SlaPolicy>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare name: string;
  declare description: string | null;
  declare isDefault: CreationOptional<boolean>;
  declare p1ResponseMinutes: CreationOptional<number>;
  declare p1ResolutionMinutes: CreationOptional<number>;
  declare p1Calendar: CreationOptional<SlaCalendar>;
  declare p2ResponseMinutes: CreationOptional<number>;
  declare p2ResolutionMinutes: CreationOptional<number>;
  declare p2Calendar: CreationOptional<SlaCalendar>;
  declare p3ResponseMinutes: CreationOptional<number>;
  declare p3ResolutionMinutes: CreationOptional<number>;
  declare p3Calendar: CreationOptional<SlaCalendar>;
  declare p4ResponseMinutes: CreationOptional<number>;
  declare p4ResolutionMinutes: CreationOptional<number>;
  declare p4Calendar: CreationOptional<SlaCalendar>;
  declare status: CreationOptional<PolicyStatus>;
  declare archivedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    SlaPolicy.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        name: { type: DataTypes.STRING(60), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        p1ResponseMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 30 },
        p1ResolutionMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 240 },
        p1Calendar: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TWENTY_FOUR_SEVEN' },
        p2ResponseMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 240 },
        p2ResolutionMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1440 },
        p2Calendar: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TWENTY_FOUR_SEVEN' },
        p3ResponseMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 720 },
        p3ResolutionMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 4320 },
        p3Calendar: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TWENTY_FOUR_SEVEN' },
        p4ResponseMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1440 },
        p4ResolutionMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 10080 },
        p4Calendar: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TWENTY_FOUR_SEVEN' },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        archivedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'sla_policies' },
    );
  }
}
