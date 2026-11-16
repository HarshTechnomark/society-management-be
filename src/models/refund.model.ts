import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { RefundMode, RefundStatus } from '../modules/payments/payments.constants';

/** Module 12 section 7.4 refunds. The generated column `openSlot` is not mapped. `beforeDestroy` throws. */
export class Refund extends Model<InferAttributes<Refund>, InferCreationAttributes<Refund>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare refundNo: string | null;
  declare unitId: number;
  declare paymentId: number;
  declare amountPaise: number;
  declare freedFromAllocationsPaise: number;
  declare mode: RefundMode;
  declare status: RefundStatus;
  declare reason: string;
  declare payeeName: string | null;
  declare payeeAccountMasked: string | null;
  declare gatewayRefundId: string | null;
  declare bankReference: string | null;
  declare paidOutOn: string | null;
  declare failureReason: string | null;
  declare approvalRequestId: number | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare processedAt: Date | null;
  declare lastCheckedAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Refund.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        refundNo: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        unitId: fkColumn(false),
        paymentId: fkColumn(false),
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        freedFromAllocationsPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        mode: { type: DataTypes.STRING(15), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PENDING_APPROVAL' },
        reason: { type: DataTypes.STRING(500), allowNull: false },
        payeeName: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        payeeAccountMasked: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        gatewayRefundId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        bankReference: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        paidOutOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        failureReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        approvalRequestId: fkColumn(true),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        rejectedReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        processedAt: dateColumn(),
        lastCheckedAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'refunds',
        hooks: {
          beforeDestroy: () => {
            throw new Error('refunds rows are never deleted');
          },
        },
      },
    );
  }
}
