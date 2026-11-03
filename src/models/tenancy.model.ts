import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const TENANCY_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ACTIVE',
  'EXPIRED_OVERSTAY',
  'ENDED',
  'REJECTED',
  'CANCELLED',
] as const;
export type TenancyStatus = (typeof TENANCY_STATUSES)[number];
/** Statuses in which the tenant household exists (BR-09-15) and the tenancy counts as live (BR-09-28). */
export const LIVE_TENANCY_STATUSES = ['APPROVED', 'ACTIVE', 'EXPIRED_OVERSTAY'] as const;

/** Module 09 section 7.3. Part 1 creates the table and reads it (occupancy, bill-to); the tenancy service is part 2. */
export class Tenancy extends Model<InferAttributes<Tenancy>, InferCreationAttributes<Tenancy>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare tenantResidentId: number;
  declare landlordResidentId: number;
  declare status: TenancyStatus;
  declare agreementType: string;
  declare agreementStart: string;
  declare agreementEnd: string;
  declare agreementRegistrationNo: string | null;
  declare monthlyRentPaise: number | string;
  declare securityDepositPaise: number | string;
  declare maintenancePayer: 'OWNER' | 'TENANT';
  declare occupantCount: number;
  /** Part 2: household members to link on approval (BR-09-31), as entered; and whether to invite the tenant. */
  declare householdJson: unknown;
  declare inviteTenant: CreationOptional<boolean>;
  declare policeVerificationStatus: string;
  declare policeVerificationRef: string | null;
  declare policeVerifiedOn: string | null;
  declare policeVerificationNote: string | null;
  declare policeReminderSentAt: Date | null;
  declare source: string;
  declare submittedAt: Date | null;
  declare submittedBy: number | null;
  declare decidedBy: number | null;
  declare decidedAt: Date | null;
  declare decisionReason: string | null;
  declare moveInDate: string | null;
  declare endedOn: string | null;
  declare endReason: string | null;
  declare endNote: string | null;
  declare renewalCount: number;
  declare previousAgreementEnd: string | null;
  declare lastExpiryReminderDays: number | null;
  declare overstayAlertedAt: Date | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Tenancy.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        tenantResidentId: fkColumn(false),
        landlordResidentId: fkColumn(false),
        status: { type: DataTypes.STRING(18), allowNull: false, defaultValue: 'DRAFT' },
        agreementType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'LEAVE_AND_LICENCE' },
        agreementStart: { type: DataTypes.DATEONLY, allowNull: false },
        agreementEnd: { type: DataTypes.DATEONLY, allowNull: false },
        agreementRegistrationNo: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        monthlyRentPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        securityDepositPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        maintenancePayer: { type: DataTypes.STRING(6), allowNull: false, defaultValue: 'OWNER' },
        occupantCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        householdJson: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        inviteTenant: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        policeVerificationStatus: {
          type: DataTypes.STRING(14),
          allowNull: false,
          defaultValue: 'NOT_SUBMITTED',
        },
        policeVerificationRef: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        policeVerifiedOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        policeVerificationNote: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        policeReminderSentAt: dateColumn(),
        source: { type: DataTypes.STRING(14), allowNull: false, defaultValue: 'ADMIN' },
        submittedAt: dateColumn(),
        submittedBy: fkColumn(true),
        decidedBy: fkColumn(true),
        decidedAt: dateColumn(),
        decisionReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        moveInDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        endedOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        endReason: { type: DataTypes.STRING(16), allowNull: true, defaultValue: null },
        endNote: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        renewalCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        previousAgreementEnd: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        lastExpiryReminderDays: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        overstayAlertedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'tenancies' },
    );
  }
}
