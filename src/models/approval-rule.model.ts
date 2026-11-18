import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { RuleStep } from '../modules/approvals/approvals.types';

/** Module 14 section 7.1: one approval rule of a society (paranoid). The generated column `liveFlag` is not mapped. */
export class ApprovalRule extends Model<
  InferAttributes<ApprovalRule>,
  InferCreationAttributes<ApprovalRule>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare type: string;
  declare name: string;
  declare description: string | null;
  declare priority: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare isDefault: CreationOptional<boolean>;
  declare minAmountPaise: CreationOptional<number>;
  declare maxAmountPaise: number | null;
  declare categoryKeys: string[] | null;
  declare requesterRoleKeys: string[] | null;
  declare action: CreationOptional<'REQUIRE_APPROVAL' | 'AUTO_APPROVE'>;
  declare steps: CreationOptional<RuleStep[]>;
  declare fallbackRoleKeys: CreationOptional<string[]>;
  declare slaHours: CreationOptional<number>;
  declare reminderEveryHours: CreationOptional<number>;
  declare escalateAfterHours: number | null;
  declare escalationRoleKeys: CreationOptional<string[]>;
  declare escalationCanApprove: CreationOptional<boolean>;
  declare stepUpAbovePaise: number | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;

  static initModel(sequelize: Sequelize): void {
    ApprovalRule.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        type: { type: DataTypes.STRING(30), allowNull: false },
        name: { type: DataTypes.STRING(80), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        priority: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 100 },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        minAmountPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        maxAmountPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        categoryKeys: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        requesterRoleKeys: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        action: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'REQUIRE_APPROVAL' },
        steps: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
        fallbackRoleKeys: { type: DataTypes.JSON, allowNull: false, defaultValue: ['chairman'] },
        slaHours: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 48 },
        reminderEveryHours: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 24 },
        escalateAfterHours: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: 72 },
        escalationRoleKeys: { type: DataTypes.JSON, allowNull: false, defaultValue: ['chairman'] },
        escalationCanApprove: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        stepUpAbovePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'approval_rules', paranoid: true },
    );
  }
}
