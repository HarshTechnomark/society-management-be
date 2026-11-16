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
  PaymentMethod,
  PaymentSource,
  PaymentStatus,
  ReceiptPdfStatus,
  ReceiptStatus,
  ReversalReasonCode,
  ReviewReason,
} from '../modules/payments/payments.constants';

/** Module 12 section 7.2 money received (or a failed online attempt), with receipt and cheque columns. `beforeDestroy` throws; `beforeUpdate` throws if `amountPaise`, `method`, `source`, `unitId` or a set `receiptNo` changes. */
export class Payment extends Model<InferAttributes<Payment>, InferCreationAttributes<Payment>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare paymentOrderId: number | null;
  declare source: PaymentSource;
  declare method: PaymentMethod;
  declare status: PaymentStatus;
  declare payerUserId: number | null;
  declare payerName: string;
  declare amountPaise: number;
  declare convenienceFeePaise: number;
  declare convenienceFeeGstPaise: number;
  declare grossAmountPaise: number;
  declare toInvoicesPaise: number;
  declare toCollectionsPaise: number;
  declare toAdvancePaise: number;
  declare refundedPaise: number;
  declare paymentDate: string;
  declare capturedAt: Date | null;
  declare gatewayAccountId: number | null;
  declare gatewayPaymentId: string | null;
  declare gatewayMethodDetail: string | null;
  declare referenceNo: string | null;
  declare referenceKey: string | null;
  declare chequeBankName: string | null;
  declare chequeDate: string | null;
  declare depositedOn: string | null;
  declare depositBankAccountId: number | null;
  declare clearedOn: string | null;
  declare bounceReason: string | null;
  declare bouncedOn: string | null;
  declare bounceChargeInvoiceId: number | null;
  declare receiptNo: string | null;
  declare receiptDate: string | null;
  declare receiptStatus: ReceiptStatus;
  declare receiptRevision: number;
  declare receiptPdfFileId: number | null;
  declare receiptPdfStatus: ReceiptPdfStatus;
  declare approvalRequestId: number | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare notes: string | null;
  declare needsReview: boolean;
  declare reviewReason: ReviewReason | null;
  declare isDuplicateSuspect: boolean;
  declare duplicateOfPaymentId: number | null;
  declare reversedAt: Date | null;
  declare reversedBy: number | null;
  declare reversalReasonCode: ReversalReasonCode | null;
  declare reversalReason: string | null;
  declare failureReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Payment.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        paymentOrderId: fkColumn(true),
        source: { type: DataTypes.STRING(20), allowNull: false },
        method: { type: DataTypes.STRING(12), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false },
        payerUserId: fkColumn(true),
        payerName: { type: DataTypes.STRING(120), allowNull: false },
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        convenienceFeePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        convenienceFeeGstPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        grossAmountPaise: { type: DataTypes.BIGINT, allowNull: false },
        toInvoicesPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        toCollectionsPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        toAdvancePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        refundedPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        paymentDate: { type: DataTypes.DATEONLY, allowNull: false },
        capturedAt: dateColumn(),
        gatewayAccountId: fkColumn(true),
        gatewayPaymentId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        gatewayMethodDetail: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        referenceNo: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        referenceKey: { type: DataTypes.STRING(90), allowNull: true, defaultValue: null },
        chequeBankName: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
        chequeDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        depositedOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        depositBankAccountId: fkColumn(true),
        clearedOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        bounceReason: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        bouncedOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        bounceChargeInvoiceId: fkColumn(true),
        receiptNo: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        receiptDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        receiptStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'NONE' },
        receiptRevision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        receiptPdfFileId: fkColumn(true),
        receiptPdfStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'NONE' },
        approvalRequestId: fkColumn(true),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        rejectedReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        notes: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        needsReview: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        reviewReason: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        isDuplicateSuspect: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        duplicateOfPaymentId: fkColumn(true),
        reversedAt: dateColumn(),
        reversedBy: fkColumn(true),
        reversalReasonCode: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        reversalReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        failureReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'payments',
        hooks: {
          beforeUpdate: row => {
            const bad = (['amountPaise', 'method', 'source', 'unitId'] as const).filter(c => row.changed(c));
            if (row.changed('receiptNo') && row.previous('receiptNo')) bad.push('receiptNo' as never);
            if (bad.length) throw new Error(`payments row ${row.id} is immutable: ${bad.join(', ')}`);
          },
          beforeDestroy: () => {
            throw new Error('payments rows are never deleted');
          },
        },
      },
    );
  }
}
