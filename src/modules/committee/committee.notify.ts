import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';
import { logger } from '../../lib/logger';
import { Society } from '../../models';
import { usersWithPermission } from '../access-control/access-control.public';
import { committeePorts } from './committee.ports';
import { getCurrent } from './committee.queries';

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

/** Section 10 "officers": the seated Chairman and Secretary of the current term plus everyone with `settings.members.edit`. */
export async function officerIds(societyId: number): Promise<number[]> {
  const cur = await getCurrent(societyId);
  const seated = (cur?.seats ?? [])
    .filter(s => s.designation === 'CHAIRMAN' || s.designation === 'SECRETARY')
    .map(s => s.userId);
  return [...new Set([...seated, ...(await usersWithPermission(societyId, 'settings.members.edit'))])];
}

/** `DD MMM YYYY` of a business date (section 10 data `endDate`). */
export function formatYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    Number(m) - 1
  ];
  return `${d} ${month} ${y}`;
}

/** Sends now (jobs have no transaction to wait for). A failed send is logged and never fails the job. */
export async function sendNow(
  societyId: number,
  template: string,
  userIds: number[],
  data: { termName: string; endDate?: string; daysLeft?: number; designationLabel?: string; extra?: string },
): Promise<void> {
  try {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const society = await Society.findByPk(societyId, { attributes: ['name'] });
    await committeePorts().notifications.send(template, ids, {
      societyName: society?.name ?? 'Your society',
      termName: data.termName,
      endDate: data.endDate ? formatYmd(data.endDate) : '',
      daysLeft: data.daysLeft ?? null,
      designationLabel: data.designationLabel ?? '',
      detail: data.extra ?? '',
      link: '/committee',
    });
  } catch (err) {
    logger.error({ err, template }, 'committee notification failed');
  }
}
