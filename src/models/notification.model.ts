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
  DeliveryClass,
  ExternalChannel,
  NotificationStatus,
  SkipReason,
} from '../modules/communication/communication.constants';

/** Module 16 section 7.4: `notifications`. */
export class Notification extends Model<
  InferAttributes<Notification>,
  InferCreationAttributes<Notification>
> {
  declare id: CreationOptional<number>;
  declare societyId: number | null;
  declare batchId: string;
  declare templateKey: string;
  declare locale: string;
  declare deliveryClass: DeliveryClass;
  declare channel: ExternalChannel;
  declare userId: number | null;
  declare recipientKey: string;
  declare destinationMasked: string | null;
  declare destinationEnc: Buffer | null;
  declare status: CreationOptional<NotificationStatus>;
  declare skipReason: SkipReason | null;
  declare dedupeKey: string | null;
  declare attempts: CreationOptional<number>;
  declare maxAttempts: CreationOptional<number>;
  declare nextAttemptAt: Date | null;
  declare providerKey: string | null;
  declare providerMessageId: string | null;
  declare lastErrorCode: string | null;
  declare lastErrorMessage: string | null;
  declare limitKey: string | null;
  declare limitConsumedAt: Date | null;
  declare limitBypassed: CreationOptional<boolean>;
  declare fallbackFromId: number | null;
  declare dataEnc: Buffer | null;
  declare sourceType: string | null;
  declare sourceId: number | null;
  declare sentAt: Date | null;
  declare deliveredAt: Date | null;
  declare readAt: Date | null;
  declare failedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Notification.init(
      {
        id: idColumn,
        societyId: fkColumn(true),
        batchId: { type: DataTypes.CHAR(36), allowNull: false },
        templateKey: { type: DataTypes.STRING(80), allowNull: false },
        locale: { type: DataTypes.STRING(10), allowNull: false },
        deliveryClass: { type: DataTypes.STRING(15), allowNull: false },
        channel: { type: DataTypes.STRING(10), allowNull: false },
        userId: fkColumn(true),
        recipientKey: { type: DataTypes.STRING(80), allowNull: false },
        destinationMasked: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
        destinationEnc: { type: DataTypes.BLOB, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'QUEUED' },
        skipReason: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        dedupeKey: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        attempts: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        maxAttempts: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 5 },
        nextAttemptAt: dateColumn(),
        providerKey: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        providerMessageId: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        lastErrorCode: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        lastErrorMessage: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        limitKey: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        limitConsumedAt: dateColumn(),
        limitBypassed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        fallbackFromId: fkColumn(true),
        dataEnc: { type: DataTypes.BLOB, allowNull: true, defaultValue: null },
        sourceType: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        sourceId: fkColumn(true),
        sentAt: dateColumn(),
        deliveredAt: dateColumn(),
        readAt: dateColumn(),
        failedAt: dateColumn(),
        ...timestampColumns,
      },
      { sequelize, tableName: 'notifications' },
    );
  }
}
