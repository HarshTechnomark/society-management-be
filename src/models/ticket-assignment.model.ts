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
  AssigneeType,
  AssignmentEndReason,
  AssignmentMethod,
} from '../modules/helpdesk/helpdesk.constants';

/** Module 15 section 7.6: one assignment of a ticket (history; at most one current row). The generated column `currentKey` is not mapped. */
export class TicketAssignment extends Model<
  InferAttributes<TicketAssignment>,
  InferCreationAttributes<TicketAssignment>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare ticketId: number;
  declare assigneeType: AssigneeType;
  declare assigneeUserId: number | null;
  declare staffId: number | null;
  declare vendorId: number | null;
  declare workOrderId: number | null;
  declare externalName: string | null;
  declare externalMobile: string | null;
  declare assigneeLabel: string;
  declare method: AssignmentMethod;
  declare assignedByUserId: number | null;
  declare note: string | null;
  declare assignedAt: Date;
  declare endedAt: Date | null;
  declare endReason: AssignmentEndReason | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    TicketAssignment.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        ticketId: fkColumn(false),
        assigneeType: { type: DataTypes.STRING(10), allowNull: false },
        assigneeUserId: fkColumn(true),
        staffId: fkColumn(true),
        vendorId: fkColumn(true),
        workOrderId: fkColumn(true),
        externalName: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        externalMobile: { type: DataTypes.CHAR(10), allowNull: true, defaultValue: null },
        assigneeLabel: { type: DataTypes.STRING(150), allowNull: false },
        method: { type: DataTypes.STRING(15), allowNull: false },
        assignedByUserId: fkColumn(true),
        note: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        assignedAt: dateColumn(false),
        endedAt: dateColumn(),
        endReason: { type: DataTypes.STRING(25), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'ticket_assignments' },
    );
  }
}
