import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { PushApp, PushRevokeReason } from '../modules/communication/communication.constants';

/** Module 16 section 7.7: `push_subscriptions`. */
export class PushSubscription extends Model<
  InferAttributes<PushSubscription>,
  InferCreationAttributes<PushSubscription>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare sessionId: number | null;
  declare app: PushApp;
  declare endpoint: string;
  declare endpointHash: string;
  declare p256dh: string;
  declare authSecretEnc: Buffer;
  declare expirationTime: Date | null;
  declare userAgent: string | null;
  declare deviceLabel: string | null;
  declare status: CreationOptional<string>;
  declare revokedReason: PushRevokeReason | null;
  declare revokedAt: Date | null;
  declare lastSuccessAt: Date | null;
  declare lastFailureAt: Date | null;
  declare consecutiveFailures: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    PushSubscription.init(
      {
        id: idColumn,
        userId: fkColumn(false),
        sessionId: fkColumn(true),
        app: { type: DataTypes.STRING(10), allowNull: false },
        endpoint: { type: DataTypes.STRING(1000), allowNull: false },
        endpointHash: { type: DataTypes.CHAR(64), allowNull: false },
        p256dh: { type: DataTypes.STRING(100), allowNull: false },
        authSecretEnc: { type: DataTypes.BLOB, allowNull: false },
        expirationTime: dateColumn(),
        userAgent: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        deviceLabel: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        revokedReason: { type: DataTypes.STRING(12), allowNull: true, defaultValue: null },
        revokedAt: dateColumn(),
        lastSuccessAt: dateColumn(),
        lastFailureAt: dateColumn(),
        consecutiveFailures: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'push_subscriptions' },
    );
  }
}
