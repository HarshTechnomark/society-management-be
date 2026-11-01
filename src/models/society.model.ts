import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { now } from '../lib/clock';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const SOCIETY_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CLOSED'] as const;
export type SocietyStatus = (typeof SOCIETY_STATUSES)[number];
export const SUSPENSION_CAUSES = ['NON_PAYMENT', 'TRIAL_EXPIRED', 'MANUAL'] as const;
export type SuspensionCause = (typeof SUSPENSION_CAUSES)[number];
export const CLOSURE_REASONS = [
  'CUSTOMER_REQUEST',
  'NON_PAYMENT',
  'TRIAL_NOT_CONVERTED',
  'DUPLICATE',
  'FRAUD',
  'MERGED',
  'OTHER',
] as const;
export type ClosureReason = (typeof CLOSURE_REASONS)[number];
export interface HealthBreakdown {
  adoption: number | null;
  onboarding: number | null;
  collections: number | null;
  adminActivity: number | null;
  billing: number | null;
}

/**
 * Module 01 section 7.2 (core columns) plus the module 05 lifecycle columns (module 05 section 7.1). `logoFileId` has no
 * foreign key yet. `status` is changed only by module 05 `societyLifecycle.transition()` (BR-05-1). `version` is checked
 * and incremented by module 05 under a row lock (not Sequelize `version: true`, so other modules' saves stay unaffected).
 */
export class Society extends Model<InferAttributes<Society>, InferCreationAttributes<Society>> {
  declare id: number | undefined;
  declare organizationId: number | null;
  declare name: string;
  declare legalName: string | null;
  declare slug: string;
  declare registrationNo: string | null;
  declare gstin: string | null;
  declare addressLine1: string;
  declare addressLine2: string | null;
  declare city: string;
  declare state: string;
  declare pincode: string;
  declare timezone: string;
  declare locale: string;
  declare fyStartMonth: number;
  declare status: SocietyStatus;
  declare statusChangedAt: Date | undefined;
  declare createdVia: 'ASSISTED' | 'SELF_SERVE';
  declare creatorUserId: number | null;
  declare approxFlats: number | null;
  declare trialEndsAt: Date | null;
  declare trialExtendedCount: number;
  declare activatedAt: Date | null;
  declare pastDueSince: Date | null;
  declare suspendedAt: Date | null;
  declare suspensionCause: SuspensionCause | null;
  declare suspensionHoldUntil: Date | null;
  declare closedAt: Date | null;
  declare closureReason: ClosureReason | null;
  declare purgeAfter: Date | null;
  declare purgeHoldReason: string | null;
  declare purgeHoldSetAt: Date | null;
  declare purgedAt: Date | null;
  declare financialPurgedAt: Date | null;
  declare financialRetainUntil: string | null;
  declare requiresSupportConsent: boolean;
  declare healthScore: number;
  declare healthBreakdown: HealthBreakdown | null;
  declare healthComputedAt: Date | null;
  declare activeUsers30: number;
  declare unitsSnapshot: number;
  declare lastNudgedAt: Date | null;
  declare version: number;
  declare logoFileId: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Society.init(
      {
        id: idColumn,
        organizationId: fkColumn(true),
        name: { type: DataTypes.STRING(150), allowNull: false },
        legalName: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        slug: { type: DataTypes.STRING(60), allowNull: false },
        registrationNo: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        gstin: { type: DataTypes.STRING(15), allowNull: true, defaultValue: null },
        addressLine1: { type: DataTypes.STRING(200), allowNull: false },
        addressLine2: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        city: { type: DataTypes.STRING(80), allowNull: false },
        state: { type: DataTypes.STRING(60), allowNull: false },
        pincode: { type: DataTypes.CHAR(6), allowNull: false },
        timezone: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'Asia/Kolkata' },
        locale: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'en-IN' },
        fyStartMonth: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 4 },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TRIAL' },
        statusChangedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: () => now() },
        createdVia: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ASSISTED' },
        creatorUserId: fkColumn(true),
        approxFlats: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        trialEndsAt: dateColumn(),
        trialExtendedCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        activatedAt: dateColumn(),
        pastDueSince: dateColumn(),
        suspendedAt: dateColumn(),
        suspensionCause: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        suspensionHoldUntil: dateColumn(),
        closedAt: dateColumn(),
        closureReason: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        purgeAfter: dateColumn(),
        purgeHoldReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        purgeHoldSetAt: dateColumn(),
        purgedAt: dateColumn(),
        financialPurgedAt: dateColumn(),
        financialRetainUntil: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        requiresSupportConsent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        healthScore: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        healthBreakdown: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        healthComputedAt: dateColumn(),
        activeUsers30: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        unitsSnapshot: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastNudgedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        logoFileId: fkColumn(true),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'societies' },
    );
  }
}
