import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.middleware';
import { anyActiveMember } from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { platformMiddleware, societyMiddleware } from '../../middlewares/society.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { routeMeta } from '../societies/societies.guard';
import {
  countUnread,
  listNotifications,
  readAll,
  readNotification,
  type Bell,
} from './communication.inbox.service';

/**
 * Notification bell (8.20, 8.21) and platform bell (8.22). Both bells carry `routeMeta({ suspended: 'allow' })` on the read routes (BR-16-32 UX state
 * must work for a suspended society too). `GET` lists carry `unreadCount` beside `data` and `pagination`.
 */
const id = z.coerce.number().int().positive();
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const category = z
  .string()
  .trim()
  .min(2)
  .max(12)
  .refine(v => /^[A-Z_]+$/.test(v), 'Not a category');
const schemas = {
  list: z
    .object({
      unread: bool.optional(),
      category: category.optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .strict(),
  idParam: z.object({ id }).strict(),
  readAll: z.object({ category: category.optional() }).strict(),
};

const handlers = (bell: Bell) => ({
  list: asyncHandler(async (req, res) => {
    const r = await listNotifications(bell, req.ctx, req.valid.query as never);
    return res.status(200).json({
      success: true,
      data: r.items,
      message: 'OK',
      pagination: r.pagination,
      unreadCount: r.unreadCount,
    });
  }),
  count: asyncHandler(async (req, res) => ok(res, { count: await countUnread(bell, req.ctx) })),
  read: asyncHandler(async (req, res) =>
    ok(res, await readNotification(bell, req.ctx, (req.valid.params as { id: number }).id)),
  ),
  readAll: asyncHandler(async (req, res) =>
    ok(res, await readAll(bell, req.ctx, (req.valid.body as { category?: string }).category)),
  ),
});

export const communicationInboxRoutes = Router();
const r = communicationInboxRoutes;
const open = () => routeMeta({ suspended: 'allow' });
const society = () => societyMiddleware();
const s = handlers('SOCIETY');
// fixed paths before `:id`
r.get('/notifications/unread-count', open(), society(), anyActiveMember(), s.count);
r.post(
  '/notifications/read-all',
  open(),
  society(),
  anyActiveMember(),
  validate({ body: schemas.readAll }),
  s.readAll,
);
r.get('/notifications', open(), society(), anyActiveMember(), validate({ query: schemas.list }), s.list);
r.post(
  '/notifications/:id/read',
  open(),
  society(),
  anyActiveMember(),
  validate({ params: schemas.idParam }),
  s.read,
);

const p = handlers('PLATFORM');
/** The platform bell shows the caller's own items: a platform user is enough, no permission key (marked like `anyActiveMember` for the route registry). */
const platform = () => [platformMiddleware(), tag((_req, _res, next) => next(), { memberOnly: true })];
r.get('/platform/notifications/unread-count', ...platform(), p.count);
r.post('/platform/notifications/read-all', ...platform(), validate({ body: schemas.readAll }), p.readAll);
r.get('/platform/notifications', ...platform(), validate({ query: schemas.list }), p.list);
r.post('/platform/notifications/:id/read', ...platform(), validate({ params: schemas.idParam }), p.read);
