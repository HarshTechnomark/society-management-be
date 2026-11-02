import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export type TicketAuthorSide = 'SOCIETY' | 'PLATFORM' | 'SYSTEM';
export type TicketMessageKind = 'MESSAGE' | 'STATUS_CHANGE' | 'ASSIGNMENT' | 'PRIORITY_CHANGE';
export type TicketVisibility = 'PUBLIC' | 'INTERNAL';

/** Module 07 section 7.3. Immutable once written: the hooks refuse updates and deletes. */
export class PlatformTicketMessage extends Model<
  InferAttributes<PlatformTicketMessage>,
  InferCreationAttributes<PlatformTicketMessage>
> {
  declare id: number | undefined;
  declare ticketId: number;
  declare societyId: number;
  declare authorUserId: number | null;
  declare authorSide: TicketAuthorSide;
  declare authorName: string;
  declare kind: TicketMessageKind;
  declare visibility: TicketVisibility;
  declare body: string;
  declare meta: Record<string, unknown> | null;
  declare attachmentCount: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    PlatformTicketMessage.init(
      {
        id: idColumn,
        ticketId: fkColumn(false),
        societyId: fkColumn(false),
        authorUserId: fkColumn(true),
        authorSide: { type: DataTypes.STRING(10), allowNull: false },
        authorName: { type: DataTypes.STRING(120), allowNull: false },
        kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'MESSAGE' },
        visibility: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PUBLIC' },
        body: { type: DataTypes.TEXT, allowNull: false },
        meta: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        attachmentCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'platform_ticket_messages',
        hooks: {
          beforeUpdate: () => {
            throw new Error('platform_ticket_messages rows are immutable');
          },
          beforeDestroy: () => {
            throw new Error('platform_ticket_messages rows are immutable');
          },
          beforeBulkUpdate: () => {
            throw new Error('platform_ticket_messages rows are immutable');
          },
          beforeBulkDestroy: () => {
            throw new Error('platform_ticket_messages rows are immutable');
          },
        },
      },
    );
  }
}
