import { Model, type InferAttributes, type InferCreationAttributes, type Sequelize } from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 03 section 7.3. Rows are never updated: a change deletes and inserts. */
export class RolePermission extends Model<
  InferAttributes<RolePermission>,
  InferCreationAttributes<RolePermission>
> {
  declare id: number | undefined;
  declare societyId: number | null;
  declare roleId: number;
  declare permissionId: number;
  declare createdBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    RolePermission.init(
      {
        id: idColumn,
        societyId: fkColumn(true),
        roleId: fkColumn(false),
        permissionId: fkColumn(false),
        createdBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'role_permissions' },
    );
  }
}
