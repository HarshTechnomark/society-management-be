import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { UpvoteSource } from '../modules/helpdesk/helpdesk.constants';

/** Module 15 section 7.5: a "Me too" on a building issue (hard delete on removal). */
export class TicketUpvote extends Model<
  InferAttributes<TicketUpvote>,
  InferCreationAttributes<TicketUpvote>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare ticketId: number;
  declare userId: number;
  declare unitId: number | null;
  declare source: CreationOptional<UpvoteSource>;
  declare note: string | null;
  declare csatScore: number | null;
  declare csatComment: string | null;
  declare csatAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    TicketUpvote.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        ticketId: fkColumn(false),
        userId: fkColumn(false),
        unitId: fkColumn(true),
        source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ME_TOO' },
        note: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        csatScore: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        csatComment: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        csatAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'ticket_upvotes' },
    );
  }
}
