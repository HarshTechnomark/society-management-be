import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const CLIENT_APPS = ['PLATFORM', 'ADMIN', 'RESIDENT', 'GATE', 'WORK'] as const;
export type ClientApp = (typeof CLIENT_APPS)[number];
export const AMR_VALUES = ['OTP', 'PASSWORD', 'TOTP', 'RECOVERY_CODE', 'PASSKEY', 'PIN', 'SSO'] as const;
export type Amr = (typeof AMR_VALUES)[number];
export const REVOKE_REASONS = [
  'LOGOUT',
  'USER_REVOKED',
  'ADMIN_REVOKED',
  'TOKEN_REUSE',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'MFA_RESET',
  'MFA_POLICY_CHANGED',
  'MOBILE_CHANGED',
  'USER_DISABLED',
  'IDLE_TIMEOUT',
  'EXPIRED',
  'DELETION_REQUESTED',
  'ACCOUNT_DELETED',
  'SUPPORT_GRANT_ENDED',
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export class Session extends Model<InferAttributes<Session>, InferCreationAttributes<Session>> {
  declare id: number | undefined;
  declare userId: number;
  declare clientApp: ClientApp;
  declare activeSocietyId: number | null;
  declare refreshTokenHash: string;
  declare previousTokenHash: string | null;
  declare rotatedAt: Date | null;
  declare rotationCount: number;
  declare amr: Amr[];
  declare mfaVerified: boolean;
  declare authTime: Date;
  declare lastSeenAt: Date;
  declare idleTimeoutMinutes: number;
  declare absoluteExpiresAt: Date;
  declare deviceIdHash: string | null;
  declare deviceLabel: string;
  declare userAgent: string | null;
  declare ipFirst: string | null;
  declare ipLast: string | null;
  declare revokedAt: Date | null;
  declare revokeReason: RevokeReason | null;
  declare revokedBy: number | null;
  declare supportGrantId: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Session.init(
      {
        id: idColumn,
        userId: fkColumn(false),
        clientApp: { type: DataTypes.STRING(10), allowNull: false },
        activeSocietyId: fkColumn(true),
        refreshTokenHash: { type: DataTypes.CHAR(64), allowNull: false },
        previousTokenHash: { type: DataTypes.CHAR(64), allowNull: true, defaultValue: null },
        rotatedAt: dateColumn(),
        rotationCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        amr: { type: DataTypes.JSON, allowNull: false },
        mfaVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        authTime: dateColumn(false),
        lastSeenAt: dateColumn(false),
        idleTimeoutMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        absoluteExpiresAt: dateColumn(false),
        deviceIdHash: { type: DataTypes.CHAR(64), allowNull: true, defaultValue: null },
        deviceLabel: { type: DataTypes.STRING(100), allowNull: false, defaultValue: 'Unknown device' },
        userAgent: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        ipFirst: { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
        ipLast: { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
        revokedAt: dateColumn(),
        revokeReason: { type: DataTypes.STRING(24), allowNull: true, defaultValue: null },
        revokedBy: fkColumn(true),
        supportGrantId: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'sessions' },
    );
  }
}
