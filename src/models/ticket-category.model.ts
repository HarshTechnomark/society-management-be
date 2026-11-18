import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type {
  CategoryScope,
  CategoryStatus,
  DefaultAssigneeType,
  Priority,
} from '../modules/helpdesk/helpdesk.constants';

/** Module 15 section 7.1: a ticket category or sub-category (two levels). Not paranoid; archived by status. The generated columns `parentKey` and `activeNameKey` are not mapped. */
export class TicketCategory extends Model<
  InferAttributes<TicketCategory>,
  InferCreationAttributes<TicketCategory>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare parentId: number | null;
  declare name: string;
  declare scope: CategoryScope;
  declare icon: string | null;
  declare defaultPriority: Priority | null;
  declare slaPolicyId: number | null;
  declare defaultAssigneeType: CreationOptional<DefaultAssigneeType>;
  declare defaultRoleKey: string | null;
  declare defaultAssigneeUserId: number | null;
  declare defaultStaffId: number | null;
  declare defaultVendorId: number | null;
  declare isChargeable: CreationOptional<boolean>;
  declare requiresAfterPhoto: CreationOptional<boolean>;
  declare isSafety: CreationOptional<boolean>;
  declare linksInvoice: CreationOptional<boolean>;
  declare sortOrder: CreationOptional<number>;
  declare status: CreationOptional<CategoryStatus>;
  declare archivedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    TicketCategory.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        parentId: fkColumn(true),
        name: { type: DataTypes.STRING(60), allowNull: false },
        scope: { type: DataTypes.STRING(10), allowNull: false },
        icon: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        defaultPriority: { type: DataTypes.STRING(2), allowNull: true, defaultValue: null },
        slaPolicyId: fkColumn(true),
        defaultAssigneeType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'NONE' },
        defaultRoleKey: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        defaultAssigneeUserId: fkColumn(true),
        defaultStaffId: fkColumn(true),
        defaultVendorId: fkColumn(true),
        isChargeable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        requiresAfterPhoto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        isSafety: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        linksInvoice: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        archivedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'ticket_categories' },
    );
  }
}
