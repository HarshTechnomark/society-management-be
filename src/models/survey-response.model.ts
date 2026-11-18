import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 16 section 7.12: `survey_responses`. */
export class SurveyResponse extends Model<
  InferAttributes<SurveyResponse>,
  InferCreationAttributes<SurveyResponse>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare surveyId: number;
  declare questionId: number;
  declare submissionId: string;
  declare respondentKey: string;
  declare userId: number | null;
  declare unitId: number | null;
  declare optionKey: string | null;
  declare numberValue: number | null;
  declare textValue: string | null;
  declare dateValue: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    SurveyResponse.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        surveyId: fkColumn(false),
        questionId: fkColumn(false),
        submissionId: { type: DataTypes.CHAR(36), allowNull: false },
        respondentKey: { type: DataTypes.CHAR(64), allowNull: false },
        userId: fkColumn(true),
        unitId: fkColumn(true),
        optionKey: { type: DataTypes.STRING(4), allowNull: true, defaultValue: null },
        numberValue: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
        textValue: { type: DataTypes.STRING(1000), allowNull: true, defaultValue: null },
        dateValue: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'survey_responses' },
    );
  }
}
