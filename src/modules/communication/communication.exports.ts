import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import type { ExportProvider } from '../societies/societies.exports';

/**
 * Module 05 export provider of module 16 (section 13): the society's rows of the tables that carry `societyId`, as stored, in `id` order, 200 rows at a time.
 * `notification_templates`, `notification_preferences` and `push_subscriptions` are platform or user level (not a society's data) and are not exported here.
 * `notifications` leaves out `dataEnc` and `destinationEnc` (never exported, BR-16-31); `notices` leaves out soft-deleted drafts.
 */
const BATCH = 200;

export const COMMUNICATION_TABLES = [
  'notices',
  'notice_receipts',
  'notifications',
  'inbox_items',
  'emergency_broadcasts',
  'emergency_responses',
  'surveys',
  'survey_questions',
  'survey_responses',
] as const;
type Table = (typeof COMMUNICATION_TABLES)[number];

const FILTER: Partial<Record<Table, string>> = {
  notices: 'AND deletedAt IS NULL',
  surveys: 'AND deletedAt IS NULL',
};
const DROP: Partial<Record<Table, string[]>> = { notifications: ['dataEnc', 'destinationEnc'] };

function streamTable(table: Table) {
  return async function* (societyId: number): AsyncGenerator<Record<string, unknown>> {
    let last = 0;
    for (;;) {
      const rows = await sequelize.query<Record<string, unknown> & { id: number }>(
        `SELECT * FROM ${table} WHERE societyId = :societyId AND id > :last ${FILTER[table] ?? ''} ORDER BY id ASC LIMIT ${BATCH}`,
        { replacements: { societyId, last }, type: QueryTypes.SELECT },
      );
      if (!rows.length) return;
      for (const r of rows) {
        for (const c of DROP[table] ?? []) delete r[c];
        yield r;
      }
      last = rows[rows.length - 1]!.id;
    }
  };
}

export const communicationExportProvider: ExportProvider = {
  module: 'communication',
  tables: COMMUNICATION_TABLES.map(name => ({ name, file: `${name}.csv`, stream: streamTable(name) })),
};
