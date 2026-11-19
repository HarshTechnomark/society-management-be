import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, okList } from '../../utils/response';
import { NOTICE_CATEGORIES } from './communication.constants';
import {
  acknowledgeNotice,
  getMyNotice,
  listMyNotices,
  myNoticeFileUrl,
  type ListQuery,
} from './communication.me.notices.service';

/** Resident routes 8.18 (`/me` variant), 8.19 and 8.17 (`/me` variant). Notices are an essential service: no entitlement gate (default suspended policy: reads allowed, writes blocked). */
const PERM = { view: 'resident.notices.view', edit: 'resident.notices.edit' } as const;
const id = z.coerce.number().int().positive();
const schemas = {
  list: z
    .object({
      category: z.enum(NOTICE_CATEGORIES).optional(),
      unread: z
        .enum(['true', 'false'])
        .transform(v => v === 'true')
        .optional(),
      q: z.string().trim().min(2).max(60).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .strict(),
  idParam: z.object({ id }).strict(),
  fileParam: z.object({ id, fileId: id }).strict(),
  fileQuery: z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }).strict(),
  ack: z.object({ appVersion: z.string().trim().max(20).optional() }).strict(),
};

export const communicationMeRoutes = Router();
const r = communicationMeRoutes;
const society = () => societyMiddleware();
const p = <K extends string>(req: { valid: { params?: unknown } }) => req.valid.params as Record<K, number>;

r.get(
  '/me/notices',
  society(),
  can(PERM.view),
  validate({ query: schemas.list }),
  asyncHandler(async (req, res) => {
    const out = await listMyNotices(req.ctx, req.valid.query as ListQuery);
    return okList(res, out.items, out.pagination);
  }),
);
r.get(
  '/me/notices/:id',
  society(),
  can(PERM.view),
  validate({ params: schemas.idParam }),
  asyncHandler(async (req, res) => ok(res, await getMyNotice(req.ctx, p<'id'>(req).id))),
);
r.post(
  '/me/notices/:id/acknowledge',
  society(),
  can(PERM.edit),
  validate({ params: schemas.idParam, body: schemas.ack }),
  asyncHandler(async (req, res) =>
    ok(res, await acknowledgeNotice(req.ctx, p<'id'>(req).id, req.valid.body as { appVersion?: string })),
  ),
);
r.get(
  '/me/notices/:id/attachments/:fileId/download-url',
  society(),
  can(PERM.view),
  validate({ params: schemas.fileParam, query: schemas.fileQuery }),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await myNoticeFileUrl(
        req.ctx,
        p<'id'>(req).id,
        p<'fileId'>(req).fileId,
        (req.valid.query as { disposition: 'inline' | 'attachment' }).disposition,
      ),
    ),
  ),
);
