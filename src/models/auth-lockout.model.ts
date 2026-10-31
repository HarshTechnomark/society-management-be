import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export type LockoutScope = 'OTP' | 'MFA' | 'PASSWORD';

export class AuthLockout extends Model<InferAttributes<AuthLockout>, InferCreationAttributes<AuthLockout>> {
  declare id: number | undefined;
  declare scope: LockoutScope;
  declare subjectHash: string;
  declare userId: number | null;
  declare failedCount: number;
  declare windowStartedAt: Date;
  declare lastFailedAt: Date;
  declare lockedUntil: Date | null;
  declare lockCount: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    AuthLockout.init(
      {
        id: idColumn,
        scope: { type: DataTypes.STRING(10), allowNull: false },
        subjectHash: { type: DataTypes.CHAR(64), allowNull: false },
        userId: fkColumn(true),
        failedCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        windowStartedAt: dateColumn(false),
        lastFailedAt: dateColumn(false),
        lockedUntil: dateColumn(),
        lockCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'auth_lockouts' },
    );
  }
}
