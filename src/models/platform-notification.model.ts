import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const ANNOUNCEMENT_KINDS = [
  'ANNOUNCEMENT',
  'MAINTENANCE',
  'INCIDENT',
  'RELEASE_NOTE',
  'BILLING',
] as const;
export const ANNOUNCEMENT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export const AUDIENCE_TYPES = ['ALL', 'PLANS', 'SOCIETY_STATUSES', 'SOCIETIES'] as const;
export const ANNOUNCEMENT_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'EXPIRED', 'CANCELLED'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

/** Module 07 section 7.6. Paranoid; only DRAFT rows are deleted. Audience JSON is matched in code. */
export class PlatformNotification extends Model<
  InferAttributes<PlatformNotification>,
  InferCreationAttributes<PlatformNotification>
> {
  declare id: number | undefined;
  declare title: string;
  declare body: string;
  declare kind: (typeof ANNOUNCEMENT_KINDS)[number];
  declare severity: (typeof ANNOUNCEMENT_SEVERITIES)[number];
  declare audienceType: (typeof AUDIENCE_TYPES)[number];
  declare audiencePlanKeys: string[] | null;
  declare audienceSocietyStatuses: string[] | null;
  declare audienceSocietyIds: number[] | null;
  declare audienceRoleKeys: string[];
  declare channels: string[];
  declare status: AnnouncementStatus;
  declare publishAt: Date | null;
  declare expiresAt: Date;
  declare publishedAt: Date | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare isDismissible: boolean;
  declare ctaLabel: string | null;
  declare ctaUrl: string | null;
  declare incidentId: number | null;
  declare recipientCount: number | null;
  declare fanoutCompletedAt: Date | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;
  declare deletedAt: Date | null | undefined;

  static initModel(sequelize: Sequelize): void {
    PlatformNotification.init(
      {
        id: idColumn,
        title: { type: DataTypes.STRING(120), allowNull: false },
        body: { type: DataTypes.STRING(2000), allowNull: false },
        kind: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'ANNOUNCEMENT' },
        severity: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'INFO' },
        audienceType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ALL' },
        audiencePlanKeys: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        audienceSocietyStatuses: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        audienceSocietyIds: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        audienceRoleKeys: { type: DataTypes.JSON, allowNull: false },
        channels: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'DRAFT' },
        publishAt: dateColumn(),
        expiresAt: dateColumn(false),
        publishedAt: dateColumn(),
        cancelledAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        isDismissible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        ctaLabel: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        ctaUrl: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        incidentId: fkColumn(true),
        recipientCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, defaultValue: null },
        fanoutCompletedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'platform_notifications', paranoid: true },
    );
  }
}
