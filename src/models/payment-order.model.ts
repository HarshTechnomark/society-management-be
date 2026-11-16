import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type {
  AllocationMode,
  FeeMethod,
  FeeMode,
  OrderSource,
  OrderStatus,
} from '../modules/payments/payments.constants';
import type { OrderItem } from '../modules/payments/payments.types';

/** Module 12 section 7.1 payment orders. `beforeDestroy` throws. */
export class PaymentOrder extends Model<
  InferAttributes<PaymentOrder>,
  InferCreationAttributes<PaymentOrder>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare payerUserId: number | null;
  declare sourceType: OrderSource;
  declare sourceModule: string | null;
  declare refType: string | null;
  declare refId: number | null;
  declare dedupeKey: string | null;
  declare allocationMode: AllocationMode;
  declare items: OrderItem[];
  declare payListVersion: string | null;
  declare basePaise: CreationOptional<number>;
  declare convenienceFeePaise: CreationOptional<number>;
  declare convenienceFeeGstPaise: CreationOptional<number>;
  declare grossAmountPaise: CreationOptional<number>;
  declare feeMode: CreationOptional<FeeMode>;
  declare feeRateBp: CreationOptional<number>;
  declare methodHint: FeeMethod | null;
  declare gatewayAccountId: number;
  declare gatewayOrderId: string | null;
  declare status: CreationOptional<OrderStatus>;
  declare expiresAt: Date;
  declare paidAt: Date | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare failureReason: string | null;
  declare attemptCount: CreationOptional<number>;
  declare lastCheckedAt: Date | null;
  declare nextCheckAt: Date | null;
  declare linkTokenHash: string | null;
  declare linkShortCode: string | null;
  declare linkOpenedCount: CreationOptional<number>;
  declare mandateId: number | null;
  declare debitOn: string | null;
  declare preDebitNotifiedAt: Date | null;
  declare returnUrl: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    PaymentOrder.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        payerUserId: fkColumn(true),
        sourceType: { type: DataTypes.STRING(20), allowNull: false },
        sourceModule: { type: DataTypes.STRING(2), allowNull: true, defaultValue: null },
        refType: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        refId: fkColumn(true),
        dedupeKey: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
        allocationMode: { type: DataTypes.STRING(15), allowNull: false },
        items: { type: DataTypes.JSON, allowNull: false },
        payListVersion: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        basePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        convenienceFeePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        convenienceFeeGstPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        grossAmountPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        feeMode: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'SOCIETY_ABSORBS' },
        feeRateBp: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        methodHint: { type: DataTypes.STRING(12), allowNull: true, defaultValue: null },
        gatewayAccountId: fkColumn(false),
        gatewayOrderId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'CREATED' },
        expiresAt: dateColumn(false),
        paidAt: dateColumn(),
        cancelledAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        failureReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        attemptCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastCheckedAt: dateColumn(),
        nextCheckAt: dateColumn(),
        linkTokenHash: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        linkShortCode: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        linkOpenedCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        mandateId: fkColumn(true),
        debitOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        preDebitNotifiedAt: dateColumn(),
        returnUrl: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'payment_orders',
        hooks: {
          beforeDestroy: () => {
            throw new Error('payment_orders rows are never deleted');
          },
        },
      },
    );
  }
}
