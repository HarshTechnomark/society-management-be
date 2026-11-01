import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { now } from '../lib/clock';
import { fkColumn, idColumn } from './_columns';
import type { SocietyStatus } from './society.model';

export const LIFECYCLE_EVENT_TYPES = [
  'CREATED',
  'STATUS_CHANGED',
  'TRIAL_EXTENDED',
  'GRACE_GRANTED',
  'AUTO_CLOSE_WARNED',
  'PURGE_HOLD_SET',
  'PURGE_HOLD_CLEARED',
  'PURGE_WARNED',
  'PURGED',
  'FINANCIAL_PURGED',
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];
export const TRIGGER_SOURCES = [
  'PLATFORM_USER',
  'SOCIETY_USER',
  'PUBLIC_SIGNUP',
  'BILLING',
  'SYSTEM_JOB',
] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];
export const TRIGGER_CODES = [
  'ASSISTED_CREATE',
  'SELF_SERVE_SIGNUP',
  'MANUAL_CONVERT',
  'FIRST_INVOICE_PAID',
  'TRIAL_EXPIRED',
  'INVOICE_OVERDUE',
  'GRACE_EXPIRED',
  'ACCOUNT_CLEARED',
  'MANUAL_SUSPEND',
  'MANUAL_REACTIVATE',
  'MANUAL_TRIAL_EXTENSION',
  'MANUAL_CLOSE',
  'SUBSCRIPTION_CANCELLED',
  'AUTO_CLOSE',
  'MANUAL_REOPEN',
  'MANUAL_PURGE_HOLD',
  'RETENTION_ELAPSED',
] as const;
export type TriggerCode = (typeof TRIGGER_CODES)[number];

/** Module 05 section 7.2. Append-only: no `updatedAt`, and update or destroy throws. */
export class SocietyLifecycleEvent extends Model<
  InferAttributes<SocietyLifecycleEvent>,
  InferCreationAttributes<SocietyLifecycleEvent>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare eventType: LifecycleEventType;
  declare fromStatus: SocietyStatus | null;
  declare toStatus: SocietyStatus | null;
  declare triggerSource: TriggerSource;
  declare triggerCode: TriggerCode;
  declare reasonCategory: string | null;
  declare reason: string | null;
  declare actorUserId: number | null;
  declare actorName: string;
  declare relatedEntityType: string | null;
  declare relatedEntityId: number | null;
  declare metadata: Record<string, unknown> | null;
  declare requestId: string | null;
  declare createdAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    SocietyLifecycleEvent.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        eventType: { type: DataTypes.STRING(30), allowNull: false },
        fromStatus: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        toStatus: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        triggerSource: { type: DataTypes.STRING(20), allowNull: false },
        triggerCode: { type: DataTypes.STRING(30), allowNull: false },
        reasonCategory: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        reason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        actorUserId: fkColumn(true),
        actorName: { type: DataTypes.STRING(120), allowNull: false },
        relatedEntityType: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        relatedEntityId: fkColumn(true),
        metadata: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        requestId: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        createdAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: () => now() },
      },
      {
        sequelize,
        tableName: 'society_lifecycle_events',
        updatedAt: false,
        hooks: {
          beforeUpdate: () => {
            throw new Error('society_lifecycle_events is append-only');
          },
          beforeDestroy: () => {
            throw new Error('society_lifecycle_events is append-only');
          },
          beforeBulkUpdate: () => {
            throw new Error('society_lifecycle_events is append-only');
          },
          beforeBulkDestroy: () => {
            throw new Error('society_lifecycle_events is append-only');
          },
        },
      },
    );
  }
}
