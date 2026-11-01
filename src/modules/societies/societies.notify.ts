import { Op, type Transaction } from 'sequelize';
import { Role, SocietyMember, User } from '../../models';
import { notify } from '../../lib/notify';
import { logger } from '../../lib/logger';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { usersWithPermission } from '../access-control/access-control.public';
import { getPlatformRoleKeys } from '../access-control/access-control.access';

/**
 * Recipient groups of section 10 and after-commit helpers. Notifications go through the temporary `lib/notify.ts`
 * (module 16 stand-in; in-app and push are not delivered by it). A failed send never fails the action it reports.
 */
export type Group = (societyId: number) => Promise<number[]>;

const byRoles =
  (keys: string[]): Group =>
  async societyId => {
    const rows = await SocietyMember.findAll({
      where: { societyId, status: 'ACTIVE' },
      attributes: ['userId'],
      include: [{ model: Role, attributes: ['key'], where: { key: { [Op.in]: keys } }, required: true }],
      order: [['id', 'ASC']],
    });
    // chairman first (section 10 "Chairman first in the list")
    const ordered = [...rows].sort(
      (a, b) => Number((b as any).Role.key === 'chairman') - Number((a as any).Role.key === 'chairman'),
    );
    return [...new Set(ordered.map(r => r.userId))];
  };

export const groups = {
  committee: byRoles(['chairman', 'secretary', 'treasurer', 'society_admin']),
  chairAndAdmin: byRoles(['chairman', 'society_admin']),
  billingAdmins: (societyId: number) => usersWithPermission(societyId, 'settings.subscription.view'),
  approvers: async (societyId: number) => {
    const ids = await usersWithPermission(societyId, 'settings.support_access.approve');
    const chair = await byRoles(['chairman'])(societyId);
    return [...new Set([...chair.filter(id => ids.includes(id)), ...ids])];
  },
  exportViewers: (societyId: number) => usersWithPermission(societyId, 'settings.data_export.view'),
  residents: async (societyId: number) => {
    const rows = await SocietyMember.findAll({
      where: { societyId, status: 'ACTIVE' },
      attributes: ['userId'],
      include: [{ model: Role, attributes: [], where: { scope: 'resident' }, required: true }],
    });
    return [...new Set(rows.map(r => r.userId))];
  },
};

/** Active platform users whose platform role holds the key (platform in-app notices). */
export async function platformUsersWith(key: string): Promise<number[]> {
  const users = await User.findAll({
    where: { platformRoleId: { [Op.ne]: null }, status: 'ACTIVE' },
    attributes: ['id', 'platformRoleId'],
  });
  const out: number[] = [];
  for (const u of users) if ((await getPlatformRoleKeys(u.platformRoleId!)).includes(key)) out.push(u.id!);
  return out;
}

export async function send(
  template: string,
  userIds: number[],
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await notify(
      template,
      [...new Set(userIds)].map(userId => ({ userId })),
      data,
    );
  } catch (err) {
    logger.error({ err, template }, 'societies notify failed');
  }
}

/** Sends to a recipient group of the society after the transaction commits. */
export function notifyAfterCommit(
  t: Transaction | null,
  template: string,
  recipients: (() => Promise<number[]>) | number[],
  data: Record<string, unknown>,
): void {
  const run = async () => {
    try {
      const ids = Array.isArray(recipients) ? recipients : await recipients();
      if (ids.length) await send(template, ids, data);
    } catch (err) {
      logger.error({ err, template }, 'societies notify failed');
    }
  };
  if (t) t.afterCommit(run);
  else void run();
}

export function emitAfterCommit(
  t: Transaction | null,
  events: { room?: string; userId?: number; event: string; payload: Record<string, unknown> }[],
): void {
  const run = () => {
    for (const e of events) {
      if (e.room) emitToRoom(e.room, e.event, e.payload);
      if (e.userId) emitToUser(e.userId, e.event, e.payload);
    }
  };
  if (t) t.afterCommit(run);
  else run();
}
