import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { idColumn, timestampColumns } from './_columns';

export const NUMBER_SERIES = [
  'INVOICE',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'RECEIPT',
  'REFUND',
  'VOUCHER',
  'JOURNAL',
  'PURCHASE_ORDER',
  'BOOKING',
  'TICKET',
  'PARKING_STICKER',
  'PARKING_VIOLATION',
  'PARKING_LOTTERY',
  'WORK_ORDER',
  'VENDOR_BILL',
  'MEETING',
  'RESOLUTION',
  'CERTIFICATE',
  'SHARE_CERTIFICATE',
  'PLATFORM_INVOICE',
  'PLATFORM_CREDIT_NOTE',
] as const;
export type NumberSeries = (typeof NUMBER_SERIES)[number];

/** Default prefix per series (module 01 section 7.5); INV and RCT can be overridden per society by the caller. */
export const SERIES_PREFIX: Record<NumberSeries, string> = {
  INVOICE: 'INV',
  CREDIT_NOTE: 'CN',
  DEBIT_NOTE: 'DN',
  RECEIPT: 'RCT',
  REFUND: 'RFD',
  VOUCHER: 'VCH',
  JOURNAL: 'JV',
  PURCHASE_ORDER: 'PO',
  BOOKING: 'BKG',
  TICKET: 'TKT',
  PARKING_STICKER: 'PKS',
  PARKING_VIOLATION: 'PVL',
  PARKING_LOTTERY: 'PLO',
  WORK_ORDER: 'WO',
  VENDOR_BILL: 'VB',
  MEETING: 'MTG',
  RESOLUTION: 'RES',
  CERTIFICATE: 'CRT',
  SHARE_CERTIFICATE: 'SHR',
  PLATFORM_INVOICE: 'PLT',
  PLATFORM_CREDIT_NOTE: 'PCN',
};

/** Module 01 section 7.5. Written only by `nextNumber()` (`src/utils/numberSequences.ts`). */
export class NumberSequence extends Model<
  InferAttributes<NumberSequence>,
  InferCreationAttributes<NumberSequence>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare series: NumberSeries;
  declare financialYear: string;
  declare prefix: string;
  declare nextValue: number;
  declare padding: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    NumberSequence.init(
      {
        id: idColumn,
        societyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        series: { type: DataTypes.STRING(30), allowNull: false },
        financialYear: { type: DataTypes.CHAR(7), allowNull: false },
        prefix: { type: DataTypes.STRING(12), allowNull: false },
        nextValue: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        padding: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 6 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'number_sequences' },
    );
  }
}
