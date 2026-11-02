import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const ONBOARDING_STEP_KEYS = [
  'PROFILE',
  'STRUCTURE',
  'UNITS',
  'RESIDENTS',
  'BILLING',
  'PAYMENTS',
  'COMMITTEE',
  'GO_LIVE',
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];
export const ONBOARDING_STATUSES = ['PENDING', 'DONE', 'SKIPPED'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/** Module 08 section 7.4. Rows are created lazily and idempotently by `onboarding.ensureSteps` (BR-08-43). */
export class OnboardingStep extends Model<
  InferAttributes<OnboardingStep>,
  InferCreationAttributes<OnboardingStep>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare stepKey: OnboardingStepKey;
  declare stepNo: number;
  declare isRequired: boolean;
  declare status: OnboardingStatus;
  declare completedAt: Date | null;
  declare completedBy: number | null;
  declare skipReason: string | null;
  declare lastCheckSummary: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    OnboardingStep.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        stepKey: { type: DataTypes.STRING(12), allowNull: false },
        stepNo: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
        isRequired: { type: DataTypes.BOOLEAN, allowNull: false },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING' },
        completedAt: dateColumn(),
        completedBy: fkColumn(true),
        skipReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        lastCheckSummary: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'onboarding_steps' },
    );
  }
}
