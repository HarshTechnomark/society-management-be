import { sequelize } from '../../models';
import { APPROVALS_TABLES } from './approvals.engine.export';

/**
 * Module 05 purge handler of module 14 (BR-05-21). The four tables are not financial (the money record is the owner module's and
 * the audit log), so all of them are deleted at purge: children first. `approval_actions` is append-only for the application; the
 * purge is the one allowed delete. Order 105 runs after the modules that call into approvals (payments 120, billing 110).
 */
export const PURGE_ORDER = 105;
export const PURGE_TABLES: string[] = [...APPROVALS_TABLES];
const DELETE_ORDER = ['approval_actions', 'approval_delegations', 'approval_requests', 'approval_rules'];
const BATCH = 1000;

export async function purgeApprovals(societyId: number): Promise<{ deleted: number; anonymised: number }> {
  let deleted = 0;
  for (const table of DELETE_ORDER)
    for (;;) {
      const [, meta] = await sequelize.query(
        `DELETE FROM ${table} WHERE societyId = :societyId ORDER BY id DESC LIMIT ${BATCH}`,
        { replacements: { societyId } },
      );
      const c = Number((meta as { affectedRows?: number })?.affectedRows ?? 0);
      deleted += c;
      if (c < BATCH) break;
    }
  return { deleted, anonymised: 0 };
}
