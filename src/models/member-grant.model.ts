import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export type GrantStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

/** Module 03 section 7.5. `activeSlot` is a generated column and is never written. */
export class MemberGrant extends Model<InferAttributes<MemberGrant>, InferCreationAttributes<MemberGrant>> {
  declare id: number | undefined;
  declare societyId: number;
  declare memberId: number;
  declare permissionId: number;
  declare effect: 'ALLOW' | 'DENY';
  declare source: 'ADMIN' | 'HOUSEHOLD';
  declare status: GrantStatus;
  declare startsAt: Date;
  declare endsAt: Date | null;
  declare reason: string | null;
  declare grantedBy: number;
  declare expiryReminderSentAt: Date | null;
  declare revokedAt: Date | null;
  declare revokedBy: number | null;
  declare revokeReason: string | null;
  declare unitId: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    MemberGrant.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        memberId: fkColumn(false),
        permissionId: fkColumn(false),
        effect: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'ALLOW' },
        source: { type: DataTypes.STRING(10), allowNull: false },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        startsAt: dateColumn(false),
        endsAt: dateColumn(),
        reason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        grantedBy: fkColumn(false),
        expiryReminderSentAt: dateColumn(),
        revokedAt: dateColumn(),
        revokedBy: fkColumn(true),
        revokeReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        unitId: fkColumn(true),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'member_grants' },
    );
  }
}
