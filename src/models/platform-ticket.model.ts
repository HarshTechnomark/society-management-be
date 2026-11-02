import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const TICKET_CATEGORIES = [
  'BILLING',
  'PAYMENTS',
  'TECHNICAL',
  'ONBOARDING',
  'ACCOUNT',
  'DATA_FIX',
  'FEATURE_REQUEST',
  'OTHER',
] as const;
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'] as const;
export const TICKET_CLOSED_REASONS = ['AUTO_CLOSED', 'CLOSED_BY_SOCIETY', 'CLOSED_BY_PLATFORM'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketClosedReason = (typeof TICKET_CLOSED_REASONS)[number];

/** Module 07 section 7.2. Support history: never deleted, not paranoid. */
export class PlatformTicket extends Model<
  InferAttributes<PlatformTicket>,
  InferCreationAttributes<PlatformTicket>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare raisedByUserId: number;
  declare source: 'ADMIN_APP' | 'PLATFORM';
  declare subject: string;
  declare category: TicketCategory;
  declare priority: TicketPriority;
  declare status: TicketStatus;
  declare assigneeUserId: number | null;
  declare firstResponseDueAt: Date;
  declare resolutionDueAt: Date;
  declare firstRespondedAt: Date | null;
  declare firstResponseBreachedAt: Date | null;
  declare resolutionWarnedAt: Date | null;
  declare resolutionBreachedAt: Date | null;
  declare waitingSince: Date | null;
  declare pausedMinutes: number;
  declare resolvedAt: Date | null;
  declare closedAt: Date | null;
  declare closedReason: TicketClosedReason | null;
  declare reopenCount: number;
  declare lastMessageAt: Date;
  declare lastSocietyMessageAt: Date | null;
  declare lastPlatformMessageAt: Date | null;
  declare messageCount: number;
  declare satisfactionRating: number | null;
  declare satisfactionComment: string | null;
  declare ratedAt: Date | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    PlatformTicket.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        raisedByUserId: fkColumn(false),
        source: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ADMIN_APP' },
        subject: { type: DataTypes.STRING(150), allowNull: false },
        category: { type: DataTypes.STRING(20), allowNull: false },
        priority: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'MEDIUM' },
        status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'OPEN' },
        assigneeUserId: fkColumn(true),
        firstResponseDueAt: dateColumn(false),
        resolutionDueAt: dateColumn(false),
        firstRespondedAt: dateColumn(),
        firstResponseBreachedAt: dateColumn(),
        resolutionWarnedAt: dateColumn(),
        resolutionBreachedAt: dateColumn(),
        waitingSince: dateColumn(),
        pausedMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        resolvedAt: dateColumn(),
        closedAt: dateColumn(),
        closedReason: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        reopenCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastMessageAt: dateColumn(false),
        lastSocietyMessageAt: dateColumn(),
        lastPlatformMessageAt: dateColumn(),
        messageCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        satisfactionRating: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        satisfactionComment: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        ratedAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'platform_tickets' },
    );
  }
}
