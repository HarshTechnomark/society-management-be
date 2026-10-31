import { Op } from 'sequelize';
import { MemberGrant, Permission, Role, RolePermission, Society, SocietyMember, User } from '../../models';
import type { RoleScope } from '../../models/role.model';
import { nowMs } from '../../lib/clock';
import { accessPorts } from './access-control.ports';
import { cached, keys, TTL } from './access-control.cache';
import { keysOfScope } from './access-control.permissions';
import type {
  AccessSnapshot,
  ActiveSupportGrant,
  Relation,
  SocietyInfo,
  SupportGrantScope,
  UnitLink,
} from './access-control.types';

// ------------------------------------------------------------------ role permission sets
/** Sorted permission keys of a role (cached `acl:role:<id>`, 300 s). */
export async function getRoleKeys(roleId: number): Promise<string[]> {
  return (
    (await cached<string[]>(keys.role(roleId), TTL.role, async () => {
      const rows = await RolePermission.findAll({
        where: { roleId },
        include: [{ model: Permission, attributes: ['key'], required: true }],
      });
      return rows.map(r => (r as any).Permission.key as string).sort();
    })) ?? []
  );
}

/** Platform role keys (cached `acl:platform-role:<id>`). */
export async function getPlatformRoleKeys(roleId: number): Promise<string[]> {
  return (
    (await cached<string[]>(keys.platformRole(roleId), TTL.role, async () => {
      const rows = await RolePermission.findAll({
        where: { roleId },
        include: [{ model: Permission, attributes: ['key'], required: true }],
      });
      return rows.map(r => (r as any).Permission.key as string).sort();
    })) ?? []
  );
}

export async function getPlatformPermissionsOf(userId: number): Promise<string[]> {
  const u = await User.findByPk(userId, { attributes: ['id', 'platformRoleId'] });
  return u?.platformRoleId ? getPlatformRoleKeys(u.platformRoleId) : [];
}

// ------------------------------------------------------------------ society info
export async function getSocietyInfo(societyId: number): Promise<SocietyInfo | null> {
  return cached<SocietyInfo>(keys.society(societyId), TTL.society, async () => {
    const s = await Society.findByPk(societyId);
    if (!s) return null;
    return {
      id: s.id!,
      name: s.name,
      status: s.status,
      timezone: s.timezone,
      planKey: await accessPorts().entitlements.planKeyFor(s.id!),
    };
  });
}

// ------------------------------------------------------------------ member access
interface MemberRaw {
  memberId: number;
  roleId: number;
  roleKey: string;
  roleScope: RoleScope;
  status: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  requiresMfa: boolean;
  unitLinks: UnitLink[];
  /** relation to the society's system resident role id */
  residentRoleIds: Partial<Record<Relation, number>>;
  grants: { key: string; effect: 'ALLOW' | 'DENY'; startsAt: string; endsAt: string | null }[];
}

async function loadMemberRaw(societyId: number, userId: number): Promise<MemberRaw | null> {
  const m = await SocietyMember.findOne({
    where: { societyId, userId },
    include: [{ model: Role, required: true, paranoid: false }],
  });
  if (!m) return null;
  const role = (m as any).Role as Role;
  const raw: MemberRaw = {
    memberId: m.id!,
    roleId: role.id!,
    roleKey: role.key,
    roleScope: role.scope,
    status: m.status,
    requiresMfa: role.requiresMfa,
    unitLinks: [],
    residentRoleIds: {},
    grants: [],
  };
  if (m.status !== 'ACTIVE') return raw;
  raw.unitLinks = await accessPorts().residents.getActiveUnitLinks(societyId, userId);
  if (raw.unitLinks.length) {
    const roles = await Role.findAll({
      where: { societyId, key: { [Op.in]: ['owner', 'tenant', 'family_member'] }, isSystem: true },
      attributes: ['id', 'key'],
    });
    const byKey = new Map(roles.map(r => [r.key, r.id!]));
    for (const [rel, key] of [
      ['OWNER', 'owner'],
      ['TENANT', 'tenant'],
      ['FAMILY', 'family_member'],
    ] as const) {
      const id = byKey.get(key);
      if (id) raw.residentRoleIds[rel] = id;
    }
  }
  const grants = await MemberGrant.findAll({
    where: { memberId: m.id!, status: 'ACTIVE' },
    include: [{ model: Permission, attributes: ['key'], required: true }],
  });
  raw.grants = grants.map(g => ({
    key: (g as any).Permission.key as string,
    effect: g.effect,
    startsAt: g.startsAt.toISOString(),
    endsAt: g.endsAt ? g.endsAt.toISOString() : null,
  }));
  return raw;
}

/**
 * Effective permissions of a member (BR-03-4, cached `acl:member:<societyId>:<userId>`):
 * `(role ∪ resident-from-unit-links ∪ active ALLOW grants) − active DENY grants`. Grant windows are checked against the clock on
 * every call (BR-03-21), so an expired grant stops working at `endsAt` even if the cache or the expiry job is late.
 */
export async function computeAccess(societyId: number, userId: number): Promise<AccessSnapshot> {
  const raw = await cached<MemberRaw>(keys.member(societyId, userId), TTL.member, () =>
    loadMemberRaw(societyId, userId),
  );
  if (!raw)
    return {
      memberId: null,
      roleId: null,
      roleKey: null,
      roleScope: null,
      status: 'NONE',
      permissions: [],
      unitLinks: [],
      requiresMfa: false,
    };
  const snap: AccessSnapshot = {
    memberId: raw.memberId,
    roleId: raw.roleId,
    roleKey: raw.roleKey,
    roleScope: raw.roleScope,
    status: raw.status,
    permissions: [],
    unitLinks: raw.unitLinks,
    requiresMfa: raw.requiresMfa,
  };
  if (raw.status !== 'ACTIVE') return snap;
  const set = new Set(await getRoleKeys(raw.roleId));
  for (const relation of new Set(raw.unitLinks.map(l => l.relation))) {
    const id = raw.residentRoleIds[relation];
    if (id) for (const k of await getRoleKeys(id)) set.add(k);
  }
  const t = nowMs();
  const active = raw.grants.filter(
    g => new Date(g.startsAt).getTime() <= t && (g.endsAt === null || t < new Date(g.endsAt).getTime()),
  );
  for (const g of active) if (g.effect === 'ALLOW') set.add(g.key);
  for (const g of active) if (g.effect === 'DENY') set.delete(g.key);
  snap.permissions = [...set].sort();
  return snap;
}

// ------------------------------------------------------------------ support access (BR-03-19)
const SUPPORT_WRITE_STRIP = (k: string): boolean => {
  const action = k.slice(k.lastIndexOf('.') + 1);
  if (['approve', 'export', 'import'].includes(action)) return true;
  if (k.startsWith('settings.roles.') && action !== 'view') return true;
  if (['settings.members.create', 'settings.members.edit', 'settings.members.delete'].includes(k))
    return true;
  return k === 'settings.subscription.edit';
};

export async function supportPermissions(societyId: number, scope: SupportGrantScope): Promise<string[]> {
  if (scope === 'READ_ONLY')
    return keysOfScope('society')
      .filter(k => k.endsWith('.view') && k !== 'residents.contacts.view')
      .sort();
  const admin = await Role.findOne({ where: { societyId, key: 'society_admin' }, attributes: ['id'] });
  if (!admin) return [];
  return (await getRoleKeys(admin.id!)).filter(k => !SUPPORT_WRITE_STRIP(k));
}

export type { ActiveSupportGrant };

// ------------------------------------------------------------------ port for module 02
/** Effective society keys for `authAccess.getPermissions`. ACTIVE members only. */
export async function permissionsOf(userId: number, societyId: number): Promise<string[]> {
  return (await computeAccess(societyId, userId)).permissions;
}
