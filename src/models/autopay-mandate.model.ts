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
  DebitStatus,
  MandateEndReason,
  MandateStatus,
  MandateType,
} from '../modules/payments/payments.constants';

/** Module 12 section 7.6 AutoPay mandates. The generated column `liveSlot` is not mapped. */
export class AutopayMandate extends Model<
  InferAttributes<AutopayMandate>,
  InferCreationAttributes<AutopayMandate>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare payerUserId: number;
  declare mandateType: MandateType;
  declare gatewayAccountId: number;
  declare gatewayMandateId: string | null;
  declare gatewayCustomerId: string | null;
  declare payerInstrumentMasked: string | null;
  declare maxAmountPaise: number;
  declare debitDaysBeforeDue: number;
  declare startDate: string;
  declare endDate: string;
  declare status: MandateStatus;
  declare consecutiveFailures: number;
  declare lastDebitAt: Date | null;
  declare lastDebitStatus: DebitStatus | null;
  declare activatedAt: Date | null;
  declare pausedAt: Date | null;
  declare endedAt: Date | null;
  declare endReason: MandateEndReason | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    AutopayMandate.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        payerUserId: fkColumn(false),
        mandateType: { type: DataTypes.STRING(12), allowNull: false },
        gatewayAccountId: fkColumn(false),
        gatewayMandateId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        gatewayCustomerId: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
        payerInstrumentMasked: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        maxAmountPaise: { type: DataTypes.BIGINT, allowNull: false },
        debitDaysBeforeDue: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 2 },
        startDate: { type: DataTypes.DATEONLY, allowNull: false },
        endDate: { type: DataTypes.DATEONLY, allowNull: false },
        status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'PENDING_AUTH' },
        consecutiveFailures: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastDebitAt: dateColumn(),
        lastDebitStatus: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        activatedAt: dateColumn(),
        pausedAt: dateColumn(),
        endedAt: dateColumn(),
        endReason: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'autopay_mandates' },
    );
  }
}
