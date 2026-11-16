import {
  DataTypes,
  Model,
  QueryTypes,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 13 section 7.3 journal lines: never updated; deleted only with a DRAFT parent (draft lines are replaced as a set). */
export class JournalLine extends Model<InferAttributes<JournalLine>, InferCreationAttributes<JournalLine>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare journalEntryId: number;
  declare lineNo: number;
  declare ledgerAccountId: number;
  declare fundId: number | null;
  declare debitPaise: CreationOptional<number>;
  declare creditPaise: CreationOptional<number>;
  declare entryDate: string;
  declare lineNarration: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    JournalLine.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        journalEntryId: fkColumn(false),
        lineNo: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
        ledgerAccountId: fkColumn(false),
        fundId: fkColumn(true),
        debitPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        creditPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        entryDate: { type: DataTypes.DATEONLY, allowNull: false },
        lineNarration: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'journal_lines',
        hooks: {
          beforeUpdate: row => {
            throw new Error(`journal_lines row ${row.id} is immutable`);
          },
          beforeBulkUpdate: o => {
            o.individualHooks = true;
          },
          beforeBulkDestroy: o => {
            o.individualHooks = true;
          },
          beforeDestroy: async (row, o) => {
            const [e] = await row.sequelize.query('SELECT status FROM journal_entries WHERE id = ?', {
              replacements: [row.journalEntryId],
              type: QueryTypes.SELECT,
              transaction: o.transaction,
            });
            if (e && (e as { status: string }).status !== 'DRAFT')
              throw new Error('lines of a posted journal entry cannot be deleted');
          },
        },
      },
    );
  }
}
