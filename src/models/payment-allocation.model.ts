import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type { AllocReason, AllocSource, AllocTarget } from '../modules/payments/payments.constants';
import { immutableHooks } from './_immutable';

/** Module 12 section 7.3 append-only allocation rows; a reversal is a new negative row pointing at the original (`reversalOfId`). Update and delete throw. */
export class PaymentAllocation extends Model<
  InferAttributes<PaymentAllocation>,
  InferCreationAttributes<PaymentAllocation>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare source: AllocSource;
  declare paymentId: number | null;
  declare unitAdvanceId: number | null;
  declare targetType: AllocTarget;
  declare invoiceId: number | null;
  declare collectionRequestId: number | null;
  declare amountPaise: number;
  declare reversalOfId: number | null;
  declare reasonCode: AllocReason;
  declare allocatedOn: string;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    PaymentAllocation.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        source: { type: DataTypes.STRING(10), allowNull: false },
        paymentId: fkColumn(true),
        unitAdvanceId: fkColumn(true),
        targetType: { type: DataTypes.STRING(20), allowNull: false },
        invoiceId: fkColumn(true),
        collectionRequestId: fkColumn(true),
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        reversalOfId: fkColumn(true),
        reasonCode: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ALLOCATED' },
        allocatedOn: { type: DataTypes.DATEONLY, allowNull: false },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'payment_allocations', hooks: immutableHooks('payment_allocations', []) },
    );
  }
}
