import { Router } from 'express';
import { clearInbox, listInbox } from '../../lib/inbox';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';

/** Non-production only: the last messages the fake adapters recorded (module 01 section 8.9). */
export const devRoutes = Router();

devRoutes.get(
  '/inbox',
  asyncHandler(async (req, res) => {
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const channel = typeof req.query.channel === 'string' ? req.query.channel.toUpperCase() : undefined;
    const items = (await listInbox()).filter(
      m => (!to || m.to === to) && (!channel || m.channel === channel),
    );
    ok(res, items);
  }),
);

devRoutes.delete(
  '/inbox',
  asyncHandler(async (_req, res) => {
    await clearInbox();
    ok(res, null, 'Inbox cleared');
  }),
);
