import type { Transaction } from 'sequelize';
import { MemberGrant, Permission, Role, SocietyMember, User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ForbiddenError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { computeAccess } from './access-control.access';
import { del, invalidateMemberKey, keys } from './access-control.cache';
import { accessPorts } from './access-control.ports';
import {
  AUDIT,
  HOUSEHOLD_ALLOW_KEYS,
  HOUSEHOLD_DENY_KEYS,
  HOUSEHOLD_LABELS,
} from './access-control.permissions';
import { emitAccessChanged, memberNotFound, notifyAfterCommit, permissionIdMap } from './access-control.util';

/** Household permissions (BR-03-16, 8.18): an owner or tenant sets what a family member may do. */
const OWNER_LIKE = new Set(['OWNER', 'TENANT']);

interface Control {
  member: SocietyMember & { Role: Role; User: User };
  unitIds: number[];
}

/** `getHouseholdControl(ctx, memberId)` (module 09 owns the data; this reads it through the unit-link port). */
async function householdControl(ctx: Ctx, memberId: number, tx?: Transaction): Promise<Control> {
  const societyId = ctx.society!.id;
  const m = (await SocietyMember.findOne({
    where: { id: memberId, societyId },
    include: [
      { model: Role, required: true, paranoid: false },
      { model: User, attributes: ['id', 'name'], required: true },
    ],
    transaction: tx,
    lock: tx ? { level: tx.LOCK.UPDATE, of: SocietyMember } : undefined,
  })) as (SocietyMember & { Role: Role; User: User }) | null;
  if (!m) throw memberNotFound();
  if (m.userId === ctx.user!.id)
    throw new ForbiddenError('SELF_CHANGE_NOT_ALLOWED', 'You cannot change your own permissions');
  const mine = new Set((ctx.unitLinks ?? []).filter(l => OWNER_LIKE.has(l.relation)).map(l => l.unitId));
  const links = await accessPorts().residents.getActiveUnitLinks(societyId, m.userId);
  const unitIds = links.filter(l => l.relation === 'FAMILY' && mine.has(l.unitId)).map(l => l.unitId);
  if (!unitIds.length) throw memberNotFound();
  return { member: m, unitIds };
}

export async function getHouseholdGrants(ctx: Ctx, memberId: number) {
  const { member, unitIds } = await householdControl(ctx, memberId);
  return view(ctx.society!.id, member, unitIds);
}

async function view(societyId: number, member: SocietyMember & { User: User }, unitIds: number[]) {
  const access = await computeAccess(societyId, member.userId);
  const has = new Set(access.permissions);
  const options = [
    ...HOUSEHOLD_ALLOW_KEYS.map(k => ({
      permissionKey: k,
      label: HOUSEHOLD_LABELS[k]!,
      kind: 'ALLOW' as const,
      enabled: has.has(k),
    })),
    ...HOUSEHOLD_DENY_KEYS.map(k => ({
      permissionKey: k,
      label: HOUSEHOLD_LABELS[k]!,
      kind: 'DENY' as const,
      enabled: has.has(k),
    })),
  ];
  return { memberId: member.id!, name: member.User.name ?? '', unitIds, options };
}

export async function setHouseholdGrants(
  ctx: Ctx,
  memberId: number,
  input: { unitId: number; allow: string[]; deny: string[] },
) {
  const societyId = ctx.society!.id;
  await sequelize.transaction(async tx => {
    const { member, unitIds } = await householdControl(ctx, memberId, tx);
    if (!unitIds.includes(input.unitId)) throw memberNotFound();
    if (member.Role.key !== 'family_member')
      throw new UnprocessableError('GRANT_NOT_ALLOWED', 'Only family members have household permissions');
    const allowOk = new Set<string>(HOUSEHOLD_ALLOW_KEYS);
    const denyOk = new Set<string>(HOUSEHOLD_DENY_KEYS);
    const bad = [...input.allow.filter(k => !allowOk.has(k)), ...input.deny.filter(k => !denyOk.has(k))];
    if (bad.length)
      throw new UnprocessableError(
        'GRANT_NOT_ALLOWED',
        'These permissions cannot be set for a family member',
        bad.map(k => ({ field: 'permissionKey', message: k })),
      );
    const want = new Map<string, 'ALLOW' | 'DENY'>([
      ...input.allow.map(k => [k, 'ALLOW'] as const),
      ...input.deny.map(k => [k, 'DENY'] as const),
    ]);
    const current = (await MemberGrant.findAll({
      where: { memberId: member.id!, source: 'HOUSEHOLD', unitId: input.unitId, status: 'ACTIVE' },
      include: [{ model: Permission, attributes: ['key'], required: true }],
      transaction: tx,
      lock: { level: tx.LOCK.UPDATE, of: MemberGrant },
    })) as (MemberGrant & { Permission: Permission })[];
    const t = now();
    const before = { allow: [] as string[], deny: [] as string[] };
    const kept = new Set<string>();
    for (const g of current) {
      const key = g.Permission.key;
      (g.effect === 'ALLOW' ? before.allow : before.deny).push(key);
      if (want.get(key) === g.effect) {
        kept.add(key);
        continue;
      }
      g.status = 'REVOKED';
      g.revokedAt = t;
      g.revokedBy = ctx.user!.id;
      g.revokeReason = 'HOUSEHOLD_UPDATED';
      await g.save({ transaction: tx });
    }
    const toAdd = [...want.entries()].filter(([k]) => !kept.has(k));
    const ids = await permissionIdMap(
      toAdd.map(([k]) => k),
      tx,
    );
    for (const [key, effect] of toAdd)
      await MemberGrant.create(
        {
          societyId,
          memberId: member.id!,
          permissionId: ids.get(key)!,
          effect,
          source: 'HOUSEHOLD',
          status: 'ACTIVE',
          startsAt: t,
          endsAt: null,
          reason: null,
          grantedBy: ctx.user!.id,
          expiryReminderSentAt: null,
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
          unitId: input.unitId,
          createdBy: ctx.user!.id,
          updatedBy: ctx.user!.id,
        },
        { transaction: tx },
      );
    await audit(
      ctx,
      {
        action: AUDIT.grantHouseholdUpdated,
        entityType: 'society_member',
        entityId: member.id!,
        societyId,
        before: { unitId: input.unitId, allow: before.allow.sort(), deny: before.deny.sort() },
        after: { unitId: input.unitId, allow: [...input.allow].sort(), deny: [...input.deny].sort() },
      },
      tx,
    );
    invalidateMemberKey(tx, societyId, member.userId);
    notifyAfterCommit(tx, 'access.household_permissions_changed', [{ userId: member.userId }], {
      ownerName: ctx.user!.name,
    });
    emitAccessChanged(tx, societyId, [member.userId], 'GRANT_CHANGED');
  });
  const { member, unitIds } = await householdControl(ctx, memberId);
  return view(societyId, member, unitIds);
}

// ------------------------------------------------------------------ module 09 hooks (BR-03-16)
/** Revokes the HOUSEHOLD grants given through one unit when the FAMILY link ends. Called by module 09 in its transaction. */
export async function revokeHouseholdGrants(
  t: Transaction,
  societyId: number,
  memberId: number,
  unitId: number,
): Promise<number> {
  const rows = await MemberGrant.findAll({
    where: { societyId, memberId, source: 'HOUSEHOLD', unitId, status: 'ACTIVE' },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const member = await SocietyMember.findByPk(memberId, { attributes: ['userId'], transaction: t });
  for (const g of rows) {
    g.status = 'REVOKED';
    g.revokedAt = now();
    g.revokeReason = 'UNIT_LINK_ENDED';
    await g.save({ transaction: t });
    await audit(
      { requestId: 'module-09', ip: '', userAgent: '' },
      {
        action: AUDIT.grantRevoked,
        entityType: 'member_grant',
        entityId: g.id!,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'REVOKED' },
        reason: 'UNIT_LINK_ENDED',
      },
      t,
    );
  }
  if (member) invalidateMemberKey(t, societyId, member.userId);
  return rows.length;
}

/**
 * Deletes the member cache and, as a safety net, revokes HOUSEHOLD grants whose unit no longer has an active FAMILY link
 * (in its own transaction). Module 09 calls it after unit link changes.
 */
export async function invalidateMember(societyId: number, userId: number): Promise<void> {
  const m = await SocietyMember.findOne({ where: { societyId, userId }, attributes: ['id'] });
  if (m) {
    const grants = await MemberGrant.findAll({
      where: { memberId: m.id!, source: 'HOUSEHOLD', status: 'ACTIVE' },
      attributes: ['unitId'],
    });
    if (grants.length) {
      const family = new Set(
        (await accessPorts().residents.getActiveUnitLinks(societyId, userId))
          .filter(l => l.relation === 'FAMILY')
          .map(l => l.unitId),
      );
      const ended = [...new Set(grants.map(g => g.unitId!))].filter(u => !family.has(u));
      for (const unitId of ended)
        await sequelize.transaction(async tx => {
          await revokeHouseholdGrants(tx, societyId, m.id!, unitId);
        });
    }
  }
  await del(keys.member(societyId, userId));
}
