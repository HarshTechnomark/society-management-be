import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED';

/** Module 03 section 7.6. `pendingSlot` is a generated column and is never written. */
export class Invitation extends Model<InferAttributes<Invitation>, InferCreationAttributes<Invitation>> {
  declare id: number | undefined;
  declare societyId: number | null;
  declare roleId: number;
  declare name: string;
  declare mobile: string;
  declare email: string | null;
  declare locationLabel: string | null;
  declare unitId: number | null;
  declare residentId: number | null;
  declare message: string | null;
  declare tokenHash: string;
  declare status: InvitationStatus;
  declare expiresAt: Date;
  declare resendCount: number;
  declare lastSentAt: Date;
  declare invitedUserId: number;
  declare invitedBy: number | null;
  declare acceptedUserId: number | null;
  declare acceptedMemberId: number | null;
  declare respondedAt: Date | null;
  declare revokedBy: number | null;
  declare revokeReason: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Invitation.init(
      {
        id: idColumn,
        societyId: fkColumn(true),
        roleId: fkColumn(false),
        name: { type: DataTypes.STRING(120), allowNull: false },
        mobile: { type: DataTypes.CHAR(10), allowNull: false },
        email: { type: DataTypes.STRING(254), allowNull: true, defaultValue: null },
        locationLabel: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        unitId: fkColumn(true),
        residentId: fkColumn(true),
        message: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        tokenHash: { type: DataTypes.CHAR(64), allowNull: false },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING' },
        expiresAt: dateColumn(false),
        resendCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastSentAt: dateColumn(false),
        invitedUserId: fkColumn(false),
        invitedBy: fkColumn(true),
        acceptedUserId: fkColumn(true),
        acceptedMemberId: fkColumn(true),
        respondedAt: dateColumn(),
        revokedBy: fkColumn(true),
        revokeReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'invitations' },
    );
  }
}
