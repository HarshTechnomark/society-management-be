import { Op } from 'sequelize';
import type { Transaction } from 'sequelize';
import { InboxItem } from '../../models';
import { emitToUser } from '../../lib/realtime';
import { RT, type TemplateScope } from './communication.constants';

/** Inbox items (7.5): unread counts by scope, mark read, realtime `notification.created` / `notification.read` (9.3). */
export interface ScopeFilter {
  societyId?: number | null;
  /** `PLATFORM` for the platform bell; otherwise USER items plus the items of `societyId`. */
  platform?: boolean;
}
const scopeWhere = (f: ScopeFilter) =>
  f.platform
    ? { scope: 'PLATFORM' }
    : {
        [Op.or]: [{ scope: 'USER' }, ...(f.societyId ? [{ scope: 'SOCIETY', societyId: f.societyId }] : [])],
      };

export async function unreadCount(userId: number, f: ScopeFilter = {}): Promise<number> {
  return InboxItem.count({ where: { userId, readAt: null, ...scopeWhere(f) } });
}

/** Marks one item (or all with `id = 'all'`) read; returns the ids changed. Emits `notification.read` with the new unread count. */
export async function markRead(
  userId: number,
  id: number | 'all',
  f: ScopeFilter = {},
  t?: Transaction,
): Promise<number[]> {
  const at = new Date();
  const where = { userId, readAt: null, ...scopeWhere(f), ...(id === 'all' ? {} : { id }) };
  const rows = await InboxItem.findAll({ where, attributes: ['id'], transaction: t });
  const ids = rows.map(r => r.id);
  if (ids.length) await InboxItem.update({ readAt: at }, { where: { id: ids }, transaction: t });
  const after = async () =>
    emitToUser(userId, RT.notificationRead, {
      ids: id === 'all' ? 'all' : ids,
      unreadCount: await unreadCount(userId, f),
    });
  if (t) t.afterCommit(after);
  else await after();
  return ids;
}

export const inboxScopeFor = (
  scope: TemplateScope,
  societyId: number | undefined,
): 'USER' | 'SOCIETY' | 'PLATFORM' =>
  scope === 'PLATFORM' ? 'PLATFORM' : scope === 'SOCIETY' && societyId ? 'SOCIETY' : 'USER';

/** 9.3 payload of `notification.created` (body at most 140 characters). */
export function emitCreated(
  userId: number,
  item: {
    id: number;
    title: string;
    body: string;
    tone: string;
    deepLink: string | null;
    category: string;
    createdAt: Date;
  },
  unread: number,
): void {
  emitToUser(userId, RT.notificationCreated, {
    id: item.id,
    title: item.title,
    body: item.body.slice(0, 140),
    tone: item.tone,
    deepLink: item.deepLink,
    category: item.category,
    createdAt: item.createdAt.toISOString(),
    unreadCount: unread,
  });
}
