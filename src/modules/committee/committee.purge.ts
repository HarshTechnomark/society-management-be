import { sequelize } from '../../models';

/**
 * Module 05 purge handler of module 10 (section 13): hard-deletes the society's terms, newest `id` first so that the
 * `predecessorTermId` RESTRICT holds, in batches of 1,000. Returns `{ deleted, anonymised: 0 }`.
 */
export const PURGE_TABLES = ['committee_terms'];
const BATCH = 1000;

export async function purgeCommittee(societyId: number): Promise<{ deleted: number; anonymised: number }> {
  let deleted = 0;
  for (;;) {
    const [, meta] = await sequelize.query(
      `DELETE FROM committee_terms WHERE societyId = :societyId ORDER BY id DESC LIMIT ${BATCH}`,
      { replacements: { societyId } },
    );
    const n = Number((meta as { affectedRows?: number })?.affectedRows ?? 0);
    deleted += n;
    if (n < BATCH) return { deleted, anonymised: 0 };
  }
}
