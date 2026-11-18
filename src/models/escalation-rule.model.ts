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
  Designation,
  Priority,
  RuleStatus,
  TargetType,
  TriggerType,
} from '../modules/helpdesk/helpdesk.constants';

/** Module 15 section 7.7: an escalation rule (paranoid: fired timeline entries keep pointing at the row). */
export class EscalationRule extends Model<
  InferAttributes<EscalationRule>,
  InferCreationAttributes<EscalationRule>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare name: string;
  declare triggerType: TriggerType;
  declare thresholdPercent: number | null;
  declare level: number;
  declare categoryId: number | null;
  declare priority: Priority | null;
  declare targetType: TargetType;
  declare targetRoleKey: string | null;
  declare targetDesignation: Designation | null;
  declare targetUserId: number | null;
  declare notifyAssignee: CreationOptional<boolean>;
  declare status: CreationOptional<RuleStatus>;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;

  static initModel(sequelize: Sequelize): void {
    EscalationRule.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        name: { type: DataTypes.STRING(80), allowNull: false },
        triggerType: { type: DataTypes.STRING(20), allowNull: false },
        thresholdPercent: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        level: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
        categoryId: fkColumn(true),
        priority: { type: DataTypes.STRING(2), allowNull: true, defaultValue: null },
        targetType: { type: DataTypes.STRING(12), allowNull: false },
        targetRoleKey: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        targetDesignation: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        targetUserId: fkColumn(true),
        notifyAssignee: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'escalation_rules', paranoid: true },
    );
  }
}
