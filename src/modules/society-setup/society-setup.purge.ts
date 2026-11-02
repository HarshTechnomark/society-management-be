import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';

/**
 * Module 05 purge handler of module 08 (section 13). Deletes the society's settings, onboarding steps and holidays,
 * the location nodes leaf first, then units and buildings that no foreign key still references (financial records kept by
 * modules 11 and 13 for 8 years keep their units, which hold no personal data). Returns `{ deleted, anonymised: 0 }`.
 */
export const PURGE_TABLES = [
  'society_settings',
  'onboarding_steps',
  'holidays',
  'location_nodes',
  'units',
  'buildings',
];

const isReferenced = (err: unknown): boolean =>
  /foreign key|ER_ROW_IS_REFERENCED/i.test(
    String((err as { message?: string; name?: string })?.message ?? ''),
  ) || (err as { name?: string })?.name === 'SequelizeForeignKeyConstraintError';

const affected = (meta: unknown): number => Number((meta as { affectedRows?: number })?.affectedRows ?? 0);

/** Deletes the rows one by one when a bulk delete hits a foreign key, leaving the referenced rows in place. */
async function deleteFree(
  table: string,
  where: string,
  societyId: number,
  order = 'id DESC',
): Promise<number> {
  try {
    const [, meta] = await sequelize.query(`DELETE FROM ${table} WHERE ${where}`, {
      replacements: { societyId },
    });
    return affected(meta);
  } catch (err) {
    if (!isReferenced(err)) throw err;
  }
  const rows = await sequelize.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE ${where} ORDER BY ${order}`,
    {
      replacements: { societyId },
      type: QueryTypes.SELECT,
    },
  );
  let n = 0;
  for (const { id } of rows)
    try {
      const [, meta] = await sequelize.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id } });
      n += affected(meta);
    } catch (err) {
      if (!isReferenced(err)) throw err;
    }
  return n;
}

export async function purgeSocietySetup(societyId: number): Promise<{ deleted: number; anonymised: number }> {
  let deleted = 0;
  // module 03 invitations hold the foreign key to units that this module added; they are anonymised by module 03
  await sequelize.query(
    'UPDATE invitations SET unitId = NULL WHERE societyId = :societyId AND unitId IS NOT NULL',
    {
      replacements: { societyId },
    },
  );
  for (const table of ['society_settings', 'onboarding_steps', 'holidays'])
    deleted += await deleteFree(table, 'societyId = :societyId', societyId);
  for (let depth = 4; depth >= 1; depth--)
    deleted += await deleteFree('location_nodes', `societyId = :societyId AND depth = ${depth}`, societyId);
  deleted += await deleteFree('units', 'societyId = :societyId', societyId);
  // wings before their towers
  deleted += await deleteFree(
    'buildings',
    'societyId = :societyId AND parentBuildingId IS NOT NULL',
    societyId,
  );
  deleted += await deleteFree('buildings', 'societyId = :societyId', societyId);
  return { deleted, anonymised: 0 };
}
