import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { WebhookStatus } from '../modules/payments/payments.constants';

/** Module 12 section 7.5 inbox of verified gateway events (payload redacted, at most 64 KB). */
export class PaymentWebhookEvent extends Model<
  InferAttributes<PaymentWebhookEvent>,
  InferCreationAttributes<PaymentWebhookEvent>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare gatewayAccountId: number;
  declare provider: string;
  declare providerEventId: string;
  declare eventType: string;
  declare gatewayOrderId: string | null;
  declare gatewayPaymentId: string | null;
  declare gatewayRefundId: string | null;
  declare gatewayMandateId: string | null;
  declare amountPaise: number | null;
  declare payload: Record<string, unknown>;
  declare status: CreationOptional<WebhookStatus>;
  declare attempts: CreationOptional<number>;
  declare lastError: string | null;
  declare processedAt: Date | null;
  declare reviewedBy: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    PaymentWebhookEvent.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        gatewayAccountId: fkColumn(false),
        provider: { type: DataTypes.STRING(20), allowNull: false },
        providerEventId: { type: DataTypes.STRING(120), allowNull: false },
        eventType: { type: DataTypes.STRING(60), allowNull: false },
        gatewayOrderId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        gatewayPaymentId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        gatewayRefundId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        gatewayMandateId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        amountPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        payload: { type: DataTypes.JSON, allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'RECEIVED' },
        attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastError: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        processedAt: dateColumn(),
        reviewedBy: fkColumn(true),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'payment_webhook_events' },
    );
  }
}
