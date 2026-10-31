import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, idColumn, timestampColumns } from './_columns';

/** Module 01 section 7.1. */
export class Organization extends Model<
  InferAttributes<Organization>,
  InferCreationAttributes<Organization>
> {
  declare id: number | undefined;
  declare name: string;
  declare slug: string;
  declare status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  declare gstin: string | null;
  declare contactEmail: string | null;
  declare contactMobile: string | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;
  declare deletedAt: Date | null | undefined;

  static initModel(sequelize: Sequelize): void {
    Organization.init(
      {
        id: idColumn,
        name: { type: DataTypes.STRING(150), allowNull: false },
        slug: { type: DataTypes.STRING(60), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
        gstin: { type: DataTypes.STRING(15), allowNull: true, defaultValue: null },
        contactEmail: { type: DataTypes.STRING(254), allowNull: true, defaultValue: null },
        contactMobile: { type: DataTypes.CHAR(10), allowNull: true, defaultValue: null },
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'organizations', paranoid: true },
    );
  }
}
