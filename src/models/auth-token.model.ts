import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const TOKEN_PURPOSES = [
  'PASSWORD_RESET',
  'ACCOUNT_SETUP',
  'EMAIL_VERIFY',
  'LOGIN_CHALLENGE',
  'WEBAUTHN_CHALLENGE',
  'SIGNUP',
  'SUPPORT_HANDOFF',
] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export class AuthToken extends Model<InferAttributes<AuthToken>, InferCreationAttributes<AuthToken>> {
  declare id: number | undefined;
  declare tokenHash: string;
  declare purpose: TokenPurpose;
  declare userId: number | null;
  declare sessionId: number | null;
  declare payload: Record<string, any> | null;
  declare attemptCount: number;
  declare expiresAt: Date;
  declare consumedAt: Date | null;
  declare revokedAt: Date | null;
  declare ip: string | null;
  declare userAgent: string | null;
  declare createdBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    AuthToken.init(
      {
        id: idColumn,
        tokenHash: { type: DataTypes.CHAR(64), allowNull: false },
        purpose: { type: DataTypes.STRING(24), allowNull: false },
        userId: fkColumn(true),
        sessionId: fkColumn(true),
        payload: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        attemptCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        expiresAt: dateColumn(false),
        consumedAt: dateColumn(),
        revokedAt: dateColumn(),
        ip: { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
        userAgent: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'auth_tokens' },
    );
  }
}
