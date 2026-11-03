import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';

/**
 * Module 05 purge handler of module 09 (section 13): deletes the society's rows in reverse dependency order, in batches of
 * 1,000. Returns `{ deleted, anonymised: 0 }`. Invitations that point at a resident are anonymised by module 03 first.
 */
export const PURGE_TABLES = [
  'emergency_profiles',
  'pets',
  'resident_documents',
  'move_requests',
  'renovation_permits',
  'join_requests',
  'unit_residents',
  'ownership_transfers',
  'tenancies',
  'residents',
];

const BATCH = 1000;

async function deleteBatches(table: string, societyId: number, order: string): Promise<number> {
  let total = 0;
  for (;;) {
    const [, meta] = await sequelize.query(
      `DELETE FROM ${table} WHERE societyId = :societyId ORDER BY ${order} LIMIT ${BATCH}`,
      { replacements: { societyId } },
    );
    const n = Number((meta as { affectedRows?: number })?.affectedRows ?? 0);
    total += n;
    if (n < BATCH) return total;
  }
}

export async function purgeResidents(societyId: number): Promise<{ deleted: number; anonymised: number }> {
  await sequelize.query(
    'UPDATE invitations SET residentId = NULL WHERE societyId = :societyId AND residentId IS NOT NULL',
    {
      replacements: { societyId },
      type: QueryTypes.UPDATE,
    },
  );
  let deleted = 0;
  for (const table of PURGE_TABLES) deleted += await deleteBatches(table, societyId, 'id DESC');
  return { deleted, anonymised: 0 };
}
