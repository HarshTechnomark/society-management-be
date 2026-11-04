import { Op } from 'sequelize';
import { Invitation, Role, User } from '../../models';
import { now } from '../../lib/clock';
import { members } from '../access-control/access-control.public';
import { entitlements } from '../subscriptions/subscriptions.public';
import { COMMITTEE_ROLE_KEYS } from './committee.constants';

/**
 * Staff accounts view data and the seat meter (8.11, F15, F16, BR-10-29). Read-only: module 03 owns the roles, members and
 * invitations and its own routes do the inviting. Staff roles are the society-scope roles that are not committee roles
 * (`society_admin`, `accountant`, `facility_manager`, `security_supervisor`, `auditor` and the custom ones). Committee roles never
 * hold a seat; which roles do comes from module 03's `consumesSeat` flag.
 */
export async function seatUsage(societyId: number) {
  const [limit, roles] = await Promise.all([
    entitlements.getLimit(societyId, 'limit.admin_seats'),
    Role.findAll({
      where: {
        societyId,
        scope: 'society',
        key: { [Op.notIn]: [...COMMITTEE_ROLE_KEYS] },
      },
      order: [['name', 'ASC']],
    }),
  ]);
  const byKey = new Map(roles.map(r => [r.key, r]));
  const staffKeys = roles.map(r => r.key);
  const rows = staffKeys.length ? await members.listForSociety(societyId, { roleKeys: staffKeys }) : [];
  // module 03 may hold seat-consuming roles outside this list (a custom role of another scope): the meter counts those too
  const consuming = (await members.listForSociety(societyId)).filter(m => m.consumesSeat);
  const used = consuming.length;
  const count = new Map<string, number>();
  for (const m of consuming) count.set(m.roleKey, (count.get(m.roleKey) ?? 0) + 1);

  const seatRoleIds = roles.filter(r => r.consumesSeat).map(r => r.id!);
  const pendingStaffInvitations = seatRoleIds.length
    ? await Invitation.count({
        where: {
          societyId,
          status: 'PENDING',
          roleId: { [Op.in]: seatRoleIds },
          expiresAt: { [Op.gt]: now() },
        },
      })
    : 0;
  const accounts = rows.length
    ? await User.findAll({
        where: { id: { [Op.in]: [...new Set(rows.map(r => r.userId))] } },
        attributes: ['id', 'name'],
      })
    : [];
  const nameOf = new Map(accounts.map(u => [u.id!, u.name]));
  return {
    limit,
    used,
    free: limit === null ? null : Math.max(0, limit - used),
    pendingStaffInvitations,
    byRole: [...count.entries()]
      .map(([roleKey, n]) => ({ roleKey, roleName: byKey.get(roleKey)?.name ?? roleKey, count: n }))
      .sort((a, b) => a.roleName.localeCompare(b.roleName)),
    // additions to 8.11 for the Staff and admins tab (F15): the invite presets and the staff table
    staffRoles: roles.map(r => ({
      roleKey: r.key,
      roleName: r.name,
      consumesSeat: r.consumesSeat,
      isSystem: r.isSystem,
    })),
    staff: rows.map(m => ({
      memberId: m.memberId,
      userId: m.userId,
      name: nameOf.get(m.userId) ?? null,
      roleKey: m.roleKey,
      roleName: byKey.get(m.roleKey)?.name ?? m.roleKey,
      status: m.status,
      consumesSeat: m.consumesSeat,
    })),
  };
}
