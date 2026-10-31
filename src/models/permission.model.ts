import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { idColumn, timestampColumns } from './_columns';

export type PermissionScope = 'platform' | 'society' | 'resident' | 'gate' | 'work';
export type PermissionAction = 'view' | 'create' | 'edit' | 'delete' | 'import' | 'export' | 'approve';

/** Module 03 section 7.1. Written only by the catalogue sync. */
export class Permission extends Model<InferAttributes<Permission>, InferCreationAttributes<Permission>> {
  declare id: number | undefined;
  declare key: string;
  declare scope: PermissionScope;
  declare master: string;
  declare subMaster: string;
  declare action: PermissionAction;
  declare label: string;
  declare description: string | null;
  declare moduleNo: number;
  declare isPrivileged: boolean;
  declare sortOrder: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Permission.init(
      {
        id: idColumn,
        key: { type: DataTypes.STRING(80), allowNull: false },
        scope: { type: DataTypes.STRING(10), allowNull: false },
        master: { type: DataTypes.STRING(30), allowNull: false },
        subMaster: { type: DataTypes.STRING(30), allowNull: false },
        action: { type: DataTypes.STRING(10), allowNull: false },
        label: { type: DataTypes.STRING(120), allowNull: false },
        description: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        moduleNo: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
        isPrivileged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'permissions' },
    );
  }
}
