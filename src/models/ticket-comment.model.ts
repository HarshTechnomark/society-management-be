import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { AuthorRole, CommentKind, Visibility } from '../modules/helpdesk/helpdesk.constants';

/** Module 15 section 7.4: public comment, internal note or system timeline entry. Never edited; only kind COMMENT is soft-deleted. */
export class TicketComment extends Model<
  InferAttributes<TicketComment>,
  InferCreationAttributes<TicketComment>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare ticketId: number;
  declare kind: CreationOptional<CommentKind>;
  declare visibility: CreationOptional<Visibility>;
  declare authorUserId: number | null;
  declare authorRole: AuthorRole;
  declare authorName: string;
  declare authorUnitId: number | null;
  declare body: string | null;
  declare fromStatus: string | null;
  declare toStatus: string | null;
  declare escalationRuleId: number | null;
  declare slaCycle: number | null;
  declare notifyAffected: CreationOptional<boolean>;
  declare metadata: Record<string, unknown> | null;
  declare deletedByUserId: number | null;
  declare deleteReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;

  static initModel(sequelize: Sequelize): void {
    TicketComment.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        ticketId: fkColumn(false),
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'COMMENT' },
        visibility: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PUBLIC' },
        authorUserId: fkColumn(true),
        authorRole: { type: DataTypes.STRING(10), allowNull: false },
        authorName: { type: DataTypes.STRING(120), allowNull: false },
        authorUnitId: fkColumn(true),
        body: { type: DataTypes.STRING(2000), allowNull: true, defaultValue: null },
        fromStatus: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        toStatus: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        escalationRuleId: fkColumn(true),
        slaCycle: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        notifyAffected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        metadata: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        deletedByUserId: fkColumn(true),
        deleteReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'ticket_comments', paranoid: true },
    );
  }
}
