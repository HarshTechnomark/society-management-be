import { Op } from 'sequelize';
import { Invitation, Role, User, sequelize } from '../../models';
import { env } from '../../lib/env';
import { emitToUser } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { auth, users } from '../auth/auth.public';
import { AUDIT, SCOPES } from './access-control.permissions';
import { assertNotSelf } from './access-control.policies';
import { lockSuperAdmins, lastSuperAdmin } from './access-control.guards';
import { createInvitationCore, invitationViews } from './access-control.invitations.service';
import { buildCatalogue, roleDetail, type RoleView } from './access-control.roles.service';
import { afterCommit, pageOf, roleNotFound } from './access-control.util';

const notPlatformUser = () => new AppError(404, 'PLATFORM_USER_NOT_FOUND', 'Platform team member not found');

export function platformCatalogue() {
  return { scopes: SCOPES.map(s => buildCatalogue(s, null)) };
}

export async function platformRoles(): Promise<
  (RoleView & { permissionKeys: string[]; userCount: number })[]
> {
  const roles = await Role.findAll({ where: { societyId: null, scope: 'platform' }, order: [['id', 'ASC']] });
  const out = [];
  for (const r of roles) {
    const d = await roleDetail(r, false);
    const userCount = await User.count({ where: { platformRoleId: r.id! } });
    out.push({ ...d, userCount });
  }
  return out;
}

// ------------------------------------------------------------------ team list
export interface TeamQuery {
  status: 'ACTIVE' | 'DISABLED' | 'INVITED' | 'ALL';
  roleId?: number;
  search?: string;
  sortBy: 'name' | 'lastLoginAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listTeam(ctx: Ctx, q: TeamQuery) {
  const items: any[] = [];
  if (q.status !== 'INVITED') {
    const rows = (await User.findAll({
      where: { platformRoleId: q.roleId ?? { [Op.ne]: null } },
      include: [{ model: Role, as: 'platformRole', attributes: ['id', 'key', 'name'], required: true }],
    })) as (User & { platformRole: Role })[];
    for (const u of rows) {
      const status = u.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED';
      if (q.status !== 'ALL' && q.status !== status) continue;
      items.push({
        kind: 'USER',
        userId: u.id!,
        name: u.name ?? '',
        email: u.email,
        mobile: u.mobile,
        role: { id: u.platformRole.id!, key: u.platformRole.key, name: u.platformRole.name },
        status,
        mfaEnabled: u.mfaEnabledAt !== null,
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        isSelf: u.id === ctx.user?.id,
      });
    }
  }
  if (q.status === 'ALL' || q.status === 'INVITED') {
    const inv = await Invitation.findAll({
      where: { societyId: null, status: 'PENDING', ...(q.roleId ? { roleId: q.roleId } : {}) },
    });
    const views = await invitationViews(inv, true, false);
    for (const [i, v] of views.entries())
      items.push({
        kind: 'INVITATION',
        invitationId: v.id,
        name: v.name,
        email: v.email,
        mobile: v.mobile,
        role: v.role,
        status: 'INVITED',
        expiresAt: v.expiresAt,
        resendCount: v.resendCount,
        lastLoginAt: null,
        _i: i,
      });
  }
  const term = q.search?.toLowerCase();
  const filtered = term
    ? items.filter(
        i => (i.name as string).toLowerCase().includes(term) || (i.email ?? '').toLowerCase().includes(term),
      )
    : items;
  const dir = q.sortOrder === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const c =
      q.sortBy === 'lastLoginAt'
        ? String(a.lastLoginAt ?? '').localeCompare(String(b.lastLoginAt ?? ''))
        : String(a.name).localeCompare(String(b.name));
    return c * dir;
  });
  const clean = filtered.map(({ _i, lastLoginAt, ...rest }) =>
    rest.kind === 'USER' ? { ...rest, lastLoginAt } : rest,
  );
  return { data: pageOf(clean, q.page, q.limit), pagination: pageMeta(q.page, q.limit, clean.length) };
}

// ------------------------------------------------------------------ invite
export async function invitePlatformMember(
  ctx: Ctx,
  body: { name: string; mobile: string; email: string; roleId: number },
) {
  const domain = env().PLATFORM_TEAM_EMAIL_DOMAIN.toLowerCase();
  if (!body.email.toLowerCase().endsWith(`@${domain}`))
    throw new UnprocessableError('EMAIL_DOMAIN_NOT_ALLOWED', `Use a ${domain} work email address`, [
      { field: 'email', message: `Must end with @${domain}` },
    ]);
  const inv = await sequelize.transaction(async tx => {
    const r = await createInvitationCore(ctx, { societyId: null, ...body }, tx);
    return r.invitation;
  });
  return (await invitationViews([inv], true, false))[0]!;
}

// ------------------------------------------------------------------ account actions
async function loadPlatformUser(userId: number, tx: import('sequelize').Transaction): Promise<User> {
  const u = await User.findByPk(userId, { transaction: tx, lock: tx.LOCK.UPDATE });
  if (!u || !u.platformRoleId) throw notPlatformUser();
  return u;
}

async function roleKeyOf(roleId: number | null, tx: import('sequelize').Transaction): Promise<string | null> {
  if (roleId === null) return null;
  return (await Role.findByPk(roleId, { attributes: ['key'], transaction: tx }))?.key ?? null;
}

/** Throws LAST_SUPER_ADMIN when `userId` is an active Super Admin and nobody else would remain. */
async function assertOtherSuperAdmin(userId: number, tx: import('sequelize').Transaction): Promise<void> {
  const admins = await lockSuperAdmins(tx);
  if (admins.includes(userId) && admins.filter(id => id !== userId).length === 0) throw lastSuperAdmin();
}

export async function changePlatformRole(
  ctx: Ctx,
  userId: number,
  input: { roleId: number; reason: string },
) {
  return sequelize.transaction(async tx => {
    await lockSuperAdmins(tx);
    const u = await loadPlatformUser(userId, tx);
    assertNotSelf(ctx, userId);
    const role = await Role.findOne({
      where: { id: input.roleId, societyId: null, scope: 'platform' },
      transaction: tx,
    });
    if (!role) throw roleNotFound();
    if (role.id === u.platformRoleId)
      throw new ValidationError([{ field: 'roleId', message: 'Pick a different role' }]);
    if (role.key !== 'super_admin') await assertOtherSuperAdmin(userId, tx);
    const r = await users.setPlatformRole(tx, userId, role.id!);
    await audit(
      ctx,
      {
        action: AUDIT.platformMemberRoleChanged,
        entityType: 'user',
        entityId: userId,
        societyId: null,
        before: { roleKey: await roleKeyOf(r.before, tx) },
        after: { roleKey: role.key },
        reason: input.reason,
      },
      tx,
    );
    afterCommit(tx, () =>
      emitToUser(userId, 'access.changed', { societyId: null, reason: 'PLATFORM_ROLE_CHANGED' }),
    );
    return { userId, role: { id: role.id!, key: role.key, name: role.name } };
  });
}

export async function disablePlatformMember(ctx: Ctx, userId: number, reason: string): Promise<void> {
  await sequelize.transaction(async tx => {
    await lockSuperAdmins(tx);
    await loadPlatformUser(userId, tx);
    assertNotSelf(ctx, userId);
    await assertOtherSuperAdmin(userId, tx);
    await users.disableUser(ctx, userId, reason, tx);
    await audit(
      ctx,
      {
        action: AUDIT.platformMemberDisabled,
        entityType: 'user',
        entityId: userId,
        societyId: null,
        after: { status: 'DISABLED' },
        reason,
      },
      tx,
    );
  });
}

export async function enablePlatformMember(ctx: Ctx, userId: number, reason: string): Promise<void> {
  await sequelize.transaction(async tx => {
    await loadPlatformUser(userId, tx);
    assertNotSelf(ctx, userId);
    await users.enableUser(ctx, userId, reason, tx);
    await audit(
      ctx,
      {
        action: AUDIT.platformMemberEnabled,
        entityType: 'user',
        entityId: userId,
        societyId: null,
        after: { status: 'ACTIVE' },
        reason,
      },
      tx,
    );
  });
}

export async function resetPlatformMfa(ctx: Ctx, userId: number, reason: string): Promise<void> {
  await sequelize.transaction(async tx => {
    await loadPlatformUser(userId, tx);
    assertNotSelf(ctx, userId);
    await auth.resetMfa(ctx, userId, reason, tx);
    await audit(
      ctx,
      { action: AUDIT.platformMemberMfaReset, entityType: 'user', entityId: userId, societyId: null, reason },
      tx,
    );
  });
}

export async function removePlatformMember(ctx: Ctx, userId: number, reason: string): Promise<void> {
  await sequelize.transaction(async tx => {
    await lockSuperAdmins(tx);
    const u = await loadPlatformUser(userId, tx);
    assertNotSelf(ctx, userId);
    await assertOtherSuperAdmin(userId, tx);
    const before = await roleKeyOf(u.platformRoleId, tx);
    await users.setPlatformRole(tx, userId, null);
    await audit(
      ctx,
      {
        action: AUDIT.platformMemberRemoved,
        entityType: 'user',
        entityId: userId,
        societyId: null,
        before: { roleKey: before },
        reason,
      },
      tx,
    );
    afterCommit(tx, () =>
      emitToUser(userId, 'access.changed', { societyId: null, reason: 'PLATFORM_ROLE_CHANGED' }),
    );
  });
}
