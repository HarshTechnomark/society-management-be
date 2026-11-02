import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const BUILDING_KINDS = [
  'TOWER',
  'WING',
  'ROW_HOUSES',
  'VILLA_CLUSTER',
  'COMMERCIAL',
  'CLUBHOUSE',
  'OTHER',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
export const STRUCTURE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type StructureStatus = (typeof STRUCTURE_STATUSES)[number];

/** Module 08 section 7.1. Not paranoid: archive is a status; hard delete is a controlled exception (BR-08-18). */
export class Building extends Model<InferAttributes<Building>, InferCreationAttributes<Building>> {
  declare id: number | undefined;
  declare societyId: number;
  declare parentBuildingId: number | null;
  declare code: string;
  declare name: string;
  declare kind: BuildingKind;
  declare floorsAboveGround: number;
  declare basements: number;
  declare liftCount: number;
  declare sortOrder: number;
  declare status: StructureStatus;
  declare archivedAt: Date | null;
  declare archivedReason: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Building.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        parentBuildingId: fkColumn(true),
        code: { type: DataTypes.STRING(6), allowNull: false },
        name: { type: DataTypes.STRING(80), allowNull: false },
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TOWER' },
        floorsAboveGround: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        basements: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        liftCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        archivedAt: dateColumn(),
        archivedReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'buildings' },
    );
  }
}
