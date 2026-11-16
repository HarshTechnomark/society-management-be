import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { RequestStatus } from '../modules/payments/payments.constants';

/** Module 12 section 7.9 one row per unit asked to pay in a published collection. `beforeDestroy` throws. */
export class CollectionRequest extends Model<
  InferAttributes<CollectionRequest>,
  InferCreationAttributes<CollectionRequest>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare collectionId: number;
  declare unitId: number;
  declare billToResidentId: number | null;
  declare amountPaise: number;
  declare minAmountPaise: number;
  declare paidPaise: number;
  declare status: RequestStatus;
  declare invoiceId: number | null;
  declare lastPaidAt: Date | null;
  declare waivedReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    CollectionRequest.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        collectionId: fkColumn(false),
        unitId: fkColumn(false),
        billToResidentId: fkColumn(true),
        amountPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        minAmountPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        paidPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'OPEN' },
        invoiceId: fkColumn(true),
        lastPaidAt: dateColumn(),
        waivedReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'collection_requests',
        hooks: {
          beforeDestroy: () => {
            throw new Error('collection_requests rows are never deleted');
          },
        },
      },
    );
  }
}
