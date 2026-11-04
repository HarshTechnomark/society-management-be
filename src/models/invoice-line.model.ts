import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';
import type { LineKind } from '../modules/billing/billing.constants';
import { immutableHooks } from './_immutable';

/** Module 11 section 7.8: a line of an invoice or of a billing note (exactly one parent). Only `creditedPaise` and `updatedBy` change (hook). */
export class InvoiceLine extends Model<InferAttributes<InvoiceLine>, InferCreationAttributes<InvoiceLine>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare invoiceId: number | null;
  declare billingNoteId: number | null;
  declare lineNo: number;
  declare lineKind: LineKind;
  declare chargeHeadId: number | null;
  declare headKey: string | null;
  declare description: string;
  declare quantity: string | null;
  declare ratePaise: number | null;
  declare amountPaise: number;
  declare isTaxable: boolean;
  declare billingRuleVersionId: number | null;
  declare periodFrom: string | null;
  declare periodTo: string | null;
  declare prorationDays: number | null;
  declare periodDays: number | null;
  declare refInvoiceLineId: number | null;
  declare computation: Record<string, unknown> | null;
  declare ledgerAccountCode: string;
  declare creditedPaise: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    InvoiceLine.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        invoiceId: fkColumn(true),
        billingNoteId: fkColumn(true),
        lineNo: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
        lineKind: { type: DataTypes.STRING(12), allowNull: false },
        chargeHeadId: fkColumn(true),
        headKey: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        description: { type: DataTypes.STRING(300), allowNull: false },
        quantity: { type: DataTypes.DECIMAL(14, 4), allowNull: true, defaultValue: null },
        ratePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        isTaxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        billingRuleVersionId: fkColumn(true),
        periodFrom: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        periodTo: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        prorationDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        periodDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        refInvoiceLineId: fkColumn(true),
        computation: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        ledgerAccountCode: { type: DataTypes.STRING(40), allowNull: false },
        creditedPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        createdAt: timestampColumns.createdAt,
        updatedAt: timestampColumns.updatedAt,
      },
      {
        sequelize,
        tableName: 'invoice_lines',
        hooks: immutableHooks('invoice_lines', ['creditedPaise', 'updatedBy']),
      },
    );
  }
}
