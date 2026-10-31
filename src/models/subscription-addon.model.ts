import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { AddonGrantRow } from './addon.model';

export type SubscriptionAddonStatus = 'PENDING_PAYMENT' | 'ACTIVE' | 'CANCEL_SCHEDULED' | 'ENDED';

/** Module 04 section 7.6. Price, billing type and grants are snapshots taken at purchase. */
export class SubscriptionAddon extends Model<
  InferAttributes<SubscriptionAddon>,
  InferCreationAttributes<SubscriptionAddon>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare subscriptionId: number;
  declare addonId: number;
  declare addonCode: string;
  declare billingType: 'ONE_TIME' | 'RECURRING';
  declare grants: AddonGrantRow[];
  declare featureKey: string | null;
  declare quantity: number;
  declare unitPricePaise: number;
  declare periodKey: string | null;
  declare status: SubscriptionAddonStatus;
  declare startsAt: Date;
  declare endsAt: Date | null;
  declare invoiceId: number | null;
  declare endedReason:
    'CANCELLED' | 'EXPIRED' | 'PLAN_CHANGED' | 'INCLUDED_IN_PLAN' | 'SUBSCRIPTION_CANCELLED' | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    SubscriptionAddon.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        subscriptionId: fkColumn(false),
        addonId: fkColumn(false),
        addonCode: { type: DataTypes.STRING(40), allowNull: false },
        billingType: { type: DataTypes.STRING(10), allowNull: false },
        grants: { type: DataTypes.JSON, allowNull: false },
        featureKey: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
        quantity: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        unitPricePaise: { type: DataTypes.BIGINT, allowNull: false },
        periodKey: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
        startsAt: dateColumn(false),
        endsAt: dateColumn(),
        invoiceId: fkColumn(true),
        endedReason: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'subscription_addons' },
    );
  }
}
