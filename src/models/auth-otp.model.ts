import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const OTP_PURPOSES = ['LOGIN', 'SIGNUP', 'REAUTH', 'CHANGE_MOBILE'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];
export type OtpStatus = 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'SUPERSEDED' | 'FAILED';
export type OtpChannel = 'SMS' | 'WHATSAPP';

export class AuthOtp extends Model<InferAttributes<AuthOtp>, InferCreationAttributes<AuthOtp>> {
  declare id: number | undefined;
  declare challengeId: string;
  declare userId: number | null;
  declare mobile: string;
  declare purpose: OtpPurpose;
  declare channel: OtpChannel;
  declare codeHash: string;
  declare isDeliverable: boolean;
  declare status: OtpStatus;
  declare attemptCount: number;
  declare resendCount: number;
  declare sessionId: number | null;
  declare expiresAt: Date;
  declare resendAvailableAt: Date;
  declare verifiedAt: Date | null;
  declare ip: string | null;
  declare userAgent: string | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    AuthOtp.init(
      {
        id: idColumn,
        challengeId: { type: DataTypes.CHAR(28), allowNull: false },
        userId: fkColumn(true),
        mobile: { type: DataTypes.CHAR(10), allowNull: false },
        purpose: { type: DataTypes.STRING(20), allowNull: false },
        channel: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'SMS' },
        codeHash: { type: DataTypes.CHAR(64), allowNull: false },
        isDeliverable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PENDING' },
        attemptCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        resendCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        sessionId: fkColumn(true),
        expiresAt: dateColumn(false),
        resendAvailableAt: dateColumn(false),
        verifiedAt: dateColumn(),
        ip: { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
        userAgent: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        ...timestampColumns,
      },
      { sequelize, tableName: 'auth_otps' },
    );
  }
}
