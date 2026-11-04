import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type {
  ConfigStatus,
  GstTreatment,
  HeadType,
  PayerRouting,
} from '../modules/billing/billing.constants';

/** Module 11 section 7.1: a charge head (maintenance, sinking fund, parking ...). `key` and `headType` never change (BR-11-8). Not paranoid; archived by status. */
export class ChargeHead extends Model<InferAttributes<ChargeHead>, InferCreationAttributes<ChargeHead>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare key: string;
  declare name: string;
  declare description: string | null;
  declare headType: HeadType;
  declare payerRouting: PayerRouting;
  declare gstTreatment: GstTreatment;
  declare sacCode: string | null;
  declare prorate: boolean;
  declare interestBearing: boolean;
  declare ledgerAccountCode: string;
  declare fundId: number | null;
  declare isSystem: boolean;
  declare status: ConfigStatus;
  declare sortOrder: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    ChargeHead.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        key: { type: DataTypes.STRING(40), allowNull: false },
        name: { type: DataTypes.STRING(80), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        headType: { type: DataTypes.STRING(30), allowNull: false },
        payerRouting: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'BILL_TO' },
        gstTreatment: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'NONE' },
        sacCode: { type: DataTypes.STRING(8), allowNull: true, defaultValue: null },
        prorate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        interestBearing: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        ledgerAccountCode: { type: DataTypes.STRING(40), allowNull: false },
        fundId: fkColumn(true),
        isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 100 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'charge_heads',
      },
    );
  }
}
