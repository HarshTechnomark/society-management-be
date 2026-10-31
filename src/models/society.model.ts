import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export const SOCIETY_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CLOSED'] as const;
export type SocietyStatus = (typeof SOCIETY_STATUSES)[number];

/** Module 01 section 7.2 (core columns). Module 05 adds the lifecycle columns. `logoFileId` has no foreign key yet. */
export class Society extends Model<InferAttributes<Society>, InferCreationAttributes<Society>> {
  declare id: number | undefined;
  declare organizationId: number | null;
  declare name: string;
  declare legalName: string | null;
  declare slug: string;
  declare registrationNo: string | null;
  declare gstin: string | null;
  declare addressLine1: string;
  declare addressLine2: string | null;
  declare city: string;
  declare state: string;
  declare pincode: string;
  declare timezone: string;
  declare locale: string;
  declare fyStartMonth: number;
  declare status: SocietyStatus;
  declare logoFileId: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Society.init(
      {
        id: idColumn,
        organizationId: fkColumn(true),
        name: { type: DataTypes.STRING(150), allowNull: false },
        legalName: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        slug: { type: DataTypes.STRING(60), allowNull: false },
        registrationNo: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        gstin: { type: DataTypes.STRING(15), allowNull: true, defaultValue: null },
        addressLine1: { type: DataTypes.STRING(200), allowNull: false },
        addressLine2: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        city: { type: DataTypes.STRING(80), allowNull: false },
        state: { type: DataTypes.STRING(60), allowNull: false },
        pincode: { type: DataTypes.CHAR(6), allowNull: false },
        timezone: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'Asia/Kolkata' },
        locale: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'en-IN' },
        fyStartMonth: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 4 },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TRIAL' },
        logoFileId: fkColumn(true),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'societies' },
    );
  }
}
