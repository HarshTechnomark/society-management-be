import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export const NOTE_CATEGORIES = ['GENERAL', 'BILLING', 'SUPPORT', 'ONBOARDING', 'RISK'] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

/** Module 05 section 7.4. Platform-internal; paranoid. Never returned by a society route. */
export class SocietyNote extends Model<InferAttributes<SocietyNote>, InferCreationAttributes<SocietyNote>> {
  declare id: number | undefined;
  declare societyId: number;
  declare category: NoteCategory;
  declare body: string;
  declare isPinned: boolean;
  declare version: number;
  declare createdBy: number;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;
  declare deletedAt: Date | null | undefined;

  static initModel(sequelize: Sequelize): void {
    SocietyNote.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        category: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'GENERAL' },
        body: { type: DataTypes.STRING(2000), allowNull: false },
        isPinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(false),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: { type: DataTypes.DATE(3), allowNull: true, defaultValue: null },
      },
      { sequelize, tableName: 'society_notes', paranoid: true },
    );
  }
}
