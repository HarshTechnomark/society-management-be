import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export const DUNNING_STEPS = [
  'REMINDER',
  'MANUAL_REMINDER',
  'PAST_DUE',
  'SUSPENDED',
  'GRACE_EXTENDED',
  'CLEARED',
] as const;
export type DunningStep = (typeof DUNNING_STEPS)[number];
export const DUNNING_OUTCOMES = ['DONE', 'SKIPPED'] as const;
export type DunningOutcome = (typeof DUNNING_OUTCOMES)[number];
export const DUNNING_SKIP_REASONS = [
  'SUPERSEDED',
  'BELOW_MINIMUM',
  'NOT_APPLICABLE',
  'HOLD_ACTIVE',
  'PENDING_MANUAL_PAYMENT',
  'SOCIETY_CLOSED',
  'NOT_OPEN',
] as const;
export type DunningSkipReason = (typeof DUNNING_SKIP_REASONS)[number];

const appendOnly = (): never => {
  throw new Error('dunning_events is append-only');
};

/** Module 06 section 7.5. One row per reminder, transition or manual action; update and delete throw. */
export class DunningEvent extends Model<
  InferAttributes<DunningEvent>,
  InferCreationAttributes<DunningEvent>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare invoiceId: number | null;
  declare step: DunningStep;
  declare offsetDays: number | null;
  declare scheduledFor: string;
  declare dedupeKey: string | null;
  declare outcome: DunningOutcome;
  declare skipReason: DunningSkipReason | null;
  declare templateKey: string | null;
  declare suspendOnBefore: string | null;
  declare suspendOnAfter: string | null;
  declare notes: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    const date = () => ({ type: DataTypes.DATEONLY, allowNull: true, defaultValue: null });
    const str = (n: number) => ({ type: DataTypes.STRING(n), allowNull: true, defaultValue: null });
    DunningEvent.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        invoiceId: fkColumn(true),
        step: { type: DataTypes.STRING(20), allowNull: false },
        offsetDays: { type: DataTypes.SMALLINT, allowNull: true, defaultValue: null },
        scheduledFor: { type: DataTypes.DATEONLY, allowNull: false },
        dedupeKey: str(80),
        outcome: { type: DataTypes.STRING(10), allowNull: false },
        skipReason: str(30),
        templateKey: str(60),
        suspendOnBefore: date(),
        suspendOnAfter: date(),
        notes: str(500),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'dunning_events',
        hooks: {
          beforeUpdate: appendOnly,
          beforeBulkUpdate: appendOnly,
          beforeDestroy: appendOnly,
          beforeBulkDestroy: appendOnly,
        },
      },
    );
  }
}
