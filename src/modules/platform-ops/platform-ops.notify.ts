import { Op, type Transaction } from 'sequelize';
import { Role, SocietyMember, User } from '../../models';
import { logger } from '../../lib/logger';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { notify } from '../../lib/notify';
import { usersWithPermission } from '../access-control/access-control.public';
import { getPlatformRoleKeys } from '../access-control/access-control.access';
import './platform-ops.templates';

/**
 * Recipient groups and after-commit helpers of module 07 (section 10). "Support team" = ACTIVE platform users with
 * `platform.tickets.edit`. A failed send never fails the action it reports.
 */
export async function platformUsersWith(key: string): Promise<number[]> {
  const users = await User.findAll({
    where: { platformRoleId: { [Op.ne]: null }, status: 'ACTIVE' },
    attributes: ['id', 'platformRoleId'],
    order: [['id', 'ASC']],
  });
  const out: number[] = [];
  for (const u of users) if ((await getPlatformRoleKeys(u.platformRoleId!)).includes(key)) out.push(u.id!);
  return out;
}

export const supportTeam = (): Promise<number[]> => platformUsersWith('platform.tickets.edit');

/** The raiser while still an ACTIVE member, else every member holding `settings.support.create` (section 10). */
export async function raiserRecipients(societyId: number, raiserUserId: number): Promise<number[]> {
  const m = await SocietyMember.findOne({
    where: { societyId, userId: raiserUserId, status: 'ACTIVE' },
    attributes: ['id'],
    include: [{ model: Role, attributes: ['scope'], required: true }],
  });
  if (m) return [raiserUserId];
  return usersWithPermission(societyId, 'settings.support.create');
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
    logger.error({ err, template }, 'platform-ops notify failed');
  }
}

/** Sends after the transaction commits (or at once without one). `recipients` may be resolved lazily. */
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
      logger.error({ err, template }, 'platform-ops notify failed');
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
