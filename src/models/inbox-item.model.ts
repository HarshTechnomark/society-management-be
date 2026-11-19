import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { TemplateScope, DeliveryClass, Tone } from '../modules/communication/communication.constants';

/** Module 16 section 7.5: `inbox_items`. */
export class InboxItem extends Model<InferAttributes<InboxItem>, InferCreationAttributes<InboxItem>> {
  declare id: CreationOptional<number>;
  declare scope: TemplateScope;
  declare societyId: number | null;
  declare userId: number;
  declare batchId: string;
  declare templateKey: string;
  declare category: string;
  declare deliveryClass: DeliveryClass;
  declare tone: CreationOptional<Tone>;
  declare title: string;
  declare body: string;
  declare deepLink: string | null;
  declare sourceType: string | null;
  declare sourceId: number | null;
  declare dedupeKey: string | null;
  declare readAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    InboxItem.init(
      {
        id: idColumn,
        scope: { type: DataTypes.STRING(10), allowNull: false },
        societyId: fkColumn(true),
        userId: fkColumn(false),
        batchId: { type: DataTypes.CHAR(36), allowNull: false },
        templateKey: { type: DataTypes.STRING(80), allowNull: false },
        category: { type: DataTypes.STRING(12), allowNull: false },
        deliveryClass: { type: DataTypes.STRING(15), allowNull: false },
        tone: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'info' },
        title: { type: DataTypes.STRING(150), allowNull: false },
        body: { type: DataTypes.STRING(1000), allowNull: false },
        deepLink: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        sourceType: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        sourceId: fkColumn(true),
        dedupeKey: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        readAt: dateColumn(),
        ...timestampColumns,
      },
      { sequelize, tableName: 'inbox_items' },
    );
  }
}
