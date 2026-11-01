import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const GRANT_STATUSES = [
  'PENDING_CONSENT',
  'ACTIVE',
  'DENIED',
  'CANCELLED',
  'CONSENT_EXPIRED',
  'EXPIRED',
  'ENDED',
  'REVOKED',
] as const;
export type SupportGrantStatus = (typeof GRANT_STATUSES)[number];
export const CONSENT_STATUSES = [
  'NOT_REQUIRED',
  'PENDING',
  'APPROVED',
  'DENIED',
  'EXPIRED',
  'BYPASSED_EMERGENCY',
  'CANCELLED',
] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export const GRANT_END_REASONS = [
  'EXPIRED',
  'ENDED_BY_REQUESTER',
  'REVOKED_BY_SOCIETY',
  'REVOKED_BY_PLATFORM',
  'SOCIETY_CLOSED',
  'USER_DISABLED',
] as const;
export type GrantEndReason = (typeof GRANT_END_REASONS)[number];
export type SupportScope = 'READ_ONLY' | 'READ_WRITE';

/** Module 05 section 7.3. `openLockUserId` is a generated column and is never written. Not paranoid. */
export class SupportAccessGrant extends Model<
  InferAttributes<SupportAccessGrant>,
  InferCreationAttributes<SupportAccessGrant>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare platformUserId: number;
  declare scope: SupportScope;
  declare reason: string;
  declare ticketRef: string | null;
  declare durationMinutes: number;
  declare isEmergency: boolean;
  declare status: SupportGrantStatus;
  declare consentRequired: boolean;
  declare consentStatus: ConsentStatus;
  declare consentExpiresAt: Date | null;
  declare decidedByUserId: number | null;
  declare decidedAt: Date | null;
  declare decisionNote: string | null;
  declare startedAt: Date | null;
  declare endsAt: Date | null;
  declare endedAt: Date | null;
  declare endedByUserId: number | null;
  declare endReason: GrantEndReason | null;
  declare endNote: string | null;
  declare enteredAt: Date | null;
  declare requestCount: number;
  declare writeCount: number;
  declare lastActivityAt: Date | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    SupportAccessGrant.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        platformUserId: fkColumn(false),
        scope: { type: DataTypes.STRING(20), allowNull: false },
        reason: { type: DataTypes.STRING(500), allowNull: false },
        ticketRef: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        durationMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 60 },
        isEmergency: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        status: { type: DataTypes.STRING(20), allowNull: false },
        consentRequired: { type: DataTypes.BOOLEAN, allowNull: false },
        consentStatus: { type: DataTypes.STRING(20), allowNull: false },
        consentExpiresAt: dateColumn(),
        decidedByUserId: fkColumn(true),
        decidedAt: dateColumn(),
        decisionNote: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        startedAt: dateColumn(),
        endsAt: dateColumn(),
        endedAt: dateColumn(),
        endedByUserId: fkColumn(true),
        endReason: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        endNote: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        enteredAt: dateColumn(),
        requestCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        writeCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastActivityAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'support_access_grants' },
    );
  }
}
