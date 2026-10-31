import { Op, type Transaction } from 'sequelize';
import { MemberGrant, Permission, SocietyMember, User, sequelize } from '../../models';
import { addDays, addMinutes, now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { invalidateMemberKey } from './access-control.cache';
import { assertCanGrant, assertNotSelf } from './access-control.policies';
import { AUDIT, DEF_BY_KEY } from './access-control.permissions';
import { getRoleKeys } from './access-control.access';
import { emitAccessChanged, invalidState, memberNotFound, notifyAfterCommit } from './access-control.util';
import { Role } from '../../models';

export interface GrantView {
  id: number;
  permissionKey: string;
  label: string;
  effect: 'ALLOW' | 'DENY';
  source: 'ADMIN' | 'HOUSEHOLD';
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  isInEffect: boolean;
  startsAt: string;
  endsAt: string | null;
  reason: string | null;
  grantedByName: string | null;
}

export const grantInEffect = (g: Pick<MemberGrant, 'status' | 'startsAt' | 'endsAt'>, at = now()): boolean =>
  g.status === 'ACTIVE' && g.startsAt <= at && (g.endsAt === null || at < g.endsAt);

export async function grantViews(memberId: number, status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ALL' = 'ALL') {
  const rows = await MemberGrant.findAll({
    where: { memberId, ...(status === 'ALL' ? {} : { status }) },
    include: [{ model: Permission, attributes: ['key', 'label'], required: true }],
    order: [['id', 'DESC']],
    limit: 100,
  });
  const names = new Map(
    (
      await User.findAll({
        where: { id: { [Op.in]: [...new Set(rows.map(r => r.grantedBy))] } },
        attributes: ['id', 'name'],
      })
    ).map(u => [u.id!, u.name]),
  );
  const t = now();
  return rows.map((g): GrantView => ({
    id: g.id!,
    permissionKey: (g as any).Permission.key,
    label: (g as any).Permission.label,
    effect: g.effect,
    source: g.source,
    status: g.status,
    isInEffect: grantInEffect(g, t),
    startsAt: g.startsAt.toISOString(),
    endsAt: g.endsAt ? g.endsAt.toISOString() : null,
    reason: g.reason,
    grantedByName: names.get(g.grantedBy) ?? null,
  }));
}

async function loadMember(
  societyId: number,
  memberId: number,
  tx?: Transaction,
): Promise<SocietyMember & { Role: Role }> {
  const m = await SocietyMember.findOne({
    where: { id: memberId, societyId },
    include: [{ model: Role, required: true, paranoid: false }],
    transaction: tx,
    lock: tx ? tx.LOCK.UPDATE : undefined,
    ...(tx ? { subQuery: false } : {}),
  });
  if (!m) throw memberNotFound();
  return m as never;
}

export async function listGrants(
  societyId: number,
  memberId: number,
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ALL',
) {
  await loadMember(societyId, memberId);
  return grantViews(memberId, status);
}

export interface CreateGrantInput {
  permissionKey: string;
  startsAt?: Date;
  endsAt: Date;
  reason: string;
}

/** BR-03-15 admin grant. */
export async function createGrant(ctx: Ctx, memberId: number, input: CreateGrantInput): Promise<GrantView> {
  const societyId = ctx.society!.id;
  return sequelize.transaction(async tx => {
    const m = await loadMember(societyId, memberId, tx);
    assertNotSelf(ctx, m.userId);
    if (m.status !== 'ACTIVE') throw invalidState('Only active members can receive extra permissions');
    const def = DEF_BY_KEY.get(input.permissionKey);
    if (!def) throw new UnprocessableError('UNKNOWN_PERMISSION', 'This permission does not exist');
    const role = m.Role;
    if (def.scope !== role.scope)
      throw new UnprocessableError('GRANT_NOT_ALLOWED', 'This permission does not match the member role');
    if ((await getRoleKeys(role.id!)).includes(def.key))
      throw new UnprocessableError('GRANT_NOT_ALLOWED', 'The member role already includes this permission');
    if (role.scope === 'society') assertCanGrant(ctx, [def.key]);
    const t = now();
    const startsAt = input.startsAt ?? t;
    const windowErr = (message: string) =>
      new UnprocessableError('GRANT_WINDOW_INVALID', message, [{ field: 'endsAt', message }]);
    if (startsAt < addMinutes(t, -1) || startsAt > addDays(t, 30))
      throw windowErr('Start must be within the next 30 days');
    if (input.endsAt <= startsAt) throw windowErr('End must be after the start');
    if (input.endsAt > addDays(startsAt, 90)) throw windowErr('A grant can last at most 90 days');
    const perm = (await Permission.findOne({ where: { key: def.key }, transaction: tx }))!;
    let grant: MemberGrant;
    try {
      grant = await MemberGrant.create(
        {
          societyId,
          memberId: m.id!,
          permissionId: perm.id!,
          effect: 'ALLOW',
          source: 'ADMIN',
          status: 'ACTIVE',
          startsAt,
          endsAt: input.endsAt,
          reason: input.reason,
          grantedBy: ctx.user!.id,
          expiryReminderSentAt: null,
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
          unitId: null,
          createdBy: ctx.user!.id,
          updatedBy: ctx.user!.id,
        },
        { transaction: tx },
      );
    } catch (err: any) {
      if (err?.name === 'SequelizeUniqueConstraintError')
        throw new ConflictError('GRANT_ALREADY_EXISTS', 'An active grant for this permission already exists');
      throw err;
    }
    await audit(
      ctx,
      {
        action: AUDIT.grantCreated,
        entityType: 'member_grant',
        entityId: grant.id!,
        societyId,
        after: { memberId: m.id, permissionKey: def.key, startsAt, endsAt: input.endsAt },
        reason: input.reason,
      },
      tx,
    );
    invalidateMemberKey(tx, societyId, m.userId);
    notifyAfterCommit(tx, 'access.grant_added', [{ userId: m.userId }], { permission: perm.label });
    emitAccessChanged(tx, societyId, [m.userId], 'GRANT_CHANGED');
    return (await grantViews(m.id!, 'ALL')).find(g => g.id === grant.id)!;
  });
}

export async function revokeGrant(
  ctx: Ctx,
  memberId: number,
  grantId: number,
  reason: string,
): Promise<void> {
  const societyId = ctx.society!.id;
  await sequelize.transaction(async tx => {
    const m = await loadMember(societyId, memberId, tx);
    assertNotSelf(ctx, m.userId);
    const g = await MemberGrant.findOne({
      where: { id: grantId, memberId: m.id!, societyId },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!g) throw new AppError(404, 'GRANT_NOT_FOUND', 'Grant not found');
    if (g.status !== 'ACTIVE') throw invalidState('This grant is not active');
    g.status = 'REVOKED';
    g.revokedAt = now();
    g.revokedBy = ctx.user!.id;
    g.revokeReason = reason;
    g.updatedBy = ctx.user!.id;
    await g.save({ transaction: tx });
    await audit(
      ctx,
      {
        action: AUDIT.grantRevoked,
        entityType: 'member_grant',
        entityId: g.id!,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'REVOKED' },
        reason,
      },
      tx,
    );
    invalidateMemberKey(tx, societyId, m.userId);
    notifyAfterCommit(tx, 'access.grant_revoked', [{ userId: m.userId }], {});
    emitAccessChanged(tx, societyId, [m.userId], 'GRANT_CHANGED');
  });
}

/** Revokes every ACTIVE grant of a member (membership ended, role scope changed). Returns the count. */
export async function revokeAllGrants(
  ctx: Ctx,
  member: Pick<SocietyMember, 'id' | 'societyId'>,
  reason: string,
  tx: Transaction,
  only?: (g: MemberGrant & { Permission: Permission }) => boolean,
): Promise<number> {
  const rows = (await MemberGrant.findAll({
    where: { memberId: member.id!, status: 'ACTIVE' },
    include: [{ model: Permission, attributes: ['key', 'scope'], required: true }],
    transaction: tx,
    lock: { level: tx.LOCK.UPDATE, of: MemberGrant },
  })) as (MemberGrant & { Permission: Permission })[];
  let n = 0;
  for (const g of rows) {
    if (only && !only(g)) continue;
    g.status = 'REVOKED';
    g.revokedAt = now();
    g.revokedBy = ctx.user?.id ?? null;
    g.revokeReason = reason;
    await g.save({ transaction: tx });
    await audit(
      ctx,
      {
        action: AUDIT.grantRevoked,
        entityType: 'member_grant',
        entityId: g.id!,
        societyId: member.societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'REVOKED' },
        reason,
      },
      tx,
    );
    n++;
  }
  return n;
}
