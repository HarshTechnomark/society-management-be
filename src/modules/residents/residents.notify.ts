import type { Transaction } from 'sequelize';
import { Society } from '../../models';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import { emitToRoom } from '../../lib/realtime';
import { usersWithPermission } from '../access-control/access-control.public';
import './residents.templates';

/** After-commit helpers of module 09 (sections 9.3 and 10). A failed send never fails the action it reports. */
export const adminRoom = (societyId: number): string => `society:${societyId}:admin`;

export const recipients = {
  /** "Admins" = active members with `residents.requests.view` (section 10). */
  admins: (societyId: number) => usersWithPermission(societyId, 'residents.requests.view'),
  /** Members with `residents.people.edit` (`residents.mobile_conflict`). */
  editors: (societyId: number) => usersWithPermission(societyId, 'residents.people.edit'),
  users: (ids: number[]) => async () => ids,
};

export async function sendNow(
  template: string,
  societyId: number,
  to: (societyId: number) => Promise<number[]>,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const name = (await Society.findByPk(societyId, { attributes: ['name'] }))?.name ?? 'Your society';
    const ids = [...new Set(await to(societyId))];
    await notify(
      template,
      ids.map(userId => ({ userId })),
      { societyName: name, link: '/residents', ...data },
    );
  } catch (err) {
    logger.error({ err, template }, 'residents notify failed');
  }
}

/** Sends once the transaction has committed. */
export function notifyAfterCommit(
  t: Transaction,
  template: string,
  societyId: number,
  to: (societyId: number) => Promise<number[]>,
  data: Record<string, unknown>,
): void {
  t.afterCommit(() => {
    void sendNow(template, societyId, to, data);
  });
}

/** Room events of section 9.3 (`household.changed`, `residents.requests.changed`, ...), after commit. */
export function emitAfterCommit(
  t: Transaction,
  room: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  t.afterCommit(() => emitToRoom(room, event, payload));
}
