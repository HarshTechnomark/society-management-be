import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import { BILLING_TABLES } from './billing.exports';

/**
 * Module 05 purge handler of module 11 (section 13, order 110: after module 12's 120, before 08). Module 05 forbids purge
 * handlers to touch financial tables (BR-05-21: `invoices`, `invoice_lines`, `billing_runs`, `billing_run_items`,
 * `unit_ledger_entries`, `opening_balances`), so this handler only anonymises `billing_notes.billToName`
 * (`Former member #<residentId>`). Every financial row and the `INVOICE_PDF` files are kept until the end of financial
 * retention; `billingRetentionExpiry` then deletes the society's rows of all 12 tables. The spec's anonymisation of
 * `invoices` and `billing_run_items` and the deletion of DRAFT/INVALID opening balances therefore happen at retention
 * expiry, not at purge (module 05's guard wins).
 */
export const PURGE_TABLES = ['billing_notes'];

export async function purgeBilling(societyId: number): Promise<{ deleted: number; anonymised: number }> {
  const [, meta] = await sequelize.query(
    `UPDATE billing_notes SET billToName = CONCAT('Former member #', billToResidentId)
     WHERE societyId = :societyId AND billToName NOT LIKE 'Former member #%'`,
    { replacements: { societyId }, type: QueryTypes.UPDATE },
  );
  return { deleted: 0, anonymised: Number(meta ?? 0) };
}

/** End of financial retention (BR-05-38): delete the society's billing rows, children first. */
const DELETE_ORDER = [...BILLING_TABLES].reverse();
const BATCH = 1000;

export async function deleteRetainedBilling(societyId: number): Promise<{ deleted: number }> {
  let deleted = 0;
  // children first; `id DESC` keeps self-references (credit-note lines pointing at invoice lines) valid inside a batch
  for (const table of DELETE_ORDER) {
    for (;;) {
      const [, meta] = await sequelize.query(
        `DELETE FROM ${table} WHERE societyId = :societyId ORDER BY id DESC LIMIT ${BATCH}`,
        { replacements: { societyId } },
      );
      const n = Number((meta as { affectedRows?: number })?.affectedRows ?? 0);
      deleted += n;
      if (n < BATCH) break;
    }
  }
  return { deleted };
}
