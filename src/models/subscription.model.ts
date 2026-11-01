import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export interface FlatSegment {
  fromDate: string;
  toDate: string | null;
  billableFlats: number;
}
export interface PreviousPeriod {
  periodStart: string;
  periodEnd: string;
  months: number;
  freeMonths: number;
  pricePerFlatPerMonthPaise: number;
  planVersionId: number;
  flatSegments: FlatSegment[];
}

/** Module 04 section 7.5. `liveSocietyId` is a generated column and is never written (BR-04-26). */
export class Subscription extends Model<
  InferAttributes<Subscription>,
  InferCreationAttributes<Subscription>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare planId: number;
  declare planVersionId: number;
  declare status: 'TRIALING' | 'ACTIVE' | 'CANCELLED';
  declare statusReason:
    'SIGNED_UP' | 'PAID_START' | 'CANCELLED_AT_PERIOD_END' | 'TRIAL_CANCELLED' | 'SOCIETY_CLOSED';
  declare statusChangedAt: Date;
  declare billingCycle: 'MONTHLY' | 'ANNUAL';
  declare trialEndsAt: Date | null;
  declare paidStartedAt: Date | null;
  declare billingAnchorDay: number;
  declare currentPeriodStart: string | null;
  declare currentPeriodEnd: string | null;
  declare lastInvoicedPeriodStart: string | null;
  declare billableFlats: number;
  declare flatSegments: FlatSegment[] | null;
  declare previousPeriod: PreviousPeriod | null;
  declare customPricePerFlatPaise: number | null;
  declare customMinFlats: number | null;
  declare pendingPlanVersionId: number | null;
  declare pendingChangeType: 'DOWNGRADE' | 'VERSION_MIGRATION' | null;
  declare pendingChangeAt: string | null;
  declare pendingPostponements: number;
  declare pendingBillingCycle: 'MONTHLY' | 'ANNUAL' | null;
  declare downgradedFromPlanVersionId: number | null;
  declare downgradedAt: Date | null;
  declare cancelAtPeriodEnd: boolean;
  declare cancelRequestedBy: number | null;
  declare cancelReason: string | null;
  declare cancelledAt: Date | null;
  declare autopayStatus: 'NONE' | 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'FAILED';
  declare autopayMethod: 'UPI_AUTOPAY' | 'EMANDATE' | null;
  declare autopayMandateRef: string | null;
  declare autopayMaxAmountPaise: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    const date = () => ({ type: DataTypes.DATEONLY, allowNull: true, defaultValue: null });
    Subscription.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        planId: fkColumn(false),
        planVersionId: fkColumn(false),
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'TRIALING' },
        statusReason: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'SIGNED_UP' },
        statusChangedAt: dateColumn(false),
        billingCycle: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'MONTHLY' },
        trialEndsAt: dateColumn(),
        paidStartedAt: dateColumn(),
        billingAnchorDay: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
        currentPeriodStart: date(),
        currentPeriodEnd: date(),
        lastInvoicedPeriodStart: date(),
        billableFlats: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        flatSegments: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        previousPeriod: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        customPricePerFlatPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        customMinFlats: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, defaultValue: null },
        pendingPlanVersionId: fkColumn(true),
        pendingChangeType: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        pendingChangeAt: date(),
        pendingPostponements: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        pendingBillingCycle: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        downgradedFromPlanVersionId: fkColumn(true),
        downgradedAt: dateColumn(),
        cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        cancelRequestedBy: fkColumn(true),
        cancelReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        cancelledAt: dateColumn(),
        autopayStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'NONE' },
        autopayMethod: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        autopayMandateRef: { type: DataTypes.STRING(100), allowNull: true, defaultValue: null },
        autopayMaxAmountPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'subscriptions' },
    );
  }
}
