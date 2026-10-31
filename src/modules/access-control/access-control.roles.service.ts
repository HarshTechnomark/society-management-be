import { Op, type Transaction } from 'sequelize';
import { Invitation, Role, SocietyMember, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, ForbiddenError, UnprocessableError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { now } from '../../lib/clock';
import { sessions, users } from '../auth/auth.public';
import { invalidateRoleKeys } from './access-control.cache';
import { getRoleKeys } from './access-control.access';
import { accessPorts } from './access-control.ports';
import { assertGovernable, lockChairmen } from './access-control.guards';
import { assertCanGrant } from './access-control.policies';
import {
  ALL_DEFS,
  AUDIT,
  COMMITTEE_ROLE_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  CATALOGUE,
  type Scope,
} from './access-control.permissions';
import {
  emitAccessChanged,
  hasPrivilegedKey,
  loadRole,
  notifyAfterCommit,
  pageOf,
  replaceRoleKeys,
  roleKeysTx,
  slugify,
  validateKeys,
  getSocietyOr404,
} from './access-control.util';

// ------------------------------------------------------------------ views
export interface RoleView {
  id: number;
  key: string;
  name: string;
  description: string | null;
  scope: string;
  isSystem: boolean;
  isLocked: boolean;
  memberCount: number;
  pendingInvitationCount: number;
  permissionCount: number;
  requiresMfa: boolean;
  version: number;
  updatedAt: string;
}
export interface RoleDetail extends RoleView {
  basedOnRoleId: number | null;
  permissionKeys: string[];
}

async function usage(societyId: number | null, roleIds: number[]) {
  const members = new Map<number, number>();
  const pending = new Map<number, number>();
  if (!roleIds.length) return { members, pending };
  const m = (await SocietyMember.count({
    where: { roleId: { [Op.in]: roleIds }, status: { [Op.ne]: 'ENDED' } },
    group: ['roleId'],
  })) as unknown as { roleId: number; count: number }[];
  for (const r of m) members.set(Number(r.roleId), Number(r.count));
  const p = (await Invitation.count({
    where: { roleId: { [Op.in]: roleIds }, status: 'PENDING' },
    group: ['roleId'],
  })) as unknown as { roleId: number; count: number }[];
  for (const r of p) pending.set(Number(r.roleId), Number(r.count));
  void societyId;
  return { members, pending };
}

const base = (
  r: Role,
  counts: { members: Map<number, number>; pending: Map<number, number> },
  permissionCount: number,
  locked: boolean,
): RoleView => ({
  id: r.id!,
  key: r.key,
  name: r.name,
  description: r.description,
  scope: r.scope,
  isSystem: r.isSystem,
  isLocked: locked && r.key === 'chairman',
  memberCount: counts.members.get(r.id!) ?? 0,
  pendingInvitationCount: counts.pending.get(r.id!) ?? 0,
  permissionCount,
  requiresMfa: r.requiresMfa,
  version: r.version,
  updatedAt: (r.updatedAt ?? now()).toISOString(),
});

export async function roleDetail(r: Role, locked: boolean, tx?: Transaction): Promise<RoleDetail> {
  const keys = await roleKeysTx(r.id!, tx);
  const counts = await usage(r.societyId, [r.id!]);
  return {
    ...base(r, counts, keys.length, locked),
    basedOnRoleId: r.basedOnRoleId,
    permissionKeys: keys,
  };
}

// ------------------------------------------------------------------ catalogue
export interface CatalogueQuery {
  scope: 'society' | 'gate' | 'work' | 'resident';
}

/** Tree for the role editor (8.1). `held` marks keys the caller holds; `null` omits `heldByMe` (platform catalogue). */
export function buildCatalogue(scope: Scope, held: Set<string> | null) {
  const masters = new Map<
    string,
    Map<
      string,
      {
        subMaster: string;
        label: string;
        moduleNo: number;
        permissions: Record<string, unknown>[];
      }
    >
  >();
  for (const d of ALL_DEFS.filter(x => x.scope === scope)) {
    const m = masters.get(d.master) ?? new Map();
    masters.set(d.master, m);
    let s = m.get(d.subMaster);
    if (!s) {
      s = {
        subMaster: d.subMaster,
        label: subLabel(d.master, d.subMaster),
        moduleNo: d.moduleNo,
        permissions: [],
      };
      m.set(d.subMaster, s);
    }
    s.permissions.push({
      key: d.key,
      action: d.action,
      label: d.label,
      isPrivileged: d.isPrivileged,
      ...(held ? { heldByMe: held.has(d.key) } : {}),
    });
  }
  return {
    scope,
    masters: [...masters.entries()].map(([master, subs]) => ({ master, subMasters: [...subs.values()] })),
  };
}

function subLabel(master: string, sub: string): string {
  for (const rows of Object.values(CATALOGUE))
    for (const r of rows) if (r[0] === `${master}.${sub}`) return r[3];
  return sub;
}

export function listPermissions(ctx: Ctx, scope: CatalogueQuery['scope']) {
  return buildCatalogue(scope, new Set(ctx.permissions ?? []));
}

// ------------------------------------------------------------------ list and get
export interface RoleListQuery {
  scope?: 'society' | 'resident' | 'gate' | 'work';
  type?: 'system' | 'custom';
  search?: string;
  sortBy: 'name' | 'createdAt' | 'memberCount';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listRoles(societyId: number, query: RoleListQuery, locked: boolean) {
  const where: Record<string, unknown> = { societyId };
  if (query.scope) where.scope = query.scope;
  if (query.type) where.isSystem = query.type === 'system';
  if (query.search) where.name = { [Op.like]: `%${query.search.replace(/[%_\\]/g, m => `\\${m}`)}%` };
  const roles = await Role.findAll({ where: where as never });
  const counts = await usage(
    societyId,
    roles.map(r => r.id!),
  );
  const sizes = new Map<number, number>();
  for (const r of roles) sizes.set(r.id!, (await getRoleKeys(r.id!)).length);
  const dir = query.sortOrder === 'asc' ? 1 : -1;
  roles.sort((a, b) => {
    let c: number;
    if (query.sortBy === 'memberCount')
      c = (counts.members.get(a.id!) ?? 0) - (counts.members.get(b.id!) ?? 0);
    else if (query.sortBy === 'createdAt') c = (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
    else c = a.name.localeCompare(b.name);
    return c === 0 ? a.id! - b.id! : c * dir;
  });
  const total = roles.length;
  return {
    data: pageOf(roles, query.page, query.limit).map(r => base(r, counts, sizes.get(r.id!) ?? 0, locked)),
    pagination: pageMeta(query.page, query.limit, total),
  };
}

export async function getRole(societyId: number, roleId: number, locked: boolean): Promise<RoleDetail> {
  return roleDetail(await loadRole(societyId, roleId), locked);
}

// ------------------------------------------------------------------ create
export interface CreateRoleInput {
  name: string;
  description?: string;
  scope: 'society' | 'gate' | 'work' | 'resident' | 'platform';
  basedOnRoleId?: number;
  permissionKeys?: string[];
  requiresMfa?: boolean;
}

const nameTaken = () => new ConflictError('ROLE_NAME_TAKEN', 'A role with this name already exists');

export async function assertNameFree(
  societyId: number,
  name: string,
  exceptId: number | null,
  tx: Transaction,
) {
  const same = await Role.findOne({
    where: { societyId, name, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
    transaction: tx,
  });
  if (same) throw nameTaken();
}

async function uniqueKey(societyId: number, name: string, tx: Transaction): Promise<string> {
  const slug = slugify(name) || 'role';
  const stem = `custom_${slug}`.slice(0, 60).replace(/_+$/, '');
  for (let n = 1; n < 1000; n++) {
    const key = n === 1 ? stem : `${stem.slice(0, 60 - String(n).length - 1)}_${n}`;
    if (!(await Role.findOne({ where: { societyId, key }, paranoid: false, transaction: tx }))) return key;
  }
  throw new AppError(500, 'INTERNAL_ERROR', 'Could not build a role key');
}

export async function createRole(ctx: Ctx, input: CreateRoleInput): Promise<RoleDetail> {
  const societyId = ctx.society!.id;
  if (input.scope === 'resident' || input.scope === 'platform')
    throw new UnprocessableError('ROLE_SCOPE_NOT_ALLOWED', 'Custom roles can be society, gate or work roles');
  const scope = input.scope;
  return sequelize.transaction(async tx => {
    let basedOn: Role | null = null;
    let keys = input.permissionKeys;
    if (input.basedOnRoleId) {
      basedOn = await loadRole(societyId, input.basedOnRoleId, tx);
      if (basedOn.scope !== scope)
        throw new UnprocessableError('PERMISSION_SCOPE_MISMATCH', 'The role to clone has another scope');
      if (!keys) keys = await roleKeysTx(basedOn.id!, tx);
    }
    const valid = validateKeys(keys ?? [], scope);
    if (!valid.length)
      throw new UnprocessableError('UNKNOWN_PERMISSION', 'A role needs at least one permission');
    if (scope === 'society') assertCanGrant(ctx, valid);
    await assertNameFree(societyId, input.name, null, tx);
    const key = await uniqueKey(societyId, input.name, tx);
    await accessPorts().entitlements.consumeLimit(ctx, 'limit.custom_roles', 1, { transaction: tx });
    const privileged = hasPrivilegedKey(valid);
    const consumesSeat =
      scope === 'society' && !(basedOn && (COMMITTEE_ROLE_KEYS as readonly string[]).includes(basedOn.key));
    const role = await Role.create(
      {
        societyId,
        scope,
        key,
        name: input.name,
        description: input.description ?? null,
        isSystem: false,
        requiresMfa: privileged ? true : (input.requiresMfa ?? false),
        consumesSeat,
        basedOnRoleId: basedOn?.id ?? null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: tx },
    );
    await replaceRoleKeys(role, valid, ctx.user?.id ?? null, tx);
    await audit(
      ctx,
      {
        action: AUDIT.roleCreated,
        entityType: 'role',
        entityId: role.id!,
        entityLabel: role.name,
        societyId,
        after: { key, scope, permissionKeys: valid, basedOnRoleId: basedOn?.id ?? null },
      },
      tx,
    );
    return roleDetail(role, !!ctx.membership && !ctx.supportGrant, tx);
  });
}

// ------------------------------------------------------------------ update
export interface UpdateRoleInput {
  version: number;
  name?: string;
  description?: string | null;
  permissionKeys?: string[];
  requiresMfa?: boolean;
  reason?: string;
}

/** BR-03-26: sign out members of a role who now need MFA and have not enrolled, so the next sign-in forces enrolment. */
export async function revokeForMfaPolicy(ctx: Ctx, userIds: number[], tx: Transaction): Promise<number[]> {
  const revoked: number[] = [];
  for (const id of userIds) {
    const s = await users.getUserSummary(id, tx);
    if (s.mfaEnabled) continue;
    await sessions.revokeUserSessions(ctx, id, { reason: 'MFA_POLICY_CHANGED' }, tx);
    revoked.push(id);
  }
  return revoked;
}

async function activeMemberUserIds(roleId: number, tx: Transaction): Promise<number[]> {
  return (
    await SocietyMember.findAll({
      where: { roleId, status: 'ACTIVE' },
      attributes: ['userId'],
      transaction: tx,
    })
  ).map(m => m.userId);
}

async function notifyChairmen(tx: Transaction, societyId: number, role: Role): Promise<void> {
  const ids = (
    await SocietyMember.findAll({
      where: { societyId, status: 'ACTIVE' },
      include: [{ model: Role, where: { key: 'chairman' }, attributes: [], required: true }],
      attributes: ['userId'],
      transaction: tx,
    })
  ).map(m => m.userId);
  if (ids.length)
    notifyAfterCommit(
      tx,
      'access.role_permissions_changed',
      ids.map(userId => ({ userId })),
      { roleName: role.name },
    );
}

/**
 * Shared by `PATCH /roles/:id` (society) and `PATCH /platform/societies/:id/roles/:roleId` (platform). The platform path
 * skips the Chairman lock and the no-escalation rule and may set `requiresMfa` on system roles (BR-03-5, BR-03-7).
 */
export async function updateRoleCore(
  ctx: Ctx,
  societyId: number,
  roleId: number,
  input: UpdateRoleInput,
  mode: 'society' | 'platform',
): Promise<RoleDetail> {
  const platform = mode === 'platform';
  return sequelize.transaction(async tx => {
    const role = await loadRole(societyId, roleId, tx, true);
    if (!platform && role.key === 'chairman')
      throw new ForbiddenError(
        'CHAIRMAN_ROLE_LOCKED',
        'Only SocietyApp support can change the Chairman role',
      );
    if (role.version !== input.version)
      throw new ConflictError(
        'STALE_VERSION',
        'Someone else changed this role. Reload to see their changes.',
      );
    if (!platform) await lockChairmen(societyId, tx);

    if (input.name !== undefined && input.name !== role.name) {
      if (role.isSystem)
        throw new UnprocessableError('SYSTEM_ROLE_IMMUTABLE', 'System roles keep their name');
    }
    if (input.requiresMfa !== undefined && !platform && role.isSystem)
      throw new UnprocessableError('MFA_FLAG_LOCKED', 'Two-step sign-in of a system role is set by support');

    const metaBefore = { name: role.name, description: role.description };
    const metaAfter = { ...metaBefore };
    if (input.name !== undefined && input.name !== role.name) {
      await assertNameFree(societyId, input.name, role.id!, tx);
      metaAfter.name = input.name;
    }
    if (input.description !== undefined && input.description !== role.description)
      metaAfter.description = input.description;
    const metaChanged =
      metaAfter.name !== metaBefore.name || metaAfter.description !== metaBefore.description;

    const currentKeys = await roleKeysTx(role.id!, tx);
    let nextKeys = currentKeys;
    if (input.permissionKeys) {
      nextKeys = validateKeys(input.permissionKeys, role.scope as Scope);
      if (!nextKeys.length)
        throw new UnprocessableError('UNKNOWN_PERMISSION', 'A role needs at least one permission');
      if (!platform && role.scope === 'society')
        assertCanGrant(
          ctx,
          nextKeys.filter(k => !currentKeys.includes(k)),
        );
    }
    const keysChanged =
      nextKeys.length !== currentKeys.length || nextKeys.some(k => !currentKeys.includes(k));

    // MFA flag (BR-03-26)
    const hadMfa = role.requiresMfa;
    let mfa = role.requiresMfa;
    if (input.requiresMfa !== undefined) mfa = input.requiresMfa;
    if (!role.isSystem && hasPrivilegedKey(nextKeys)) {
      if (input.requiresMfa === false)
        throw new UnprocessableError(
          'MFA_FLAG_LOCKED',
          'This role holds sensitive permissions; two-step sign-in is required',
        );
      mfa = true;
    }
    const mfaChanged = mfa !== hadMfa;

    if (!metaChanged && !keysChanged && !mfaChanged) {
      return roleDetail(role, !platform, tx);
    }

    role.name = metaAfter.name;
    role.description = metaAfter.description;
    role.requiresMfa = mfa;
    role.version += 1;
    role.updatedBy = ctx.user?.id ?? null;
    await role.save({ transaction: tx });

    let removedRoleEdit = false;
    if (keysChanged) {
      const r = await replaceRoleKeys(role, nextKeys, ctx.user?.id ?? null, tx);
      removedRoleEdit = r.removed.includes('settings.roles.edit');
      await audit(
        ctx,
        {
          action: AUDIT.rolePermissionsChanged,
          entityType: 'role',
          entityId: role.id!,
          entityLabel: role.name,
          societyId,
          before: { permissionKeys: r.before, requiresMfa: hadMfa },
          after: { permissionKeys: r.after, requiresMfa: mfa },
          reason: input.reason ?? null,
        },
        tx,
      );
    } else if (mfaChanged) {
      await audit(
        ctx,
        {
          action: AUDIT.rolePermissionsChanged,
          entityType: 'role',
          entityId: role.id!,
          entityLabel: role.name,
          societyId,
          before: { requiresMfa: hadMfa },
          after: { requiresMfa: mfa },
          reason: input.reason ?? null,
        },
        tx,
      );
    }
    if (metaChanged)
      await audit(
        ctx,
        {
          action: AUDIT.roleUpdated,
          entityType: 'role',
          entityId: role.id!,
          entityLabel: role.name,
          societyId,
          before: metaBefore,
          after: metaAfter,
          reason: input.reason ?? null,
        },
        tx,
      );
    if (removedRoleEdit) await assertGovernable(societyId, tx, { wasRoleManager: true });

    const userIds = await activeMemberUserIds(role.id!, tx);
    if (mfa && !hadMfa) await revokeForMfaPolicy(ctx, userIds, tx);
    invalidateRoleKeys(tx, role.id!);
    if (keysChanged || mfaChanged) {
      emitAccessChanged(tx, societyId, userIds, 'ROLE_PERMISSIONS_CHANGED');
      await notifyChairmen(tx, societyId, role);
    }
    return roleDetail(role, !platform, tx);
  });
}

export const updateRole = (ctx: Ctx, roleId: number, input: UpdateRoleInput) =>
  updateRoleCore(ctx, ctx.society!.id, roleId, input, 'society');

// ------------------------------------------------------------------ reset
export async function resetRole(
  ctx: Ctx,
  roleId: number,
  input: { version: number; reason: string },
): Promise<RoleDetail> {
  const societyId = ctx.society!.id;
  return sequelize.transaction(async tx => {
    const role = await loadRole(societyId, roleId, tx, true);
    if (role.key === 'chairman')
      throw new ForbiddenError(
        'CHAIRMAN_ROLE_LOCKED',
        'Only SocietyApp support can change the Chairman role',
      );
    if (!role.isSystem)
      throw new UnprocessableError('SYSTEM_ROLE_IMMUTABLE', 'Only system roles can be reset');
    if (role.version !== input.version)
      throw new ConflictError(
        'STALE_VERSION',
        'Someone else changed this role. Reload to see their changes.',
      );
    await lockChairmen(societyId, tx);
    const defaults = DEFAULT_ROLE_PERMISSIONS[role.key];
    if (!defaults)
      throw new UnprocessableError('SYSTEM_ROLE_IMMUTABLE', 'This role has no default to restore');
    const current = await roleKeysTx(role.id!, tx);
    if (role.scope === 'society')
      assertCanGrant(
        ctx,
        defaults.filter(k => !current.includes(k)),
      );
    role.version += 1;
    role.updatedBy = ctx.user?.id ?? null;
    await role.save({ transaction: tx });
    const r = await replaceRoleKeys(role, defaults, ctx.user?.id ?? null, tx);
    await audit(
      ctx,
      {
        action: AUDIT.roleReset,
        entityType: 'role',
        entityId: role.id!,
        entityLabel: role.name,
        societyId,
        before: { permissionKeys: r.before },
        after: { permissionKeys: r.after },
        reason: input.reason,
      },
      tx,
    );
    if (r.removed.includes('settings.roles.edit'))
      await assertGovernable(societyId, tx, { wasRoleManager: true });
    const userIds = await activeMemberUserIds(role.id!, tx);
    invalidateRoleKeys(tx, role.id!);
    emitAccessChanged(tx, societyId, userIds, 'ROLE_PERMISSIONS_CHANGED');
    await notifyChairmen(tx, societyId, role);
    return roleDetail(role, true, tx);
  });
}

// ------------------------------------------------------------------ delete
export async function deleteRole(
  ctx: Ctx,
  roleId: number,
  input: { version: number; reason: string },
): Promise<void> {
  const societyId = ctx.society!.id;
  await sequelize.transaction(async tx => {
    const role = await loadRole(societyId, roleId, tx, true);
    if (role.key === 'chairman')
      throw new ForbiddenError(
        'CHAIRMAN_ROLE_LOCKED',
        'Only SocietyApp support can change the Chairman role',
      );
    if (role.isSystem)
      throw new UnprocessableError('SYSTEM_ROLE_IMMUTABLE', 'System roles cannot be deleted');
    if (role.version !== input.version)
      throw new ConflictError(
        'STALE_VERSION',
        'Someone else changed this role. Reload to see their changes.',
      );
    const members = await SocietyMember.count({
      where: { roleId: role.id!, status: { [Op.ne]: 'ENDED' } },
      transaction: tx,
    });
    const pending = await Invitation.count({
      where: { roleId: role.id!, status: 'PENDING' },
      transaction: tx,
    });
    if (members || pending)
      throw new AppError(409, 'ROLE_IN_USE', 'This role is still used by members or pending invitations', [
        { field: 'memberCount', message: String(members) },
        { field: 'pendingInvitationCount', message: String(pending) },
      ]);
    const before = { key: role.key, name: role.name };
    role.key = `${role.key}__del_${role.id}`.slice(0, 80);
    role.name = `${role.name} (deleted ${role.id})`.slice(0, 80);
    role.updatedBy = ctx.user?.id ?? null;
    role.version += 1;
    await role.save({ transaction: tx });
    await role.destroy({ transaction: tx });
    await accessPorts().entitlements.releaseLimit(ctx, 'limit.custom_roles', 1, { transaction: tx });
    await audit(
      ctx,
      {
        action: AUDIT.roleDeleted,
        entityType: 'role',
        entityId: role.id!,
        entityLabel: before.name,
        societyId,
        before,
        reason: input.reason,
      },
      tx,
    );
    invalidateRoleKeys(tx, role.id!);
  });
}

// ------------------------------------------------------------------ platform view of a society's roles
export async function listRolesOfSociety(societyId: number, query: RoleListQuery) {
  await getSocietyOr404(societyId);
  return listRoles(societyId, query, false);
}
