import { createHash, randomBytes } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import { Permission, Role, RolePermission, Society } from '../../models';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { notify, type Recipient } from '../../lib/notify';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { logger } from '../../lib/logger';
import { DEF_BY_KEY, type Scope } from './access-control.permissions';

export const mobileMask = (mobile: string | null | undefined): string | null =>
  mobile ? `${mobile.slice(0, 2)}XXXXX${mobile.slice(-3)}` : null;

/** `r****@mail.in` (section 8.20). */
export const emailMask = (email: string | null | undefined): string | null => {
  if (!email) return null;
  const at = email.indexOf('@');
  return at < 1 ? '****' : `${email[0]}****${email.slice(at)}`;
};

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** 32 random bytes as base64url: 43 characters (BR-03-11). */
export const newToken = (): string => randomBytes(32).toString('base64url');
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const invalidState = (message = 'This action is not allowed in the current state') =>
  new AppError(409, 'INVALID_STATE', message);
export const roleNotFound = () => new NotFoundError('ROLE_NOT_FOUND', 'Role not found');
export const memberNotFound = () => new NotFoundError('MEMBER_NOT_FOUND', 'Member not found');
export const invitationNotFound = () => new NotFoundError('INVITATION_NOT_FOUND', 'Invitation not found');
export const societyNotFound = () => new NotFoundError('SOCIETY_NOT_FOUND', 'Society not found');

/** Runs a notification or realtime emit once the transaction has committed. Never throws. */
export function afterCommit(tx: Transaction, fn: () => Promise<unknown> | unknown): void {
  tx.afterCommit(async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, 'after-commit action failed');
    }
  });
}

export function notifyAfterCommit(
  tx: Transaction,
  templateKey: string,
  recipients: Recipient[],
  data: Record<string, unknown> = {},
): void {
  afterCommit(tx, () => notify(templateKey, recipients, data));
}

export type AccessChangeReason =
  | 'ROLE_CHANGED'
  | 'ROLE_PERMISSIONS_CHANGED'
  | 'SUSPENDED'
  | 'ENDED'
  | 'REACTIVATED'
  | 'GRANT_CHANGED'
  | 'PLATFORM_ROLE_CHANGED'
  | 'UNIT_LINKS_CHANGED';

/** `access.changed` to `user:<id>` and `members.changed` to the society admin room (section 9.2). No permission lists. */
export function emitAccessChanged(
  tx: Transaction,
  societyId: number | null,
  userIds: number[],
  reason: AccessChangeReason,
): void {
  afterCommit(tx, () => {
    for (const id of new Set(userIds)) emitToUser(id, 'access.changed', { societyId, reason });
    if (societyId !== null) emitToRoom(`society:${societyId}:admin`, 'members.changed', { reason });
  });
}

/** Catalogue validation (422 UNKNOWN_PERMISSION, 422 PERMISSION_SCOPE_MISMATCH). Returns the deduplicated keys. */
export function validateKeys(keys: string[], scope: Scope): string[] {
  const unique = [...new Set(keys)];
  const unknown = unique.filter(k => !DEF_BY_KEY.has(k));
  if (unknown.length)
    throw new UnprocessableError(
      'UNKNOWN_PERMISSION',
      'Some permissions do not exist',
      unknown.map(k => ({ field: 'permissionKeys', message: k })),
    );
  const wrong = unique.filter(k => DEF_BY_KEY.get(k)!.scope !== scope);
  if (wrong.length)
    throw new UnprocessableError(
      'PERMISSION_SCOPE_MISMATCH',
      `Permissions must belong to the ${scope} scope`,
      wrong.map(k => ({ field: 'permissionKeys', message: k })),
    );
  return unique;
}

export const hasPrivilegedKey = (keys: string[]): boolean => keys.some(k => DEF_BY_KEY.get(k)?.isPrivileged);

/** Keys of a role read inside the transaction (never the cache), sorted. */
export async function roleKeysTx(roleId: number, tx?: Transaction): Promise<string[]> {
  const rows = await RolePermission.findAll({
    where: { roleId },
    include: [{ model: Permission, attributes: ['key'], required: true }],
    transaction: tx,
  });
  return rows.map(r => (r as any).Permission.key as string).sort();
}

export async function permissionIdMap(keys: string[], tx?: Transaction): Promise<Map<string, number>> {
  if (!keys.length) return new Map();
  const rows = await Permission.findAll({
    where: { key: { [Op.in]: keys } },
    attributes: ['id', 'key'],
    transaction: tx,
  });
  return new Map(rows.map(p => [p.key, p.id!]));
}

/** Replaces the role's permissions: deletes the removed keys, inserts the added ones. */
export async function replaceRoleKeys(
  role: Role,
  newKeys: string[],
  actorUserId: number | null,
  tx: Transaction,
): Promise<{ before: string[]; after: string[]; added: string[]; removed: string[] }> {
  const before = await roleKeysTx(role.id!, tx);
  const after = [...new Set(newKeys)].sort();
  const added = after.filter(k => !before.includes(k));
  const removed = before.filter(k => !after.includes(k));
  if (removed.length) {
    const ids = await permissionIdMap(removed, tx);
    await RolePermission.destroy({
      where: { roleId: role.id!, permissionId: { [Op.in]: [...ids.values()] } },
      transaction: tx,
    });
  }
  if (added.length) {
    const ids = await permissionIdMap(added, tx);
    await RolePermission.bulkCreate(
      added.map(k => ({
        societyId: role.societyId,
        roleId: role.id!,
        permissionId: ids.get(k)!,
        createdBy: actorUserId,
      })) as never,
      { transaction: tx },
    );
  }
  return { before, after, added, removed };
}

export async function getSocietyOr404(societyId: number, tx?: Transaction): Promise<Society> {
  const s = await Society.findByPk(societyId, { transaction: tx });
  if (!s) throw societyNotFound();
  return s;
}

/** A role of this society (live, not platform) or 404 ROLE_NOT_FOUND. */
export async function loadRole(
  societyId: number,
  roleId: number,
  tx?: Transaction,
  lock = false,
): Promise<Role> {
  const r = await Role.findOne({
    where: { id: roleId, societyId },
    transaction: tx,
    lock: lock && tx ? tx.LOCK.UPDATE : undefined,
  });
  if (!r) throw roleNotFound();
  return r;
}

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export const pageOf = <T>(rows: T[], page: number, limit: number): T[] =>
  rows.slice((page - 1) * limit, page * limit);
