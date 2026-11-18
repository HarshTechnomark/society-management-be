import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import type { ExportProvider } from '../societies/societies.exports';

/**
 * Module 05 export provider of module 15 (section 13): the seven tables as stored, in `id` order, 200 rows at a time. `ticket_comments` leaves out
 * soft-deleted rows (files are exported by module 01).
 */
const BATCH = 200;

export const HELPDESK_TABLES = [
  'ticket_categories',
  'sla_policies',
  'escalation_rules',
  'tickets',
  'ticket_assignments',
  'ticket_upvotes',
  'ticket_comments',
] as const;

const FILTER: Partial<Record<(typeof HELPDESK_TABLES)[number], string>> = {
  ticket_comments: 'AND deletedAt IS NULL',
};

function streamTable(table: (typeof HELPDESK_TABLES)[number]) {
  return async function* (societyId: number): AsyncGenerator<Record<string, unknown>> {
    let last = 0;
    for (;;) {
      const rows = await sequelize.query<Record<string, unknown> & { id: number }>(
        `SELECT * FROM ${table} WHERE societyId = :societyId AND id > :last ${FILTER[table] ?? ''} ORDER BY id ASC LIMIT ${BATCH}`,
        { replacements: { societyId, last }, type: QueryTypes.SELECT },
      );
      if (!rows.length) return;
      for (const r of rows) yield r;
      last = rows[rows.length - 1]!.id;
    }
  };
}

export const helpdeskExportProvider: ExportProvider = {
  module: 'helpdesk',
  tables: HELPDESK_TABLES.map(name => ({ name, file: `${name}.csv`, stream: streamTable(name) })),
};
