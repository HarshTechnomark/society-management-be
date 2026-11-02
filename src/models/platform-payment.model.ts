import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { now } from '../lib/clock';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const PAYMENT_KINDS = ['PAYMENT', 'TDS', 'REFUND'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_ORIGINS = ['SOCIETY', 'PLATFORM', 'GATEWAY', 'SYSTEM'] as const;
export type PaymentOrigin = (typeof PAYMENT_ORIGINS)[number];
export const PAYMENT_STATUSES = [
  'CREATED',
  'CAPTURED',
  'FAILED',
  'EXPIRED',
  'PENDING_APPROVAL',
  'REJECTED',
  'CLAIMED',
  'VERIFIED',
  'PROCESSING',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
/** Section 6.3: the statuses each kind can be in (the `ck_ppay_kind_status` CHECK). */
export const STATUSES_BY_KIND: Record<PaymentKind, readonly PaymentStatus[]> = {
  PAYMENT: ['CREATED', 'CAPTURED', 'FAILED', 'EXPIRED', 'PENDING_APPROVAL', 'REJECTED'],
  TDS: ['CLAIMED', 'VERIFIED', 'REJECTED'],
  REFUND: ['PENDING_APPROVAL', 'PROCESSING', 'REFUNDED', 'REJECTED', 'FAILED'],
};
export const PAYMENT_METHODS = [
  'UPI',
  'CARD',
  'NETBANKING',
  'WALLET',
  'UPI_AUTOPAY',
  'EMANDATE',
  'NEFT',
  'RTGS',
  'IMPS',
  'CHEQUE',
  'DD',
  'TDS',
  'GATEWAY_REFUND',
  'BANK_TRANSFER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const TDS_SECTIONS = ['194J', '194C', 'OTHER'] as const;
export type TdsSection = (typeof TDS_SECTIONS)[number];

/** Columns fixed at insert (section 7.3: amount and kind never change). */
const FIXED = ['kind', 'amountPaise', 'societyId'] as const;

/** Module 06 section 7.3. Money in, TDS claims and refunds out; never deleted, amount and kind never change. */
export class PlatformPayment extends Model<
  InferAttributes<PlatformPayment>,
  InferCreationAttributes<PlatformPayment>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare invoiceId: number | null;
  declare kind: PaymentKind;
  declare origin: PaymentOrigin;
  declare status: PaymentStatus;
  declare method: PaymentMethod | null;
  declare amountPaise: number;
  declare appliedPaise: number;
  declare gatewayOrderId: string | null;
  declare gatewayPaymentId: string | null;
  declare gatewayRefundId: string | null;
  declare sourcePaymentId: number | null;
  declare bankReference: string | null;
  declare bankRefKey: string | null;
  declare payerBankName: string | null;
  declare receivedOn: string | null;
  declare tdsSection: TdsSection | null;
  declare tdsRatePct: string | null;
  declare deductedOn: string | null;
  declare tdsCertificateFileId: number | null;
  declare payeeReference: string | null;
  declare attachmentFileId: number | null;
  declare notes: string | null;
  declare reason: string | null;
  declare failureReason: string | null;
  declare capturedAt: Date | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare decidedBy: number | null;
  declare decidedAt: Date | null;
  declare completedAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    const date = () => ({ type: DataTypes.DATEONLY, allowNull: true, defaultValue: null });
    const str = (n: number) => ({ type: DataTypes.STRING(n), allowNull: true, defaultValue: null });
    PlatformPayment.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        invoiceId: fkColumn(true),
        kind: { type: DataTypes.STRING(10), allowNull: false },
        origin: { type: DataTypes.STRING(10), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false },
        method: str(20),
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        appliedPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        gatewayOrderId: str(60),
        gatewayPaymentId: str(60),
        gatewayRefundId: str(60),
        sourcePaymentId: fkColumn(true),
        bankReference: str(40),
        bankRefKey: str(64),
        payerBankName: str(100),
        receivedOn: date(),
        tdsSection: str(10),
        tdsRatePct: { type: DataTypes.DECIMAL(9, 4), allowNull: true, defaultValue: null },
        deductedOn: date(),
        tdsCertificateFileId: fkColumn(true),
        payeeReference: str(200),
        attachmentFileId: fkColumn(true),
        notes: str(500),
        reason: str(500),
        failureReason: str(300),
        capturedAt: dateColumn(),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        rejectedReason: str(500),
        decidedBy: fkColumn(true),
        decidedAt: dateColumn(),
        completedAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'platform_payments',
        hooks: {
          // the clock helper, so `createdAt` follows a frozen test clock (24 h and pending-order rules read it)
          beforeCreate: p => {
            p.createdAt = now();
          },
          beforeUpdate: p => {
            const bad = FIXED.filter(c => p.changed(c));
            if (bad.length) throw new Error(`platform_payments.${bad.join(', ')} never change`);
          },
          beforeBulkUpdate: options => {
            options.individualHooks = true;
          },
          beforeDestroy: () => {
            throw new Error('platform_payments rows are never deleted');
          },
          beforeBulkDestroy: () => {
            throw new Error('platform_payments rows are never deleted');
          },
        },
      },
    );
  }
}
