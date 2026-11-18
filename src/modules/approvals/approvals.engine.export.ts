import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import type { ExportProvider } from '../societies/societies.exports';

/** Module 05 export provider of module 14: the 4 tables as stored, in `id` order, 200 rows at a time. */
const BATCH = 200;

export const APPROVALS_TABLES = [
  'approval_rules',
  'approval_requests',
  'approval_actions',
  'approval_delegations',
] as const;

function streamTable(table: string) {
  return async function* (societyId: number): AsyncGenerator<Record<string, unknown>> {
    let last = 0;
    for (;;) {
      const rows = await sequelize.query<Record<string, unknown> & { id: number }>(
        `SELECT * FROM ${table} WHERE societyId = :societyId AND id > :last ORDER BY id ASC LIMIT ${BATCH}`,
        { replacements: { societyId, last }, type: QueryTypes.SELECT },
      );
      if (!rows.length) return;
      for (const r of rows) yield r;
      last = rows[rows.length - 1]!.id;
    }
  };
}

export const approvalsExportProvider: ExportProvider = {
  module: 'approvals',
  tables: APPROVALS_TABLES.map(name => ({ name, file: `${name}.csv`, stream: streamTable(name) })),
};
