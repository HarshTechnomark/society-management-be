import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../../models';
import { AppError } from '../../utils/errors';

/**
 * Last-chairman and last-Super-Admin guards with row locks (BR-03-8, BR-03-25). Call `lockChairmen` (or `lockSuperAdmins`)
 * first in the transaction so two parallel demotions are serialised: the second one re-counts after the first commits.
 */
const CHAIRMAN_ROWS = `
  FROM society_members m JOIN roles r ON r.id = m.roleId
  WHERE m.societyId = :societyId AND m.status = 'ACTIVE' AND r.\`key\` = 'chairman' AND r.societyId = :societyId`;

export async function lockChairmen(societyId: number, tx: Transaction): Promise<number[]> {
  const rows = await sequelize.query<{ id: number }>(
    `SELECT m.id ${CHAIRMAN_ROWS} ORDER BY m.id FOR UPDATE OF m`,
    { replacements: { societyId }, type: QueryTypes.SELECT, transaction: tx },
  );
  return rows.map(r => Number(r.id));
}

export async function countActiveChairmen(societyId: number, tx: Transaction): Promise<number> {
  // a locking read sees the latest committed rows (a plain read would use the transaction's older snapshot)
  const rows = await sequelize.query<{ id: number }>(`SELECT m.id ${CHAIRMAN_ROWS} FOR UPDATE OF m`, {
    replacements: { societyId },
    type: QueryTypes.SELECT,
    transaction: tx,
  });
  return rows.length;
}

export async function countRoleManagers(societyId: number, tx: Transaction): Promise<number> {
  const rows = await sequelize.query<{ id: number }>(
    `SELECT DISTINCT m.id
       FROM society_members m
       JOIN role_permissions rp ON rp.roleId = m.roleId
       JOIN permissions p ON p.id = rp.permissionId AND p.\`key\` = 'settings.roles.edit'
      WHERE m.societyId = :societyId AND m.status = 'ACTIVE' FOR UPDATE OF m`,
    { replacements: { societyId }, type: QueryTypes.SELECT, transaction: tx },
  );
  return rows.length;
}

const lastChairman = () =>
  new AppError(409, 'LAST_CHAIRMAN', 'The society needs at least one active chairman');

/**
 * Evaluates BR-03-8 on the state AFTER the change (the change is already applied inside `tx`; throwing rolls it back).
 * - `leavingChairman`: the change removed an active chairman; the society must still have one.
 * - `wasRoleManager`: the change removed `settings.roles.edit` from someone; a society without a chairman must still have
 *   at least one active member who holds it.
 */
export async function assertGovernable(
  societyId: number,
  tx: Transaction,
  opts: { leavingChairman?: boolean; wasRoleManager?: boolean },
): Promise<void> {
  const chairmen = await countActiveChairmen(societyId, tx);
  if (opts.leavingChairman && chairmen === 0) throw lastChairman();
  if (chairmen > 0) return;
  if (opts.wasRoleManager && (await countRoleManagers(societyId, tx)) === 0) throw lastChairman();
}

/** Locks the ACTIVE Super Admin users, returns their ids. */
export async function lockSuperAdmins(tx: Transaction): Promise<number[]> {
  const rows = await sequelize.query<{ id: number }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.platformRoleId
      WHERE r.\`key\` = 'super_admin' AND r.societyId IS NULL AND u.status = 'ACTIVE'
      ORDER BY u.id FOR UPDATE OF u`,
    { type: QueryTypes.SELECT, transaction: tx },
  );
  return rows.map(r => Number(r.id));
}

export const lastSuperAdmin = () =>
  new AppError(409, 'LAST_SUPER_ADMIN', 'At least one active Super Admin is required');
