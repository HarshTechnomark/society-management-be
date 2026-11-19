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
  TemplateScope,
  TemplateCategory,
  DeliveryClass,
  Channel,
} from '../modules/communication/communication.constants';

/** Module 16 section 7.3: `notification_templates`. */
export interface VariableSpec {
  type: 'string' | 'number' | 'money' | 'date' | 'datetime' | 'url';
  required?: boolean;
  maxLength?: number;
}
export class NotificationTemplate extends Model<
  InferAttributes<NotificationTemplate>,
  InferCreationAttributes<NotificationTemplate>
> {
  declare id: CreationOptional<number>;
  declare templateKey: string;
  declare locale: CreationOptional<string>;
  declare module: string;
  declare scope: TemplateScope;
  declare category: TemplateCategory;
  declare deliveryClass: CreationOptional<DeliveryClass>;
  declare defaultChannels: Channel[];
  declare allowedChannels: Channel[];
  declare variablesSchema: Record<string, VariableSpec>;
  declare countsTowardLimit: CreationOptional<boolean>;
  declare allowEndedMembers: CreationOptional<boolean>;
  declare sendWhenClosed: CreationOptional<boolean>;
  declare deepLink: string | null;
  declare inAppTitle: string | null;
  declare inAppBody: string | null;
  declare pushTitle: string | null;
  declare pushBody: string | null;
  declare smsBody: string | null;
  declare smsDltTemplateId: string | null;
  declare smsDltCategory: string | null;
  declare whatsappTemplateName: string | null;
  declare whatsappCategory: string | null;
  declare whatsappParams: string[] | null;
  declare whatsappButtonVar: string | null;
  declare whatsappStatus: string | null;
  declare emailSubject: string | null;
  declare emailHtml: string | null;
  declare emailText: string | null;
  declare isActive: CreationOptional<boolean>;
  declare textEditedAt: Date | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    NotificationTemplate.init(
      {
        id: idColumn,
        templateKey: { type: DataTypes.STRING(80), allowNull: false },
        locale: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'en-IN' },
        module: { type: DataTypes.CHAR(2), allowNull: false },
        scope: { type: DataTypes.STRING(10), allowNull: false },
        category: { type: DataTypes.STRING(12), allowNull: false },
        deliveryClass: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'STANDARD' },
        defaultChannels: { type: DataTypes.JSON, allowNull: false },
        allowedChannels: { type: DataTypes.JSON, allowNull: false },
        variablesSchema: { type: DataTypes.JSON, allowNull: false },
        countsTowardLimit: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        allowEndedMembers: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        sendWhenClosed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        deepLink: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        inAppTitle: { type: DataTypes.STRING(150), allowNull: true, defaultValue: null },
        inAppBody: { type: DataTypes.STRING(1000), allowNull: true, defaultValue: null },
        pushTitle: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
        pushBody: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        smsBody: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        smsDltTemplateId: { type: DataTypes.STRING(25), allowNull: true, defaultValue: null },
        smsDltCategory: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        whatsappTemplateName: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        whatsappCategory: { type: DataTypes.STRING(15), allowNull: true, defaultValue: null },
        whatsappParams: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        whatsappButtonVar: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        whatsappStatus: { type: DataTypes.STRING(12), allowNull: true, defaultValue: null },
        emailSubject: { type: DataTypes.STRING(150), allowNull: true, defaultValue: null },
        emailHtml: { type: DataTypes.TEXT('medium'), allowNull: true, defaultValue: null },
        emailText: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        textEditedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'notification_templates' },
    );
  }
}
