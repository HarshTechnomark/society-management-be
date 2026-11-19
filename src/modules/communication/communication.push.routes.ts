import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.middleware';
import { authenticatedOnly, publicRoute } from '../../middlewares/permission.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok } from '../../utils/response';
import { PUSH_APPS } from './communication.constants';
import {
  listSubscriptions,
  subscribe,
  testSubscription,
  unsubscribe,
  vapidPublicKey,
  type SubscribeInput,
} from './communication.push.service';

/** 8.24 push subscriptions: authenticated, no society context. `GET /public/push/vapid-public-key` is public. */
const b64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'Not base64url');
const schemas = {
  id: z.object({ id: z.coerce.number().int().positive() }).strict(),
  create: z
    .object({
      endpoint: z.string().max(1000).url().startsWith('https://', 'Must be an https:// URL'),
      keys: z.object({ p256dh: b64url(87, 88), auth: b64url(22, 24) }).strict(),
      expirationTime: z.number().int().positive().nullable().optional(),
      app: z.enum(PUSH_APPS),
    })
    .strict(),
};

export const communicationPushRoutes = Router();
const r = communicationPushRoutes;
r.get(
  '/public/push/vapid-public-key',
  publicRoute(),
  asyncHandler(async (_req, res) => ok(res, vapidPublicKey())),
);
r.get(
  '/me/push-subscriptions',
  authenticatedOnly(),
  asyncHandler(async (req, res) => ok(res, await listSubscriptions(req.ctx))),
);
r.post(
  '/me/push-subscriptions',
  authenticatedOnly(),
  validate({ body: schemas.create }),
  asyncHandler(async (req, res) => created(res, await subscribe(req.ctx, req.valid.body as SubscribeInput))),
);
r.delete(
  '/me/push-subscriptions/:id',
  authenticatedOnly(),
  validate({ params: schemas.id }),
  asyncHandler(async (req, res) => {
    await unsubscribe(req.ctx, (req.valid.params as { id: number }).id);
    return noContent(res);
  }),
);
r.post(
  '/me/push-subscriptions/:id/test',
  authenticatedOnly(),
  validate({ params: schemas.id }),
  rateLimit({ name: 'push-test', limit: 5, windowSeconds: 3600, key: req => String(req.ctx.user?.id) }),
  asyncHandler(async (req, res) =>
    ok(res, await testSubscription(req.ctx, (req.valid.params as { id: number }).id)),
  ),
);
