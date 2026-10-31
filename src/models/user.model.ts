import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const USER_STATUSES = [
  'INVITED',
  'ACTIVE',
  'DISABLED',
  'PENDING_DELETION',
  'DELETED',
  'SYSTEM',
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const LOCALES = ['en-IN', 'hi-IN', 'mr-IN', 'gu-IN', 'ta-IN', 'te-IN', 'kn-IN', 'bn-IN'] as const;

/** Module 02 section 7.1. The default scope hides the secrets; scope `withSecrets` is used only inside the auth services. */
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: number | undefined;
  declare mobile: string | null;
  declare mobileVerifiedAt: Date | null;
  declare email: string | null;
  declare emailVerifiedAt: Date | null;
  declare name: string | null;
  declare photoFileId: number | null;
  declare locale: string;
  declare passwordHash: string | null;
  declare passwordChangedAt: Date | null;
  declare totpSecretEnc: string | null;
  declare totpLastUsedStep: number | null;
  declare mfaEnabledAt: Date | null;
  declare platformRoleId: number | null;
  declare status: UserStatus;
  declare statusReason: string | null;
  declare lastLoginAt: Date | null;
  declare lastSocietyId: number | null;
  declare deletionRequestedAt: Date | null;
  declare deletionScheduledFor: Date | null;
  declare anonymisedAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    User.init(
      {
        id: idColumn,
        mobile: { type: DataTypes.CHAR(10), allowNull: true, defaultValue: null },
        mobileVerifiedAt: dateColumn(),
        email: { type: DataTypes.STRING(254), allowNull: true, defaultValue: null },
        emailVerifiedAt: dateColumn(),
        name: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        photoFileId: fkColumn(true),
        locale: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'en-IN' },
        passwordHash: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        passwordChangedAt: dateColumn(),
        totpSecretEnc: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        totpLastUsedStep: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, defaultValue: null },
        mfaEnabledAt: dateColumn(),
        platformRoleId: fkColumn(true),
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
        statusReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        lastLoginAt: dateColumn(),
        lastSocietyId: fkColumn(true),
        deletionRequestedAt: dateColumn(),
        deletionScheduledFor: dateColumn(),
        anonymisedAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'users',
        defaultScope: { attributes: { exclude: ['passwordHash', 'totpSecretEnc'] } },
        scopes: { withSecrets: { attributes: { include: ['passwordHash', 'totpSecretEnc'] } } },
      },
    );
  }
}
