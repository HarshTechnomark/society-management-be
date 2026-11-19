import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type { QuestionType } from '../modules/communication/communication.constants';

/** Module 16 section 7.11: `survey_questions`. */
export class SurveyQuestion extends Model<
  InferAttributes<SurveyQuestion>,
  InferCreationAttributes<SurveyQuestion>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare surveyId: number;
  declare position: number;
  declare type: QuestionType;
  declare prompt: string;
  declare helpText: string | null;
  declare isRequired: CreationOptional<boolean>;
  declare options: { key: string; label: string }[] | null;
  declare maxSelections: number | null;
  declare minValue: number | null;
  declare maxValue: number | null;
  declare maxLength: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    SurveyQuestion.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        surveyId: fkColumn(false),
        position: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
        type: { type: DataTypes.STRING(15), allowNull: false },
        prompt: { type: DataTypes.STRING(300), allowNull: false },
        helpText: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        isRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        options: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        maxSelections: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        minValue: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
        maxValue: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
        maxLength: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'survey_questions' },
    );
  }
}
