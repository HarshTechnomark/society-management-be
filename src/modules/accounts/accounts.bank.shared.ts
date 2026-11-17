import { QueryTypes, type Transaction } from 'sequelize';
import { LedgerAccount, sequelize } from '../../models';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { ERR, type BankAccountKind } from './accounts.constants';
import { n } from './accounts.shared';

/** Small helpers shared by the funds and bank account files of 13.2. */
export const bankNotFound = () => new NotFoundError(ERR.bankAccountNotFound, 'Bank account not found');
export const fundNotFound = () => new NotFoundError(ERR.fundNotFound, 'Fund not found');
export const staleVersion = () =>
  new ConflictError(ERR.staleVersion, 'This was changed by someone else. Reload and try again.');

/**
 * Next `NNN` of a ledger code family (`1110-NNN`, `2440-NNN`, `2450-NNN`). Callers hold the `society_balances` row lock
 * (through `ensureBooks`), so two creations in one society never pick the same number.
 */
export async function nextLedgerCode(societyId: number, group: string, t: Transaction): Promise<string> {
  const [row] = await sequelize.query<{ m: string | null }>(
    `SELECT MAX(CAST(SUBSTRING(code, ${group.length + 2}) AS UNSIGNED)) AS m FROM ledger_accounts
      WHERE societyId = :societyId AND code LIKE :like`,
    { replacements: { societyId, like: `${group}-%` }, type: QueryTypes.SELECT, transaction: t },
  );
  const next = n(row?.m) + 1;
  if (next > 999) throw new ConflictError(ERR.invalidState, 'No more ledger numbers are free in this group');
  return `${group}-${String(next).padStart(3, '0')}`;
}

export async function groupLedger(societyId: number, code: string, t: Transaction): Promise<LedgerAccount> {
  const g = await LedgerAccount.findOne({ where: { societyId, code }, transaction: t });
  if (!g) throw new Error(`ledger group ${code} missing for society ${societyId}`);
  return g;
}

/** Chairman, Secretary and Treasurer of the society (recipients of finance notices). */
export async function committeeUserIds(societyId: number, roles = ['chairman', 'secretary', 'treasurer']) {
  const rows = await sequelize.query<{ userId: number }>(
    `SELECT DISTINCT m.userId FROM society_members m JOIN roles r ON r.id = m.roleId
      WHERE m.societyId = :societyId AND m.status = 'ACTIVE' AND r.\`key\` IN (:roles)`,
    { replacements: { societyId, roles }, type: QueryTypes.SELECT },
  );
  return rows.map(r => n(r.userId));
}

export type { BankAccountKind };
