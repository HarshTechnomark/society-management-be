import { sequelize } from '../../models';

/**
 * Module 05 purge handler of module 16 (order 160: before module 15 (150), whose tickets nothing here references, and before modules 11 and 12;
 * everything here only references societies, users, units and approval requests). Deletes for the society, children first: survey responses, questions,
 * surveys, emergency responses, broadcasts, notice receipts, notices, delivery rows and society-scope inbox items. User-level tables are not touched.
 */
export const PURGE_TABLES = [
  'survey_responses',
  'survey_questions',
  'surveys',
  'emergency_responses',
  'emergency_broadcasts',
  'notice_receipts',
  'notices',
  'notifications',
  'inbox_items',
];
export const PURGE_ORDER = 160;

const BATCH = 1000;

async function deleteAll(societyId: number, table: string): Promise<number> {
  let total = 0;
  for (;;) {
    const [, meta] = await sequelize.query(
      `DELETE FROM ${table} WHERE societyId = :societyId ORDER BY id DESC LIMIT ${BATCH}`,
      { replacements: { societyId } },
    );
    const n = Number((meta as { affectedRows?: number })?.affectedRows ?? 0);
    total += n;
    if (n < BATCH) return total;
  }
}

export async function purgeCommunication(
  societyId: number,
): Promise<{ deleted: number; anonymised: number }> {
  let deleted = 0;
  // delivery rows first: their fallback self-reference is SET NULL, so order inside the table does not matter
  for (const t of PURGE_TABLES) deleted += await deleteAll(societyId, t);
  return { deleted, anonymised: 0 };
}
