import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 14 section 7.4: an out-of-office or term hand-over delegation. Not paranoid (evidence of who could act for whom). */
export class ApprovalDelegation extends Model<
  InferAttributes<ApprovalDelegation>,
  InferCreationAttributes<ApprovalDelegation>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare delegatorUserId: number;
  declare delegateUserId: number;
  declare source: 'OUT_OF_OFFICE' | 'TERM_HANDOVER';
  declare types: string[] | null;
  declare maxAmountPaise: number | null;
  declare startsAt: Date;
  declare endsAt: Date;
  declare reason: string;
  declare status: CreationOptional<'ACTIVE' | 'REVOKED' | 'EXPIRED'>;
  declare committeeTermId: number | null;
  declare endingNotifiedAt: Date | null;
  declare revokedAt: Date | null;
  declare revokedBy: number | null;
  declare revokeReason: string | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    ApprovalDelegation.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        delegatorUserId: fkColumn(false),
        delegateUserId: fkColumn(false),
        source: { type: DataTypes.STRING(15), allowNull: false },
        types: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        maxAmountPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        startsAt: dateColumn(false),
        endsAt: dateColumn(false),
        reason: { type: DataTypes.STRING(500), allowNull: false },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        committeeTermId: fkColumn(true),
        endingNotifiedAt: dateColumn(),
        revokedAt: dateColumn(),
        revokedBy: fkColumn(true),
        revokeReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'approval_delegations' },
    );
  }
}
