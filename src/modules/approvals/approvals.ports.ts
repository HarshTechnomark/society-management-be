import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';

/**
 * What module 14 needs from module 16 (notifications). Same shape as the `NotificationsPort` of modules 11 and 12, so one
 * implementation serves all. Default: the temporary `notify()` stand-in; module 16 replaces it.
 */
export interface ApprovalsNotificationsPort {
  send(template: string, userIds: number[], data: Record<string, unknown>): Promise<void>;
}
export interface ApprovalsPorts {
  notifications: ApprovalsNotificationsPort;
}
/** Every notification the engine sent (tests assert them; the default port records them too). */
export const sentNotifications: { template: string; userIds: number[]; data: Record<string, unknown> }[] = [];

export const defaultApprovalsPorts: ApprovalsPorts = {
  notifications: {
    send: async (template, userIds, data) => {
      sentNotifications.push({ template, userIds, data });
      try {
        await notify(
          template,
          userIds.map(userId => ({ userId })),
          data,
        );
      } catch (err) {
        logger.error({ err, template }, 'approvals notify failed');
      }
    },
  },
};
let current: ApprovalsPorts = defaultApprovalsPorts;
export const approvalsPorts = (): ApprovalsPorts => current;
export function setApprovalsPorts(p?: { [K in keyof ApprovalsPorts]?: Partial<ApprovalsPorts[K]> }): void {
  if (!p) {
    current = defaultApprovalsPorts;
    sentNotifications.length = 0;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as ApprovalsPorts;
}
