import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export const LINE_TYPES = [
  'PLAN',
  'DISCOUNT',
  'ADDON',
  'FLAT_TRUE_UP',
  'OVERAGE',
  'PRORATION',
  'ONE_TIME',
  'MANUAL',
  'CREDIT_NOTE',
] as const;
export type LineType = (typeof LINE_TYPES)[number];

const immutable = (): never => {
  throw new Error('platform_invoice_lines are immutable');
};

/** Module 06 section 7.2. Lines are written once with their invoice; every update or delete throws. */
export class PlatformInvoiceLine extends Model<
  InferAttributes<PlatformInvoiceLine>,
  InferCreationAttributes<PlatformInvoiceLine>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare invoiceId: number;
  declare lineNo: number;
  declare lineType: LineType;
  declare description: string;
  declare sacCode: string;
  declare quantity: string;
  declare unitPricePaise: number;
  declare amountPaise: number;
  declare planVersionId: number | null;
  declare addonKey: string | null;
  declare limitKey: string | null;
  declare servicePeriodStart: string | null;
  declare servicePeriodEnd: string | null;
  declare prorationDays: number | null;
  declare periodDays: number | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    const date = () => ({ type: DataTypes.DATEONLY, allowNull: true, defaultValue: null });
    const small = () => ({ type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null });
    PlatformInvoiceLine.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        invoiceId: fkColumn(false),
        lineNo: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
        lineType: { type: DataTypes.STRING(20), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: false },
        sacCode: { type: DataTypes.CHAR(6), allowNull: false },
        quantity: { type: DataTypes.DECIMAL(12, 4), allowNull: false },
        unitPricePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        planVersionId: fkColumn(true),
        addonKey: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        limitKey: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        servicePeriodStart: date(),
        servicePeriodEnd: date(),
        prorationDays: small(),
        periodDays: small(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'platform_invoice_lines',
        hooks: {
          beforeUpdate: immutable,
          beforeBulkUpdate: immutable,
          beforeDestroy: immutable,
          beforeBulkDestroy: immutable,
        },
      },
    );
  }
}
