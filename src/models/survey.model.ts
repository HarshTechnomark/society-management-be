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
  SurveyStatus,
  ResponseScope,
  ResultsVisibility,
  AudienceRelation,
} from '../modules/communication/communication.constants';

/** Module 16 section 7.10: `surveys`. */
export class Survey extends Model<InferAttributes<Survey>, InferCreationAttributes<Survey>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare title: string;
  declare description: string | null;
  declare status: CreationOptional<SurveyStatus>;
  declare isAnonymous: CreationOptional<boolean>;
  declare responseScope: CreationOptional<ResponseScope>;
  declare resultsVisibility: CreationOptional<ResultsVisibility>;
  declare audienceType: CreationOptional<string>;
  declare audienceRelation: CreationOptional<AudienceRelation>;
  declare audienceIds: number[] | null;
  declare openedAt: Date | null;
  declare closesAt: Date | null;
  declare closedAt: Date | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare reminderSentAt: Date | null;
  declare recipientCount: CreationOptional<number>;
  declare responseCount: CreationOptional<number>;
  declare questionCount: CreationOptional<number>;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare deletedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Survey.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        title: { type: DataTypes.STRING(150), allowNull: false },
        description: { type: DataTypes.STRING(2000), allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'DRAFT' },
        isAnonymous: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        responseScope: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PERSON' },
        resultsVisibility: { type: DataTypes.STRING(25), allowNull: false, defaultValue: 'ADMINS' },
        audienceType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ALL' },
        audienceRelation: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ANY' },
        audienceIds: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        openedAt: dateColumn(),
        closesAt: dateColumn(),
        closedAt: dateColumn(),
        cancelledAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        reminderSentAt: dateColumn(),
        recipientCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        responseCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        questionCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        deletedAt: dateColumn(),
        ...timestampColumns,
      },
      { sequelize, tableName: 'surveys', paranoid: true },
    );
  }
}
