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
  NoticeKind,
  NoticeCategory,
  NoticePriority,
  NoticeStatus,
  AudienceType,
  AudienceRelation,
  NoticeExtraChannel,
  UtilityType,
} from '../modules/communication/communication.constants';

/** Module 16 section 7.1: `notices`. */
export interface NoticeActionRow {
  type: 'PAY_COLLECTION' | 'PAY_DUES' | 'RSVP' | 'VOTE' | 'LINK';
  refId?: number;
  url?: string;
  label?: string;
}
export class Notice extends Model<InferAttributes<Notice>, InferCreationAttributes<Notice>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare kind: CreationOptional<NoticeKind>;
  declare category: CreationOptional<NoticeCategory>;
  declare priority: CreationOptional<NoticePriority>;
  declare title: string;
  declare body: string;
  declare bodyText: string;
  declare locale: CreationOptional<string>;
  declare status: CreationOptional<NoticeStatus>;
  declare audienceType: CreationOptional<AudienceType>;
  declare audienceRelation: CreationOptional<AudienceRelation>;
  declare audienceIds: number[] | null;
  declare audienceRoleKeys: string[] | null;
  declare channels: CreationOptional<NoticeExtraChannel[]>;
  declare actions: NoticeActionRow[] | null;
  declare requiresAck: CreationOptional<boolean>;
  declare ackDueAt: Date | null;
  declare isPinned: CreationOptional<boolean>;
  declare pinnedAt: Date | null;
  declare scheduledAt: Date | null;
  declare expiresAt: Date | null;
  declare utilityType: UtilityType | null;
  declare outageStartsAt: Date | null;
  declare outageEndsAt: Date | null;
  declare restoredAt: Date | null;
  declare startReminderSentAt: Date | null;
  declare sourceModule: string | null;
  declare sourceRefType: string | null;
  declare sourceRefId: number | null;
  declare approvalRequestId: number | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare lastDecisionReason: string | null;
  declare publishedAt: Date | null;
  declare publishedBy: number | null;
  declare fanoutCompletedAt: Date | null;
  declare expiredAt: Date | null;
  declare recalledAt: Date | null;
  declare recalledBy: number | null;
  declare recallReason: string | null;
  declare archivedAt: Date | null;
  declare revisionNo: CreationOptional<number>;
  declare lastEditNote: string | null;
  declare recipientCount: CreationOptional<number>;
  declare unitCount: CreationOptional<number>;
  declare reachedCount: CreationOptional<number>;
  declare readCount: CreationOptional<number>;
  declare ackCount: CreationOptional<number>;
  declare remindersSent: CreationOptional<number>;
  declare lastRemindedAt: Date | null;
  declare attachmentCount: CreationOptional<number>;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare deletedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Notice.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'STANDARD' },
        category: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'GENERAL' },
        priority: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'NORMAL' },
        title: { type: DataTypes.STRING(150), allowNull: false },
        body: { type: DataTypes.TEXT('medium'), allowNull: false },
        bodyText: { type: DataTypes.TEXT, allowNull: false },
        locale: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'en-IN' },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        audienceType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ALL' },
        audienceRelation: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ANY' },
        audienceIds: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        audienceRoleKeys: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        channels: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
        actions: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        requiresAck: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        ackDueAt: dateColumn(),
        isPinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        pinnedAt: dateColumn(),
        scheduledAt: dateColumn(),
        expiresAt: dateColumn(),
        utilityType: { type: DataTypes.STRING(12), allowNull: true, defaultValue: null },
        outageStartsAt: dateColumn(),
        outageEndsAt: dateColumn(),
        restoredAt: dateColumn(),
        startReminderSentAt: dateColumn(),
        sourceModule: { type: DataTypes.CHAR(2), allowNull: true, defaultValue: null },
        sourceRefType: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        sourceRefId: fkColumn(true),
        approvalRequestId: fkColumn(true),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        lastDecisionReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        publishedAt: dateColumn(),
        publishedBy: fkColumn(true),
        fanoutCompletedAt: dateColumn(),
        expiredAt: dateColumn(),
        recalledAt: dateColumn(),
        recalledBy: fkColumn(true),
        recallReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        archivedAt: dateColumn(),
        revisionNo: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        lastEditNote: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        recipientCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        unitCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        reachedCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        readCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        ackCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        remindersSent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastRemindedAt: dateColumn(),
        attachmentCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        deletedAt: dateColumn(),
        ...timestampColumns,
      },
      { sequelize, tableName: 'notices', paranoid: true },
    );
  }
}
