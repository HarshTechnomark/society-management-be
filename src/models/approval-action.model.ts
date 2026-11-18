import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn } from './_columns';
import { now } from '../lib/clock';
import type { ActionKind, SlotType } from '../modules/approvals/approvals.constants';
import { immutableHooks } from './_immutable';

/**
 * Module 14 section 7.3: append-only decision log, no `updatedAt`. Update and destroy throw (purge uses a raw scoped delete).
 * The generated columns `approvalPrincipal` and `approvalActor` are not mapped; their unique keys back BR-14-8.
 */
export class ApprovalAction extends Model<
  InferAttributes<ApprovalAction>,
  InferCreationAttributes<ApprovalAction>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare requestId: number;
  declare round: number;
  declare stepNo: number | null;
  declare action: ActionKind;
  declare actorUserId: number | null;
  declare onBehalfOfUserId: number | null;
  declare delegationId: number | null;
  declare actorRoleKey: string | null;
  declare actorName: string | null;
  declare slotType: SlotType | null;
  declare slotRef: string | null;
  declare comment: string | null;
  declare authTime: Date | null;
  declare ip: string | null;
  declare createdAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const s = (n: number) => ({ type: DataTypes.STRING(n), allowNull: true, defaultValue: null });
    ApprovalAction.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        requestId: fkColumn(false),
        round: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
        stepNo: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        action: { type: DataTypes.STRING(20), allowNull: false },
        actorUserId: fkColumn(true),
        onBehalfOfUserId: fkColumn(true),
        delegationId: fkColumn(true),
        actorRoleKey: s(40),
        actorName: s(120),
        slotType: s(12),
        slotRef: s(40),
        comment: s(500),
        authTime: dateColumn(),
        ip: s(45),
        createdAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: () => now() },
      },
      {
        sequelize,
        tableName: 'approval_actions',
        updatedAt: false,
        hooks: immutableHooks('approval_actions', []),
      },
    );
  }
}
