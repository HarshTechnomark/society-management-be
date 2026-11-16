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
  AudienceType,
  CollectionAmountMode,
  CollectionKind,
  CollectionStatus,
  PayListVisibility,
} from '../modules/payments/payments.constants';

/** Module 12 section 7.8 festival, event and other one-time collection drives. Paranoid; `beforeDestroy` throws unless DRAFT or REJECTED. The generated column `titleKey` is not mapped. */
export class Collection extends Model<InferAttributes<Collection>, InferCreationAttributes<Collection>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare title: string;
  declare kind: CreationOptional<CollectionKind>;
  declare purpose: string;
  declare amountMode: CollectionAmountMode;
  declare amountPerUnitPaise: CreationOptional<number>;
  declare minAmountPaise: CreationOptional<number>;
  declare isMandatory: CreationOptional<boolean>;
  declare audienceType: CreationOptional<AudienceType>;
  declare audienceIds: number[] | null;
  declare includeVacant: CreationOptional<boolean>;
  declare targetPaise: number;
  declare dueDate: string;
  declare fundId: number;
  declare payListVisibility: CreationOptional<PayListVisibility>;
  declare sendNotice: CreationOptional<boolean>;
  declare status: CreationOptional<CollectionStatus>;
  declare requestCount: CreationOptional<number>;
  declare paidCount: CreationOptional<number>;
  declare contributorCount: CreationOptional<number>;
  declare collectedPaise: CreationOptional<number>;
  declare reminderCount: CreationOptional<number>;
  declare lastReminderAt: Date | null;
  declare approvalRequestId: number | null;
  declare submittedAt: Date | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare publishedAt: Date | null;
  declare publishedBy: number | null;
  declare noticeId: number | null;
  declare closedAt: Date | null;
  declare closedBy: number | null;
  declare closeReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: CreationOptional<number>;
  declare deletedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Collection.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        title: { type: DataTypes.STRING(80), allowNull: false },
        kind: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'FESTIVAL' },
        purpose: { type: DataTypes.STRING(1000), allowNull: false },
        amountMode: { type: DataTypes.STRING(15), allowNull: false },
        amountPerUnitPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        minAmountPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        isMandatory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        audienceType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ALL' },
        audienceIds: { type: DataTypes.JSON, allowNull: true },
        includeVacant: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        targetPaise: { type: DataTypes.BIGINT, allowNull: false },
        dueDate: { type: DataTypes.DATEONLY, allowNull: false },
        fundId: fkColumn(false),
        payListVisibility: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'COUNT_ONLY' },
        sendNotice: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DRAFT' },
        requestCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        paidCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        contributorCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        collectedPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        reminderCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastReminderAt: dateColumn(),
        approvalRequestId: fkColumn(true),
        submittedAt: dateColumn(),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        rejectedReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        publishedAt: dateColumn(),
        publishedBy: fkColumn(true),
        noticeId: fkColumn(true),
        closedAt: dateColumn(),
        closedBy: fkColumn(true),
        closeReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        deletedAt: dateColumn(),
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'collections',
        paranoid: true,
        hooks: {
          beforeDestroy: row => {
            if (row.status !== 'DRAFT' && row.status !== 'REJECTED')
              throw new Error('Only DRAFT and REJECTED collections can be deleted');
          },
        },
      },
    );
  }
}
