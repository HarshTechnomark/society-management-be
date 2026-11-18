import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { QuietHoursMode } from '../modules/communication/communication.constants';

/** Module 16 section 7.6: `notification_preferences`. */
export class NotificationPreference extends Model<
  InferAttributes<NotificationPreference>,
  InferCreationAttributes<NotificationPreference>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare locale: string | null;
  declare channelMatrix: CreationOptional<Record<string, Record<string, boolean>>>;
  declare quietHoursMode: CreationOptional<QuietHoursMode>;
  declare quietHoursStart: string | null;
  declare quietHoursEnd: string | null;
  declare whatsappOptIn: CreationOptional<boolean>;
  declare whatsappOptInAt: Date | null;
  declare whatsappOptInSource: string | null;
  declare whatsappOptOutAt: Date | null;
  declare emailBouncedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    NotificationPreference.init(
      {
        id: idColumn,
        userId: fkColumn(false),
        locale: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        channelMatrix: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
        quietHoursMode: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'SOCIETY_DEFAULT' },
        quietHoursStart: { type: DataTypes.TIME, allowNull: true, defaultValue: null },
        quietHoursEnd: { type: DataTypes.TIME, allowNull: true, defaultValue: null },
        whatsappOptIn: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        whatsappOptInAt: dateColumn(),
        whatsappOptInSource: { type: DataTypes.STRING(15), allowNull: true, defaultValue: null },
        whatsappOptOutAt: dateColumn(),
        emailBouncedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'notification_preferences' },
    );
  }
}
