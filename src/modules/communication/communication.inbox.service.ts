import { Op, type WhereOptions } from 'sequelize';
import { InboxItem } from '../../models';
import { now } from '../../lib/clock';
import { emitToUser } from '../../lib/realtime';
import type { Ctx } from '../../types/context';
import { NotFoundError } from '../../utils/errors';
import { ERR, RT } from './communication.constants';

/**
 * Bell routes (8.20 to 8.22): the caller's own inbox items. The society bell shows `USER` items and the `SOCIETY` items of the active society
 * (BR-16-32); the platform bell shows `PLATFORM` and `USER` items. Marking read is UX state: no audit row. `notification.read` goes to `user:<id>`.
 */
export type Bell = 'SOCIETY' | 'PLATFORM';

const scope = (bell: Bell, ctx: Ctx): WhereOptions =>
  bell === 'PLATFORM'
    ? { scope: { [Op.in]: ['PLATFORM', 'USER'] } }
    : {
        [Op.or]: [
          { scope: 'USER' },
          ...(ctx.society ? [{ scope: 'SOCIETY', societyId: ctx.society.id }] : []),
        ],
      };

const mine = (bell: Bell, ctx: Ctx, extra: WhereOptions = {}): WhereOptions => ({
  [Op.and]: [{ userId: ctx.user!.id }, scope(bell, ctx), extra],
});

export const countUnread = (bell: Bell, ctx: Ctx): Promise<number> =>
  InboxItem.count({ where: mine(bell, ctx, { readAt: null }) });

export interface NotificationDto {
  id: number;
  templateKey: string;
  category: string;
  tone: string;
  title: string;
  body: string;
  deepLink: string | null;
  readAt: string | null;
  createdAt: string;
}
const dto = (r: InboxItem): NotificationDto => ({
  id: r.id,
  templateKey: r.templateKey,
  category: r.category,
  tone: r.tone,
  title: r.title,
  body: r.body,
  deepLink: r.deepLink,
  readAt: r.readAt ? r.readAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
});

export async function listNotifications(
  bell: Bell,
  ctx: Ctx,
  q: { unread?: boolean; category?: string; page: number; limit: number },
) {
  const where = mine(bell, ctx, {
    ...(q.unread ? { readAt: null } : {}),
    ...(q.category ? { category: q.category } : {}),
  });
  const { rows, count } = await InboxItem.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return {
    items: rows.map(dto),
    unreadCount: await countUnread(bell, ctx),
    pagination: {
      page: q.page,
      limit: q.limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / q.limit)),
    },
  };
}

async function emitRead(userId: number, ids: number[] | 'all', unreadCount: number): Promise<void> {
  emitToUser(userId, RT.notificationRead, { ids, unreadCount });
}

/** 8.21: sets `readAt` if NULL on one visible item. Another user's item (or one outside the bell) is `404 NOTIFICATION_NOT_FOUND`. */
export async function readNotification(
  bell: Bell,
  ctx: Ctx,
  id: number,
): Promise<{ id: number; readAt: string }> {
  const row = await InboxItem.findOne({ where: mine(bell, ctx, { id }) });
  if (!row) throw new NotFoundError(ERR.notificationNotFound, 'Notification not found');
  if (!row.readAt) {
    row.readAt = now();
    await row.save({ fields: ['readAt', 'updatedAt'] });
    await emitRead(ctx.user!.id, [row.id], await countUnread(bell, ctx));
  }
  return { id: row.id, readAt: row.readAt.toISOString() };
}

/** 8.21: marks every visible unread item (at most 5,000 per call, optionally one category); returns `{ updated }`. */
export async function readAll(bell: Bell, ctx: Ctx, category?: string): Promise<{ updated: number }> {
  const rows = await InboxItem.findAll({
    where: mine(bell, ctx, { readAt: null, ...(category ? { category } : {}) }),
    attributes: ['id'],
    order: [['id', 'DESC']],
    limit: 5000,
  });
  if (rows.length) {
    await InboxItem.update(
      { readAt: now() },
      { where: { id: rows.map(r => r.id), userId: ctx.user!.id, readAt: null } },
    );
    await emitRead(ctx.user!.id, 'all', await countUnread(bell, ctx));
  }
  return { updated: rows.length };
}
