import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { RequestStatus, RequesterKind, Routing } from '../modules/approvals/approvals.constants';
import type { RuleSnapshot, StepOverride } from '../modules/approvals/approvals.types';

/** Module 14 section 7.2: one approval request. Never deleted. The generated column `openFlag` is not mapped. */
export class ApprovalRequest extends Model<
  InferAttributes<ApprovalRequest>,
  InferCreationAttributes<ApprovalRequest>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare type: string;
  declare entityType: string;
  declare entityId: number;
  declare title: string;
  declare summary: string | null;
  declare categoryKey: string | null;
  declare unitId: number | null;
  declare amountPaise: CreationOptional<number>;
  declare payload: Record<string, unknown>;
  declare payloadHash: string;
  declare status: CreationOptional<RequestStatus>;
  declare routing: Routing;
  declare ruleId: number | null;
  declare ruleVersion: number | null;
  declare ruleSnapshot: RuleSnapshot | null;
  declare stepOverrides: StepOverride[] | null;
  declare totalSteps: CreationOptional<number>;
  declare currentStepNo: CreationOptional<number>;
  declare round: CreationOptional<number>;
  declare requesterUserId: number;
  declare requesterKind: RequesterKind;
  declare requesterRoleKey: string | null;
  declare residentVisible: CreationOptional<boolean>;
  declare stepUpRequired: CreationOptional<boolean>;
  declare stepUpAbovePaise: number | null;
  declare allowBulk: CreationOptional<boolean>;
  declare hasEligibleApprover: CreationOptional<boolean>;
  declare stuckAt: Date | null;
  declare stepStartedAt: Date | null;
  declare dueAt: Date | null;
  declare nextReminderAt: Date | null;
  declare reminderCount: CreationOptional<number>;
  declare escalateAt: Date | null;
  declare escalatedAt: Date | null;
  declare expiresAt: Date | null;
  declare changesDueAt: Date | null;
  declare decidedAt: Date | null;
  declare decidedByUserId: number | null;
  declare decisionReason: string | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const nullable = (type: any) => ({ type, allowNull: true, defaultValue: null });
    ApprovalRequest.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        type: { type: DataTypes.STRING(30), allowNull: false },
        entityType: { type: DataTypes.STRING(40), allowNull: false },
        entityId: fkColumn(false),
        title: { type: DataTypes.STRING(200), allowNull: false },
        summary: nullable(DataTypes.STRING(500)),
        categoryKey: nullable(DataTypes.STRING(40)),
        unitId: fkColumn(true),
        amountPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        payload: { type: DataTypes.JSON, allowNull: false },
        payloadHash: { type: DataTypes.CHAR(64), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PENDING' },
        routing: { type: DataTypes.STRING(15), allowNull: false },
        ruleId: fkColumn(true),
        ruleVersion: nullable(DataTypes.INTEGER.UNSIGNED),
        ruleSnapshot: nullable(DataTypes.JSON),
        stepOverrides: nullable(DataTypes.JSON),
        totalSteps: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        currentStepNo: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        round: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        requesterUserId: fkColumn(false),
        requesterKind: { type: DataTypes.STRING(10), allowNull: false },
        requesterRoleKey: nullable(DataTypes.STRING(40)),
        residentVisible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        stepUpRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        stepUpAbovePaise: nullable(DataTypes.BIGINT),
        allowBulk: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        hasEligibleApprover: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        stuckAt: dateColumn(),
        stepStartedAt: dateColumn(),
        dueAt: dateColumn(),
        nextReminderAt: dateColumn(),
        reminderCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        escalateAt: dateColumn(),
        escalatedAt: dateColumn(),
        expiresAt: dateColumn(),
        changesDueAt: dateColumn(),
        decidedAt: dateColumn(),
        decidedByUserId: fkColumn(true),
        decisionReason: nullable(DataTypes.STRING(500)),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'approval_requests',
        hooks: {
          beforeDestroy: () => {
            throw new Error('approval_requests rows are never deleted');
          },
        },
      },
    );
  }
}
