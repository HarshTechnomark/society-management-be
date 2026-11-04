import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import type { ExportProvider } from '../societies/societies.exports';

/**
 * Module 05 export provider of module 11 (section 13): streams all 12 tables as stored (financial columns as stored,
 * `billToName` included because the export goes to the society itself), in `id` order, 200 rows at a time.
 */
const BATCH = 200;

export const BILLING_TABLES = [
  'charge_heads',
  'bill_split_rules',
  'billing_rules',
  'billing_rule_versions',
  'late_fee_policies',
  'billing_runs',
  'invoices',
  'billing_run_items',
  'billing_notes',
  'invoice_lines',
  'unit_ledger_entries',
  'opening_balances',
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

export const billingExportProvider: ExportProvider = {
  module: 'billing',
  tables: BILLING_TABLES.map(name => ({ name, file: `${name}.csv`, stream: streamTable(name) })),
};
