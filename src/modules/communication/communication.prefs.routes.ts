import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate.middleware';
import { authenticatedOnly } from '../../middlewares/permission.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { getPreferences, putPreferences, type PreferencesInput } from './communication.prefs.service';

/** 8.23 `GET|PUT /me/notification-preferences`: authenticated, no society context (like `/me/security`). Bodies are strict. */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const flags = z
  .object({ PUSH: z.boolean(), SMS: z.boolean(), WHATSAPP: z.boolean(), EMAIL: z.boolean() })
  .strict();
const put = z
  .object({
    version: z.number().int().min(1),
    locale: z.string().min(2).max(10).nullable(),
    categories: z.record(z.string().max(20), flags),
    quietHours: z
      .object({
        mode: z.enum(['SOCIETY_DEFAULT', 'CUSTOM', 'OFF']),
        start: time.optional(),
        end: time.optional(),
      })
      .strict(),
    whatsappOptIn: z.boolean(),
  })
  .strict();

export const communicationPrefsRoutes = Router();
communicationPrefsRoutes.get(
  '/me/notification-preferences',
  authenticatedOnly(),
  asyncHandler(async (req, res) => ok(res, await getPreferences(req.ctx))),
);
communicationPrefsRoutes.put(
  '/me/notification-preferences',
  authenticatedOnly(),
  validate({ body: put }),
  asyncHandler(async (req, res) =>
    ok(res, await putPreferences(req.ctx, req.valid.body as PreferencesInput), 'Saved'),
  ),
);
