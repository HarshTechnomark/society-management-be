import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 04 section 7.1. Plans are never deleted; `isActive = false` hides a plan from new subscriptions. */
export class Plan extends Model<InferAttributes<Plan>, InferCreationAttributes<Plan>> {
  declare id: number | undefined;
  declare code: 'STARTER' | 'STANDARD' | 'PREMIUM' | 'ENTERPRISE';
  declare name: string;
  declare description: string | null;
  declare tierRank: number;
  declare isPublic: boolean;
  declare isActive: boolean;
  declare currentVersionId: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Plan.init(
      {
        id: idColumn,
        code: { type: DataTypes.STRING(20), allowNull: false },
        name: { type: DataTypes.STRING(60), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        tierRank: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
        isPublic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        currentVersionId: fkColumn(true),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'plans' },
    );
  }
}
