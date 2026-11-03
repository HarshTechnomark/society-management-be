import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';
import { logger } from '../../lib/logger';
import { committeePorts } from './committee.ports';

/**
 * Notifications of section 10 sent after the transaction commits through the module 16 port. A failed send is logged and never
 * undoes the action. Recipients are user ids (or a function that finds them after commit); data never holds phone numbers.
 */
export interface Announcement {
  template: string;
  userIds: number[] | (() => Promise<number[]>);
  termName: string;
  endDate?: string;
  designationLabel?: string;
}
export function announce(t: Transaction, ctx: Ctx, _societyId: number, a: Announcement): void {
  t.afterCommit(() => {
    void (async () => {
      try {
        const ids = [...new Set(typeof a.userIds === 'function' ? await a.userIds() : a.userIds)];
        if (!ids.length) return;
        await committeePorts().notifications.send(a.template, ids, {
          societyName: ctx.society?.name ?? 'Your society',
          termName: a.termName,
          endDate: a.endDate ?? '',
          designationLabel: a.designationLabel ?? '',
          link: '/committee',
        });
      } catch (err) {
        logger.error({ err, template: a.template }, 'committee announce failed');
      }
    })();
  });
}
