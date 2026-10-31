import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { PermissionScope } from './permission.model';

export type RoleScope = PermissionScope;

/** Module 03 section 7.2. `societyKey` is a generated column and is never written. Optimistic version is checked by the service. */
export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: number | undefined;
  declare societyId: number | null;
  declare scope: RoleScope;
  declare key: string;
  declare name: string;
  declare description: string | null;
  declare isSystem: boolean;
  declare requiresMfa: boolean;
  declare consumesSeat: boolean;
  declare basedOnRoleId: number | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;
  declare deletedAt: Date | null | undefined;

  static initModel(sequelize: Sequelize): void {
    Role.init(
      {
        id: idColumn,
        societyId: fkColumn(true),
        scope: { type: DataTypes.STRING(10), allowNull: false },
        key: { type: DataTypes.STRING(80), allowNull: false },
        name: { type: DataTypes.STRING(80), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        requiresMfa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        consumesSeat: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        basedOnRoleId: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'roles', paranoid: true },
    );
    // System roles are never deleted (BR-03-6)
    Role.beforeDestroy(r => {
      if (r.isSystem) throw new Error('System roles cannot be deleted');
    });
  }
}
