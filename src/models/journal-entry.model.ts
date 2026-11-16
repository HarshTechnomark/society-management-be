import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { JournalSource, JournalStatus, VoucherType } from '../modules/accounts/accounts.constants';

/** Columns of a POSTED entry that may still change, once, from NULL (BR-13-4). */
const REVERSAL_COLUMNS = new Set(['reversedByEntryId', 'reversedAt', 'reversalReason', 'updatedAt']);

/**
 * Module 13 section 7.2 journal entries. Posted entries are immutable: `beforeUpdate` throws unless only the reversal columns change
 * (from NULL), deletes are refused unless the entry is a DRAFT (MySQL triggers enforce the same where the server allows them). The
 * generated column `dedupeKey` is not mapped.
 */
export class JournalEntry extends Model<
  InferAttributes<JournalEntry>,
  InferCreationAttributes<JournalEntry>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare voucherNo: string | null;
  declare voucherType: VoucherType;
  declare entryDate: string;
  declare documentDate: string;
  declare financialYear: string;
  declare narration: string;
  declare refType: string;
  declare refId: string;
  declare linesHash: string;
  declare instrumentRef: string | null;
  declare source: JournalSource;
  declare status: JournalStatus;
  declare totalPaise: CreationOptional<number>;
  declare reversalOfId: number | null;
  declare reversedByEntryId: number | null;
  declare reversedAt: Date | null;
  declare reversalReason: string | null;
  declare approvalRequestId: number | null;
  declare rejectionReason: string | null;
  declare postedAt: Date | null;
  declare postedBy: number | null;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    JournalEntry.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        voucherNo: { type: DataTypes.STRING(30), allowNull: true, defaultValue: null },
        voucherType: { type: DataTypes.STRING(30), allowNull: false },
        entryDate: { type: DataTypes.DATEONLY, allowNull: false },
        documentDate: { type: DataTypes.DATEONLY, allowNull: false },
        financialYear: { type: DataTypes.CHAR(7), allowNull: false },
        narration: { type: DataTypes.STRING(500), allowNull: false },
        refType: { type: DataTypes.STRING(40), allowNull: false },
        refId: { type: DataTypes.STRING(60), allowNull: false },
        linesHash: { type: DataTypes.CHAR(64), allowNull: false },
        instrumentRef: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        source: { type: DataTypes.STRING(30), allowNull: false },
        status: { type: DataTypes.STRING(30), allowNull: false },
        totalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        reversalOfId: fkColumn(true),
        reversedByEntryId: fkColumn(true),
        reversedAt: dateColumn(),
        reversalReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        approvalRequestId: fkColumn(true),
        rejectionReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        postedAt: dateColumn(),
        postedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'journal_entries',
        hooks: {
          beforeUpdate: row => {
            if (row.previous('status') !== 'POSTED') return;
            const bad = (row.changed() || []).filter(c => !REVERSAL_COLUMNS.has(String(c)));
            if (bad.length || row.previous('reversedByEntryId') != null)
              throw new Error(
                `journal_entries row ${row.id} is posted and immutable${bad.length ? `: ${bad.join(', ')}` : ''}`,
              );
          },
          beforeBulkUpdate: o => {
            o.individualHooks = true;
          },
          beforeDestroy: row => {
            if (row.status !== 'DRAFT') throw new Error('only a draft journal entry can be deleted');
          },
          beforeBulkDestroy: o => {
            o.individualHooks = true;
          },
        },
      },
    );
  }
}
