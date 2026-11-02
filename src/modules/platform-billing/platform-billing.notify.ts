import type { Transaction } from 'sequelize';
import { groups, notifyAfterCommit, platformUsersWith } from '../societies/societies.notify';
import { usersWithPermission } from '../access-control/access-control.public';
import './platform-billing.templates';

/** Subscription viewers of the society (section 10), after the transaction commits. */
export const notifySubscriptionViewers = (
  t: Transaction | null,
  template: string,
  societyId: number,
  data: Record<string, unknown>,
): void => notifyAfterCommit(t, template, () => groups.billingAdmins(societyId), data);

/** Members who pay (`settings.subscription.edit`): the Treasurer, Chairman and Society Admin. */
export const payersOf = (societyId: number): Promise<number[]> =>
  usersWithPermission(societyId, 'settings.subscription.edit');

/** Platform users holding a platform permission, minus one user (the maker). */
export const notifyPlatform = (
  t: Transaction | null,
  template: string,
  permission: string,
  data: Record<string, unknown>,
  exceptUserId?: number | null,
): void =>
  notifyAfterCommit(
    t,
    template,
    async () => (await platformUsersWith(permission)).filter(id => id !== exceptUserId),
    data,
  );
