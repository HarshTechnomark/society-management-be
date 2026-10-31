import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export type MemberStatus = 'ACTIVE' | 'SUSPENDED' | 'ENDED';

/** Module 03 section 7.4. Not paranoid: ending a membership is a status. */
export class SocietyMember extends Model<
  InferAttributes<SocietyMember>,
  InferCreationAttributes<SocietyMember>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare userId: number;
  declare roleId: number;
  declare status: MemberStatus;
  declare locationLabel: string | null;
  declare joinedAt: Date;
  declare suspendedAt: Date | null;
  declare suspendedBy: number | null;
  declare suspendReason: string | null;
  declare endedAt: Date | null;
  declare endedBy: number | null;
  declare endReason: string | null;
  declare invitationId: number | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    SocietyMember.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        userId: fkColumn(false),
        roleId: fkColumn(false),
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ACTIVE' },
        locationLabel: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        joinedAt: dateColumn(false),
        suspendedAt: dateColumn(),
        suspendedBy: fkColumn(true),
        suspendReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        endedAt: dateColumn(),
        endedBy: fkColumn(true),
        endReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        invitationId: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'society_members' },
    );
  }
}
