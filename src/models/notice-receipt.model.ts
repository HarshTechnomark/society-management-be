import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { ReceiptRelation, Channel } from '../modules/communication/communication.constants';

/** Module 16 section 7.2: `notice_receipts`. */
export class NoticeReceipt extends Model<
  InferAttributes<NoticeReceipt>,
  InferCreationAttributes<NoticeReceipt>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare noticeId: number;
  declare recipientKey: string;
  declare userId: number | null;
  declare residentId: number | null;
  declare unitId: number | null;
  declare relation: ReceiptRelation | null;
  declare reachedAt: Date | null;
  declare reachedVia: Channel | null;
  declare firstReadAt: Date | null;
  declare readCount: CreationOptional<number>;
  declare acknowledgedAt: Date | null;
  declare ackRevisionNo: number | null;
  declare ackIp: string | null;
  declare ackUserAgent: string | null;
  declare remindersSent: CreationOptional<number>;
  declare lastRemindedAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    NoticeReceipt.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        noticeId: fkColumn(false),
        recipientKey: { type: DataTypes.STRING(40), allowNull: false },
        userId: fkColumn(true),
        residentId: fkColumn(true),
        unitId: fkColumn(true),
        relation: { type: DataTypes.STRING(12), allowNull: true, defaultValue: null },
        reachedAt: dateColumn(),
        reachedVia: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        firstReadAt: dateColumn(),
        readCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        acknowledgedAt: dateColumn(),
        ackRevisionNo: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        ackIp: { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
        ackUserAgent: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        remindersSent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastRemindedAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'notice_receipts' },
    );
  }
}
