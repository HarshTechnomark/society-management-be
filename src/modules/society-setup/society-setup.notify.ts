import type { Transaction } from 'sequelize';
import { Society } from '../../models';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import { emitToRoom } from '../../lib/realtime';
import { usersWithPermission } from '../access-control/access-control.public';
import './society-setup.templates';

/** After-commit helpers of module 08 (sections 9.3 and 10). A failed send never fails the action it reports. */
export const adminRoom = (societyId: number): string => `society:${societyId}:admin`;

export const emitAdmin = (societyId: number, event: string, payload: Record<string, unknown>): void =>
  emitToRoom(adminRoom(societyId), event, payload);

export const recipients = {
  viewers: (societyId: number) => usersWithPermission(societyId, 'settings.society.view'),
  editors: (societyId: number) => usersWithPermission(societyId, 'settings.society.edit'),
  billingApprovers: (societyId: number) => usersWithPermission(societyId, 'finance.billing.approve'),
};

async function send(
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
      { societyName: name, link: '/settings', ...data },
    );
  } catch (err) {
    logger.error({ err, template }, 'society-setup notify failed');
  }
}

/** Sends to one user right away (jobs: import and export results). A failed send never fails the job. */
export const notifyUser = (
  template: string,
  societyId: number,
  userId: number,
  data: Record<string, unknown>,
): Promise<void> => send(template, societyId, async () => [userId], data);

/** Sends once the transaction has committed. */
export function notifyAfterCommit(
  t: Transaction,
  template: string,
  societyId: number,
  to: (societyId: number) => Promise<number[]>,
  data: Record<string, unknown>,
): void {
  t.afterCommit(() => {
    void send(template, societyId, to, data);
  });
}
