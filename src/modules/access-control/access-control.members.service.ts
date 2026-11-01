import { Op, fn, col, where as sqlWhere, type Order, type Transaction, type WhereOptions } from 'sequelize';
import { Invitation, MemberGrant, Role, Society, SocietyMember, User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { leaveSocietyRooms } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { auth, sessions, users } from '../auth/auth.public';
import { invalidateMemberKey } from './access-control.cache';
import { computeAccess, getRoleKeys } from './access-control.access';
import { accessPorts } from './access-control.ports';
import { assertGovernable, lockChairmen } from './access-control.guards';
import { assertCanGrant, assertNotSelf, hasPermission } from './access-control.policies';
import { AUDIT } from './access-control.permissions';
import { grantViews, revokeAllGrants } from './access-control.grants.service';
import { revokeForMfaPolicy } from './access-control.roles.service';
import { revokeInvitationRow } from './access-control.invitation-rows';
import {
  emailMask,
  emitAccessChanged,
  invalidState,
  loadRole,
  memberNotFound,
  mobileMask,
  notifyAfterCommit,
  roleKeysTx,
  roleNotFound,
} from './access-control.util';
import type { Relation } from './access-control.types';

type MemberWithRole = SocietyMember & { Role: Role };
type MemberFull = MemberWithRole & { User: User };

// ------------------------------------------------------------------ loading and seats
async function lockMember(memberId: number, tx: Transaction, societyId?: number): Promise<MemberWithRole> {
  const m = await SocietyMember.findOne({
    where: { id: memberId, ...(societyId ? { societyId } : {}) },
    transaction: tx,
    lock: { level: tx.LOCK.UPDATE, of: SocietyMember },
    include: [{ model: Role, required: true, paranoid: false }],
  });
  if (!m) throw memberNotFound();
  return m as MemberWithRole;
}

const holdsSeat = (status: string, role: Pick<Role, 'consumesSeat'>): boolean =>
  (status === 'ACTIVE' || status === 'SUSPENDED') && role.consumesSeat;

/** BR-03-33: consume or release one admin seat when a member starts or stops holding one. */
async function moveSeat(
  ctx: Ctx,
  societyId: number,
  from: boolean,
  to: boolean,
  tx: Transaction,
): Promise<void> {
  if (!from && to)
    await accessPorts().entitlements.consumeLimit(ctx, 'limit.admin_seats', 1, {
      transaction: tx,
      societyId,
    });
  if (from && !to)
    await accessPorts().entitlements.releaseLimit(ctx, 'limit.admin_seats', 1, {
      transaction: tx,
      societyId,
    });
}

// ------------------------------------------------------------------ views
export interface MemberRow {
  id: number;
  userId: number;
  name: string;
  mobile: string | null;
  email: string | null;
  role: { id: number; key: string; name: string; scope: string };
  status: string;
  locationLabel: string | null;
  mfaEnabled: boolean;
  requiresMfa: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
  activeGrantCount: number;
  isSelf: boolean;
  version: number;
}

async function activeGrantCounts(memberIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!memberIds.length) return out;
  const t = now();
  const rows = (await MemberGrant.count({
    where: {
      memberId: { [Op.in]: memberIds },
      status: 'ACTIVE',
      startsAt: { [Op.lte]: t },
      [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: t } }],
    },
    group: ['memberId'],
  })) as unknown as { memberId: number; count: number }[];
  for (const r of rows) out.set(Number(r.memberId), Number(r.count));
  return out;
}

export interface MaskOptions {
  revealContacts: boolean;
  /** Platform lists: mobile and email always masked. */
  maskEmail?: boolean;
  alwaysMask?: boolean;
}

function toRow(
  m: MemberFull,
  selfId: number | null,
  counts: Map<number, number>,
  mask: MaskOptions,
): MemberRow {
  const reveal = !mask.alwaysMask && (mask.revealContacts || m.userId === selfId);
  return {
    id: m.id!,
    userId: m.userId,
    name: m.User.name ?? '',
    mobile: reveal ? m.User.mobile : mobileMask(m.User.mobile),
    email: mask.maskEmail ? emailMask(m.User.email) : m.User.email,
    role: { id: m.Role.id!, key: m.Role.key, name: m.Role.name, scope: m.Role.scope },
    status: m.status,
    locationLabel: m.locationLabel,
    mfaEnabled: m.User.mfaEnabledAt !== null,
    requiresMfa: m.Role.requiresMfa,
    lastLoginAt: m.User.lastLoginAt ? m.User.lastLoginAt.toISOString() : null,
    joinedAt: m.joinedAt.toISOString(),
    activeGrantCount: counts.get(m.id!) ?? 0,
    isSelf: m.userId === selfId,
    version: m.version,
  };
}

export interface MemberListQuery {
  status?: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  roleId?: number;
  scope?: 'society' | 'resident' | 'gate' | 'work';
  search?: string;
  sortBy: 'name' | 'joinedAt' | 'lastLoginAt' | 'role';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

function listParts(societyId: number, q: Omit<MemberListQuery, 'page' | 'limit'>) {
  const where: WhereOptions[] = [{ societyId }, { status: q.status ?? { [Op.ne]: 'ENDED' } }];
  if (q.roleId) where.push({ roleId: q.roleId });
  if (q.search) {
    const like = `%${q.search.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    const or: WhereOptions[] = [{ '$User.name$': { [Op.like]: like } }];
    if (/^\d{4}$/.test(q.search)) or.push(sqlWhere(fn('RIGHT', col('User.mobile'), 4), q.search));
    where.push({ [Op.or]: or });
  }
  const dir = q.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const order: Order =
    q.sortBy === 'joinedAt'
      ? [['joinedAt', dir]]
      : q.sortBy === 'lastLoginAt'
        ? [[{ model: User, as: 'User' } as never, 'lastLoginAt', dir]]
        : q.sortBy === 'role'
          ? [[{ model: Role, as: 'Role' } as never, 'name', dir]]
          : [[{ model: User, as: 'User' } as never, 'name', dir]];
  order.push(['id', 'ASC']);
  const include = [
    {
      model: User,
      attributes: ['id', 'name', 'mobile', 'email', 'lastLoginAt', 'mfaEnabledAt'],
      required: true,
    },
    {
      model: Role,
      required: true,
      paranoid: false,
      ...(q.scope ? { where: { scope: q.scope } } : {}),
    },
  ];
  return { where: { [Op.and]: where } as WhereOptions, order, include };
}

export async function listMembers(
  societyId: number,
  query: MemberListQuery,
  selfId: number | null,
  mask: MaskOptions,
) {
  const p = listParts(societyId, query);
  const total = await SocietyMember.count({ where: p.where, include: p.include as never, distinct: true });
  const rows = (await SocietyMember.findAll({
    where: p.where,
    include: p.include as never,
    order: p.order,
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
    subQuery: false,
  })) as MemberFull[];
  const counts = await activeGrantCounts(rows.map(r => r.id!));
  return {
    data: rows.map(r => toRow(r, selfId, counts, mask)),
    pagination: pageMeta(query.page, query.limit, total),
  };
}

export async function loadMemberFull(societyId: number, memberId: number): Promise<MemberFull> {
  const m = (await SocietyMember.findOne({
    where: { id: memberId, societyId },
    include: [
      {
        model: User,
        attributes: ['id', 'name', 'mobile', 'email', 'lastLoginAt', 'mfaEnabledAt'],
        required: true,
      },
      { model: Role, required: true, paranoid: false },
    ],
  })) as MemberFull | null;
  if (!m) throw memberNotFound();
  return m;
}

export async function memberDetail(
  societyId: number,
  memberId: number,
  selfId: number | null,
  mask: MaskOptions,
) {
  const m = await loadMemberFull(societyId, memberId);
  const counts = await activeGrantCounts([m.id!]);
  const row = toRow(m, selfId, counts, mask);
  const links = await accessPorts().residents.getActiveUnitLinks(societyId, m.userId);
  const labels = await accessPorts().residents.getUnitLabels(
    societyId,
    links.map(l => l.unitId),
  );
  let invitation: { id: number; invitedByName: string; respondedAt: string | null } | null = null;
  if (m.invitationId) {
    const inv = await Invitation.findByPk(m.invitationId);
    if (inv) {
      const inviter = inv.invitedBy ? await User.findByPk(inv.invitedBy, { attributes: ['name'] }) : null;
      invitation = {
        id: inv.id!,
        invitedByName: inviter?.name ?? 'SocietyApp',
        respondedAt: inv.respondedAt ? inv.respondedAt.toISOString() : null,
      };
    }
  }
  const access = await computeAccess(societyId, m.userId);
  return {
    ...row,
    unitLinks: links.map(l => ({
      unitId: l.unitId,
      unitLabel: labels[l.unitId] ?? `Unit ${l.unitId}`,
      relation: l.relation,
    })),
    effectivePermissionCount: access.permissions.length,
    grants: await grantViews(m.id!, 'ALL'),
    invitation,
    suspendReason: m.suspendReason,
    suspendedAt: m.suspendedAt ? m.suspendedAt.toISOString() : null,
    endReason: m.endReason,
    endedAt: m.endedAt ? m.endedAt.toISOString() : null,
  };
}

// ------------------------------------------------------------------ export (8.8)
const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const EXPORT_MAX_ROWS = 10_000;

export async function exportMembers(ctx: Ctx, query: Omit<MemberListQuery, 'page' | 'limit'>) {
  const societyId = ctx.society!.id;
  const p = listParts(societyId, query);
  const total = await SocietyMember.count({ where: p.where, include: p.include as never, distinct: true });
  if (total > EXPORT_MAX_ROWS)
    throw new UnprocessableError('EXPORT_TOO_LARGE', 'Too many rows to export. Narrow the filters.');
  const rows = (await SocietyMember.findAll({
    where: p.where,
    include: p.include as never,
    order: p.order,
    subQuery: false,
  })) as MemberFull[];
  const mask: MaskOptions = { revealContacts: hasPermission(ctx, 'residents.contacts.view') };
  const header = [
    'Name',
    'Mobile',
    'Email',
    'Role',
    'Status',
    'Flat or office',
    'MFA',
    'Joined',
    'Last sign in',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const m of rows) {
    const r = toRow(m, ctx.user?.id ?? null, new Map(), mask);
    lines.push(
      [
        r.name,
        r.mobile,
        r.email,
        r.role.name,
        r.status,
        r.locationLabel,
        r.mfaEnabled ? 'On' : 'Not yet',
        r.joinedAt,
        r.lastLoginAt,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const file = await accessPorts().files.storeExport(ctx, {
    name: `members-${now().toISOString().slice(0, 10)}.csv`,
    contentType: 'text/csv',
    content: `${lines.join('\r\n')}\r\n`,
  });
  await audit(ctx, {
    action: AUDIT.memberExported,
    entityType: 'society',
    entityId: societyId,
    societyId,
    after: { filter: query, rowCount: rows.length },
  });
  return {
    fileId: file.fileId,
    downloadUrl: file.downloadUrl,
    expiresAt: file.expiresAt.toISOString(),
    rowCount: rows.length,
  };
}

// ------------------------------------------------------------------ role change (BR-03-34)
export interface ChangeOpts {
  via?: 'committee';
}

interface ChangeRoleArgs {
  societyId?: number;
  memberId: number;
  newRole: Role;
  reason: string;
  version?: number;
  locationLabel?: string | null | undefined;
}

async function changeRoleCore(
  ctx: Ctx,
  a: ChangeRoleArgs,
  tx: Transaction,
  opts: ChangeOpts = {},
): Promise<MemberWithRole> {
  const committee = opts.via === 'committee';
  const m = await lockMemberWithGuards(a.memberId, tx, a.societyId);
  const oldRole = m.Role;
  const { newRole } = a;
  if (m.status === 'ENDED') throw invalidState('This membership has ended');
  if (a.version !== undefined && m.version !== a.version)
    throw new AppError(409, 'STALE_VERSION', 'This member changed elsewhere. Reload and try again.');
  if (!committee) assertNotSelf(ctx, m.userId);
  if (newRole.societyId !== m.societyId) throw roleNotFound();
  if (!committee) {
    if (newRole.scope === 'resident' || newRole.scope === 'platform' || oldRole.scope === 'resident')
      throw new UnprocessableError('ROLE_SCOPE_NOT_ALLOWED', 'This role cannot be assigned here');
  }
  if (newRole.id === oldRole.id)
    throw new ValidationError([{ field: 'roleId', message: 'Pick a different role' }]);
  const newKeys = await roleKeysTx(newRole.id!, tx);
  if (!committee && newRole.scope === 'society') assertCanGrant(ctx, newKeys);

  await moveSeat(ctx, m.societyId, holdsSeat(m.status, oldRole), holdsSeat(m.status, newRole), tx);
  const beforeKey = oldRole.key;
  m.roleId = newRole.id!;
  m.version += 1;
  m.updatedBy = ctx.user?.id ?? null;
  await m.save({ transaction: tx });
  m.Role = newRole;
  // admin grants of another scope no longer fit
  await revokeAllGrants(ctx, m, 'ROLE_CHANGED', tx, g => (g as any).Permission.scope !== newRole.scope);

  if (m.status === 'ACTIVE') {
    const oldKeys = await roleKeysTx(oldRole.id!, tx);
    await assertGovernable(m.societyId, tx, {
      leavingChairman: oldRole.key === 'chairman' && newRole.key !== 'chairman',
      wasRoleManager: oldKeys.includes('settings.roles.edit') && !newKeys.includes('settings.roles.edit'),
    });
    if (newRole.requiresMfa) await revokeForMfaPolicy(ctx, [m.userId], tx);
  }
  await audit(
    ctx,
    {
      action: AUDIT.memberRoleChanged,
      entityType: 'society_member',
      entityId: m.id!,
      societyId: m.societyId,
      before: { roleKey: beforeKey },
      after: { roleKey: newRole.key },
      reason: a.reason,
    },
    tx,
  );
  invalidateMemberKey(tx, m.societyId, m.userId);
  notifyAfterCommit(tx, 'access.role_changed', [{ userId: m.userId }], { roleName: newRole.name });
  emitAccessChanged(tx, m.societyId, [m.userId], 'ROLE_CHANGED');
  return m;
}

/** Locks the chairman rows first (BR-03-8) and then the member, so parallel demotions are serialised. */
async function lockMemberWithGuards(
  memberId: number,
  tx: Transaction,
  societyId?: number,
): Promise<MemberWithRole> {
  const probe = await SocietyMember.findOne({
    where: { id: memberId, ...(societyId ? { societyId } : {}) },
    attributes: ['id', 'societyId'],
    transaction: tx,
  });
  if (!probe) throw memberNotFound();
  await lockChairmen(probe.societyId, tx);
  return lockMember(memberId, tx, societyId);
}

/** `PATCH /members/:id` (8.11): role and/or location label. */
export async function patchMember(
  ctx: Ctx,
  memberId: number,
  input: { version: number; roleId?: number; locationLabel?: string | null; reason?: string },
) {
  const societyId = ctx.society!.id;
  await sequelize.transaction(async tx => {
    if (input.roleId !== undefined) {
      const role = await loadRole(societyId, input.roleId, tx);
      await changeRoleCore(
        ctx,
        { societyId, memberId, newRole: role, reason: input.reason!, version: input.version },
        tx,
      );
      if (input.locationLabel !== undefined) {
        const m = await lockMember(memberId, tx, societyId);
        m.locationLabel = input.locationLabel;
        await m.save({ transaction: tx });
      }
      return;
    }
    const m = await lockMember(memberId, tx, societyId);
    if (m.status === 'ENDED') throw invalidState('This membership has ended');
    if (m.version !== input.version)
      throw new AppError(409, 'STALE_VERSION', 'This member changed elsewhere. Reload and try again.');
    const before = { locationLabel: m.locationLabel };
    if (input.locationLabel !== undefined && input.locationLabel !== m.locationLabel) {
      m.locationLabel = input.locationLabel;
      m.version += 1;
      m.updatedBy = ctx.user?.id ?? null;
      await m.save({ transaction: tx });
      await audit(
        ctx,
        {
          action: AUDIT.memberUpdated,
          entityType: 'society_member',
          entityId: m.id!,
          societyId,
          before,
          after: { locationLabel: m.locationLabel },
        },
        tx,
      );
      emitAccessChanged(tx, societyId, [], 'ROLE_CHANGED');
    }
  });
  return memberDetail(societyId, memberId, ctx.user?.id ?? null, {
    revealContacts: hasPermission(ctx, 'residents.contacts.view'),
  });
}

/** Service API for module 10 and others: `changeRole(ctx, memberId, roleKey, reason, t, opts?)`. */
export async function changeRole(
  ctx: Ctx,
  memberId: number,
  roleKey: string,
  reason: string,
  t: Transaction,
  opts: ChangeOpts = {},
): Promise<void> {
  const probe = await SocietyMember.findByPk(memberId, { transaction: t });
  if (!probe) throw memberNotFound();
  const role = await Role.findOne({ where: { societyId: probe.societyId, key: roleKey }, transaction: t });
  if (!role) throw roleNotFound();
  await changeRoleCore(ctx, { memberId, newRole: role, reason }, t, opts);
}

// ------------------------------------------------------------------ suspend, reactivate, end
async function notifyAndRelease(
  tx: Transaction,
  societyId: number,
  userId: number,
  reason: 'SUSPENDED' | 'ENDED',
) {
  emitAccessChanged(tx, societyId, [userId], reason);
  tx.afterCommit(() => leaveSocietyRooms(userId, societyId));
}

export async function suspendMember(
  ctx: Ctx,
  memberId: number,
  input: { version: number; reason: string },
): Promise<void> {
  const societyId = ctx.society!.id;
  await sequelize.transaction(async tx => {
    const m = await lockMemberWithGuards(memberId, tx, societyId);
    assertNotSelf(ctx, m.userId);
    if (m.status !== 'ACTIVE') throw invalidState('Only active members can be suspended');
    if (m.version !== input.version)
      throw new AppError(409, 'STALE_VERSION', 'This member changed elsewhere. Reload and try again.');
    const keys = await roleKeysTx(m.roleId, tx);
    m.status = 'SUSPENDED';
    m.suspendedAt = now();
    m.suspendedBy = ctx.user!.id;
    m.suspendReason = input.reason;
    m.version += 1;
    m.updatedBy = ctx.user!.id;
    await m.save({ transaction: tx });
    await assertGovernable(societyId, tx, {
      leavingChairman: m.Role.key === 'chairman',
      wasRoleManager: keys.includes('settings.roles.edit'),
    });
    await audit(
      ctx,
      {
        action: AUDIT.memberSuspended,
        entityType: 'society_member',
        entityId: m.id!,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'SUSPENDED' },
        reason: input.reason,
      },
      tx,
    );
    invalidateMemberKey(tx, societyId, m.userId);
    notifyAfterCommit(tx, 'access.membership_suspended', [{ userId: m.userId }], {
      societyName: ctx.society!.name,
    });
    await notifyAndRelease(tx, societyId, m.userId, 'SUSPENDED');
  });
}

export async function reactivateMember(
  ctx: Ctx,
  memberId: number,
  input: { version: number; reason: string },
): Promise<void> {
  const societyId = ctx.society!.id;
  await sequelize.transaction(async tx => {
    const m = await lockMember(memberId, tx, societyId);
    assertNotSelf(ctx, m.userId);
    if (m.status !== 'SUSPENDED') throw invalidState('Only suspended members can be reactivated');
    if (m.version !== input.version)
      throw new AppError(409, 'STALE_VERSION', 'This member changed elsewhere. Reload and try again.');
    if (m.Role.deletedAt) throw roleNotFound();
    m.status = 'ACTIVE';
    m.suspendedAt = null;
    m.suspendedBy = null;
    m.suspendReason = null;
    m.version += 1;
    m.updatedBy = ctx.user!.id;
    await m.save({ transaction: tx });
    await audit(
      ctx,
      {
        action: AUDIT.memberReactivated,
        entityType: 'society_member',
        entityId: m.id!,
        societyId,
        before: { status: 'SUSPENDED' },
        after: { status: 'ACTIVE' },
        reason: input.reason,
      },
      tx,
    );
    invalidateMemberKey(tx, societyId, m.userId);
    notifyAfterCommit(tx, 'access.membership_reactivated', [{ userId: m.userId }], {
      societyName: ctx.society!.name,
    });
    emitAccessChanged(tx, societyId, [m.userId], 'REACTIVATED');
  });
}

interface EndOptions {
  skipGuard?: boolean;
  notify?: boolean;
  endedBy?: number | null;
}

/** Ends a membership inside `tx` (every path that ends a member goes through here, section 6.2). */
async function endCore(
  ctx: Ctx,
  m: MemberWithRole,
  reason: string,
  tx: Transaction,
  o: EndOptions = {},
): Promise<void> {
  const wasActive = m.status === 'ACTIVE';
  const keys = wasActive ? await roleKeysTx(m.roleId, tx) : [];
  await moveSeat(ctx, m.societyId, holdsSeat(m.status, m.Role), false, tx);
  const before = { status: m.status };
  m.status = 'ENDED';
  m.endedAt = now();
  m.endedBy = o.endedBy === undefined ? (ctx.user?.id ?? null) : o.endedBy;
  m.endReason = reason.slice(0, 500);
  m.version += 1;
  m.updatedBy = ctx.user?.id ?? null;
  await m.save({ transaction: tx });
  await revokeAllGrants(ctx, m, 'MEMBERSHIP_ENDED', tx);
  if (!o.skipGuard && wasActive)
    await assertGovernable(m.societyId, tx, {
      leavingChairman: m.Role.key === 'chairman',
      wasRoleManager: keys.includes('settings.roles.edit'),
    });
  await accessPorts().approvals.onMemberEnded(ctx, m.societyId, m.userId, tx);
  await audit(
    ctx,
    {
      action: AUDIT.memberEnded,
      entityType: 'society_member',
      entityId: m.id!,
      societyId: m.societyId,
      before,
      after: { status: 'ENDED' },
      reason,
    },
    tx,
  );
  invalidateMemberKey(tx, m.societyId, m.userId);
  if (o.notify)
    notifyAfterCommit(tx, 'access.membership_ended', [{ userId: m.userId }], {
      societyName: ctx.society?.name,
    });
  await notifyAndRelease(tx, m.societyId, m.userId, 'ENDED');
}

/** `DELETE /members/:id` (8.12). */
export async function endMemberRoute(
  ctx: Ctx,
  memberId: number,
  input: { version: number; reason: string },
): Promise<void> {
  const societyId = ctx.society!.id;
  await sequelize.transaction(async tx => {
    const m = await lockMemberWithGuards(memberId, tx, societyId);
    assertNotSelf(ctx, m.userId);
    if (m.status === 'ENDED') throw invalidState('This membership has already ended');
    if (m.version !== input.version)
      throw new AppError(409, 'STALE_VERSION', 'This member changed elsewhere. Reload and try again.');
    await endCore(ctx, m, input.reason, tx, { notify: true });
  });
}

/** Service API: `endMember(ctx, memberId, reason, t, opts?)`; with `via: 'committee'` it skips not-self (BR-03-34). */
export async function endMember(
  ctx: Ctx,
  memberId: number,
  reason: string,
  t: Transaction,
  opts: ChangeOpts = {},
): Promise<void> {
  const m = await lockMemberWithGuards(memberId, t);
  if (opts.via !== 'committee') assertNotSelf(ctx, m.userId);
  if (m.status === 'ENDED') throw invalidState('This membership has already ended');
  await endCore(ctx, m, reason, t, { notify: true });
}

/** Module 09: the resident left; a member whose role is not a resident role keeps it. */
export async function endResidentMember(t: Transaction, memberId: number, reason: string): Promise<void> {
  const m = await lockMember(memberId, t);
  if (m.status === 'ENDED') return;
  if (m.Role.scope !== 'resident') {
    invalidateMemberKey(t, m.societyId, m.userId);
    return;
  }
  await endCore({ requestId: 'module-09', ip: '', userAgent: '' }, m, reason, t, {
    skipGuard: true,
    endedBy: null,
  });
}

/** Module 05 closure or purge (BR-03-8 skipped: the whole society is closing). */
export async function endAllMembersForSociety(
  ctx: Ctx,
  societyId: number,
  reason: string,
  t: Transaction,
): Promise<number> {
  const rows = await SocietyMember.findAll({
    where: { societyId, status: { [Op.ne]: 'ENDED' } },
    attributes: ['id'],
    order: [['id', 'ASC']],
    transaction: t,
  });
  for (const r of rows) {
    const m = await lockMember(r.id!, t);
    await endCore(ctx, m, reason, t, { skipGuard: true, endedBy: null });
  }
  return rows.length;
}

// ------------------------------------------------------------------ module 02 hooks
/** `authAccess.onUserAnonymised` (BR-03-31). Runs in module 02's transaction. */
export async function onUserAnonymised(userId: number, t: Transaction): Promise<void> {
  const ctx: Ctx = { requestId: 'anonymise', ip: '', userAgent: '' };
  const rows = await SocietyMember.findAll({
    where: { userId, status: { [Op.ne]: 'ENDED' } },
    attributes: ['id'],
    order: [['id', 'ASC']],
    transaction: t,
  });
  for (const r of rows) {
    const m = await lockMember(r.id!, t);
    await endCore(ctx, m, 'ACCOUNT_DELETED', t, { skipGuard: true, endedBy: null });
  }
  const pending = await Invitation.findAll({
    where: { invitedUserId: userId, status: 'PENDING' },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const inv of pending) {
    await revokeInvitationRow(ctx, inv, 'ACCOUNT_DELETED', t);
  }
}

/** `authAccess.deletionBlockers` (BR-03-31). */
export async function deletionBlockers(userId: number): Promise<string[]> {
  const out: string[] = [];
  const u = await User.findByPk(userId, { attributes: ['id', 'platformRoleId'] });
  if (u?.platformRoleId) out.push('PLATFORM_USER');
  const mine = await SocietyMember.findAll({
    where: { userId, status: 'ACTIVE' },
    include: [{ model: Role, required: true }],
  });
  for (const m of mine) {
    const role = (m as any).Role as Role;
    const society = await Society.findByPk(m.societyId, { attributes: ['name'] });
    if (['chairman', 'secretary', 'treasurer'].includes(role.key))
      out.push(`COMMITTEE_ROLE:${society?.name}`);
  }
  for (const m of mine) {
    const keys = await getRoleKeys(m.roleId);
    if (!keys.includes('settings.roles.edit')) continue;
    const chairmen = await SocietyMember.count({
      where: { societyId: m.societyId, status: 'ACTIVE' },
      include: [{ model: Role, where: { key: 'chairman' }, required: true }],
    });
    if (chairmen > 0) continue;
    let others = 0;
    const actives = await SocietyMember.findAll({
      where: { societyId: m.societyId, status: 'ACTIVE', userId: { [Op.ne]: userId } },
      attributes: ['roleId'],
    });
    for (const o of actives) if ((await getRoleKeys(o.roleId)).includes('settings.roles.edit')) others++;
    if (others === 0) {
      const society = await Society.findByPk(m.societyId, { attributes: ['name'] });
      out.push(`LAST_SOCIETY_ADMIN:${society?.name}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ module 05 and 09 service API
async function systemRole(societyId: number, key: string, tx: Transaction): Promise<Role> {
  const r = await Role.findOne({ where: { societyId, key, isSystem: true }, transaction: tx });
  if (!r) throw roleNotFound();
  return r;
}

async function createOrReviveMember(
  ctx: Ctx,
  input: {
    societyId: number;
    userId: number;
    role: Role;
    locationLabel?: string | null;
    invitationId?: number | null;
  },
  tx: Transaction,
): Promise<{ member: SocietyMember; revived: boolean }> {
  const existing = await SocietyMember.findOne({
    where: { societyId: input.societyId, userId: input.userId },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  const t = now();
  let member: SocietyMember;
  if (existing && existing.status !== 'ENDED')
    throw new AppError(409, 'ALREADY_MEMBER', 'This person is already a member');
  await moveSeat(ctx, input.societyId, false, holdsSeat('ACTIVE', input.role), tx);
  if (existing) {
    existing.roleId = input.role.id!;
    existing.status = 'ACTIVE';
    existing.joinedAt = t;
    existing.endedAt = null;
    existing.endedBy = null;
    existing.endReason = null;
    existing.suspendedAt = null;
    existing.suspendedBy = null;
    existing.suspendReason = null;
    existing.locationLabel = input.locationLabel ?? existing.locationLabel;
    existing.invitationId = input.invitationId ?? null;
    existing.version += 1;
    existing.updatedBy = ctx.user?.id ?? null;
    await existing.save({ transaction: tx });
    member = existing;
  } else {
    member = await SocietyMember.create(
      {
        societyId: input.societyId,
        userId: input.userId,
        roleId: input.role.id!,
        status: 'ACTIVE',
        locationLabel: input.locationLabel ?? null,
        joinedAt: t,
        suspendedAt: null,
        suspendedBy: null,
        suspendReason: null,
        endedAt: null,
        endedBy: null,
        endReason: null,
        invitationId: input.invitationId ?? null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: tx },
    );
  }
  invalidateMemberKey(tx, input.societyId, input.userId);
  return { member, revived: Boolean(existing) };
}

/** Joins a member (accept, initial member, resident member): shared with the invitation service. */
export const joinMember = createOrReviveMember;

export async function createInitialMember(
  ctx: Ctx,
  input: { societyId: number; userId: number; roleKey: 'chairman' | 'society_admin' },
  t: Transaction,
): Promise<SocietyMember> {
  if (!['chairman', 'society_admin'].includes(input.roleKey))
    throw new UnprocessableError(
      'ROLE_SCOPE_NOT_ALLOWED',
      'The first member is a chairman or a society admin',
    );
  const role = await systemRole(input.societyId, input.roleKey, t);
  const { member } = await createOrReviveMember(
    ctx,
    { societyId: input.societyId, userId: input.userId, role },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.memberJoined,
      entityType: 'society_member',
      entityId: member.id!,
      societyId: input.societyId,
      after: { userId: input.userId, roleKey: role.key },
    },
    t,
  );
  emitAccessChanged(t, input.societyId, [input.userId], 'ROLE_CHANGED');
  return member;
}

const RESIDENT_ROLE: Record<Relation, string> = { OWNER: 'owner', TENANT: 'tenant', FAMILY: 'family_member' };

export async function ensureResidentMember(
  t: Transaction,
  societyId: number,
  userId: number,
  relation: Relation,
): Promise<SocietyMember> {
  const ctx: Ctx = { requestId: 'module-09', ip: '', userAgent: '' };
  const existing = await SocietyMember.findOne({ where: { societyId, userId }, transaction: t });
  if (existing && existing.status !== 'ENDED') return existing;
  const role = await systemRole(societyId, RESIDENT_ROLE[relation], t);
  const { member } = await createOrReviveMember(ctx, { societyId, userId, role }, t);
  await audit(
    ctx,
    {
      action: AUDIT.memberJoined,
      entityType: 'society_member',
      entityId: member.id!,
      societyId,
      after: { userId, roleKey: role.key },
      actor: { userId: null, name: 'Residents module', role: 'system' },
    },
    t,
  );
  return member;
}

/** BR-03-27: keeps a resident-scope member's role in step with the strongest unit relation. */
export async function setResidentRole(t: Transaction, memberId: number, relation: Relation): Promise<void> {
  const m = await lockMember(memberId, t);
  if (m.Role.scope !== 'resident' || m.status === 'ENDED') return;
  const role = await systemRole(m.societyId, RESIDENT_ROLE[relation], t);
  if (role.id === m.roleId) return;
  m.roleId = role.id!;
  m.version += 1;
  await m.save({ transaction: t });
  invalidateMemberKey(t, m.societyId, m.userId);
  emitAccessChanged(t, m.societyId, [m.userId], 'ROLE_CHANGED');
}

export async function listForSociety(
  societyId: number,
  f: {
    roleKeys?: string[];
    userIds?: number[];
    statuses?: ('ACTIVE' | 'SUSPENDED' | 'ENDED')[];
    roleScope?: string;
  } = {},
) {
  const rows = await SocietyMember.findAll({
    where: {
      societyId,
      status: { [Op.in]: f.statuses ?? ['ACTIVE', 'SUSPENDED'] },
      ...(f.userIds ? { userId: { [Op.in]: f.userIds } } : {}),
    },
    include: [
      {
        model: Role,
        required: true,
        paranoid: false,
        where: {
          ...(f.roleKeys ? { key: { [Op.in]: f.roleKeys } } : {}),
          ...(f.roleScope ? { scope: f.roleScope } : {}),
        },
      },
    ],
    order: [['id', 'ASC']],
  });
  return rows.map(m => ({
    memberId: m.id!,
    userId: m.userId,
    roleKey: (m as any).Role.key as string,
    roleScope: (m as any).Role.scope,
    status: m.status,
    consumesSeat: Boolean((m as any).Role.consumesSeat),
  }));
}

export async function roleKeysOf(societyId: number, roleKey: string): Promise<string[]> {
  const r = await Role.findOne({ where: { societyId, key: roleKey } });
  if (!r) throw roleNotFound();
  return getRoleKeys(r.id!);
}

/** Active members whose effective permissions include the key (recipients for modules 14 and 16). */
export async function usersWithPermission(societyId: number, key: string): Promise<number[]> {
  const rows = await SocietyMember.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['userId'],
  });
  const out: number[] = [];
  for (const r of rows)
    if ((await computeAccess(societyId, r.userId)).permissions.includes(key)) out.push(r.userId);
  return out;
}

// ------------------------------------------------------------------ reset MFA, revoke sessions (8.12a)
async function mfaTarget(ctx: Ctx, memberId: number, tx: Transaction, checkHold: boolean) {
  const societyId = ctx.society!.id;
  const m = await lockMember(memberId, tx, societyId);
  assertNotSelf(ctx, m.userId);
  if (m.status === 'ENDED') throw invalidState('This membership has ended');
  if (checkHold && m.Role.scope === 'society') assertCanGrant(ctx, await roleKeysTx(m.roleId, tx));
  return m;
}

export async function resetMemberMfa(ctx: Ctx, memberId: number, reason: string): Promise<void> {
  await sequelize.transaction(async tx => {
    const m = await mfaTarget(ctx, memberId, tx, true);
    const summary = await users.getUserSummary(m.userId, tx);
    if (!summary.mfaEnabled) throw invalidState('This person has no two-step sign-in to reset');
    await auth.resetMfa(ctx, m.userId, reason, tx);
    await audit(
      ctx,
      {
        action: AUDIT.memberMfaReset,
        entityType: 'society_member',
        entityId: m.id!,
        societyId: m.societyId,
        reason,
      },
      tx,
    );
  });
}

export async function revokeMemberSessions(
  ctx: Ctx,
  memberId: number,
  reason: string,
): Promise<{ revokedCount: number }> {
  return sequelize.transaction(async tx => {
    const m = await mfaTarget(ctx, memberId, tx, true);
    const revokedCount = await sessions.revokeUserSessions(ctx, m.userId, { reason: 'ADMIN_REVOKED' }, tx);
    await audit(
      ctx,
      {
        action: AUDIT.memberSessionsRevoked,
        entityType: 'society_member',
        entityId: m.id!,
        societyId: m.societyId,
        after: { revokedCount },
        reason,
      },
      tx,
    );
    return { revokedCount };
  });
}

/** Platform variant: no hold check; audit carries the target society and the platform role. */
export async function resetMemberMfaAsPlatform(
  ctx: Ctx,
  societyId: number,
  memberId: number,
  reason: string,
): Promise<void> {
  await sequelize.transaction(async tx => {
    const m = await lockMember(memberId, tx, societyId);
    if (m.status === 'ENDED') throw invalidState('This membership has ended');
    const summary = await users.getUserSummary(m.userId, tx);
    if (!summary.mfaEnabled) throw invalidState('This person has no two-step sign-in to reset');
    await auth.resetMfa(ctx, m.userId, reason, tx);
    await audit(
      ctx,
      {
        action: AUDIT.memberMfaReset,
        entityType: 'society_member',
        entityId: m.id!,
        societyId,
        reason,
      },
      tx,
    );
  });
}
