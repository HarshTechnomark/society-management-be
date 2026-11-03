import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 09 section 7.5. Part 1 creates the table; join requests are part 2. `pendingSlot` is generated. */
export class JoinRequest extends Model<InferAttributes<JoinRequest>, InferCreationAttributes<JoinRequest>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare userId: number;
  declare unitId: number;
  declare relation: string;
  declare familyRelation: string | null;
  declare householdOf: 'OWNER' | 'TENANT' | null;
  declare name: string;
  declare mobile: string;
  declare email: string | null;
  declare dateOfBirth: string | null;
  declare message: string | null;
  declare agreementStart: string | null;
  declare agreementEnd: string | null;
  declare status: string;
  declare confirmerResidentId: number | null;
  declare confirmerDecidedAt: Date | null;
  declare ownerDecisionNote: string | null;
  declare approvalRequestId: number | null;
  declare decidedAt: Date | null;
  declare decisionReason: string | null;
  declare residentId: number | null;
  declare expiresAt: Date;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    JoinRequest.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        userId: fkColumn(false),
        unitId: fkColumn(false),
        relation: { type: DataTypes.STRING(12), allowNull: false },
        familyRelation: { type: DataTypes.STRING(12), allowNull: true, defaultValue: null },
        householdOf: { type: DataTypes.STRING(6), allowNull: true, defaultValue: null },
        name: { type: DataTypes.STRING(120), allowNull: false },
        mobile: { type: DataTypes.CHAR(10), allowNull: false },
        email: { type: DataTypes.STRING(254), allowNull: true, defaultValue: null },
        dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        message: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        agreementStart: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        agreementEnd: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(14), allowNull: false },
        confirmerResidentId: fkColumn(true),
        confirmerDecidedAt: dateColumn(),
        ownerDecisionNote: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        approvalRequestId: fkColumn(true),
        decidedAt: dateColumn(),
        decisionReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        residentId: fkColumn(true),
        expiresAt: dateColumn(false),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'join_requests' },
    );
  }
}
