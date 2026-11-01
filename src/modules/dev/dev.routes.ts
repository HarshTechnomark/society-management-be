import { Router } from 'express';
import { clearInbox, listInbox } from '../../lib/inbox';
import { placeholderExports } from '../access-control/access-control.ports';
import { placeholderFiles } from '../societies/societies.ports';
import { AppError } from '../../utils/errors';
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

/** Placeholder download for exports until the module 01 file service exists (module 03 members export). */
devRoutes.get('/exports/:id', (req, res, next) => {
  const f = placeholderExports.get(Number(req.params.id));
  if (!f || f.expiresAt < new Date()) return next(new AppError(404, 'NOT_FOUND', 'Export not found'));
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.send(f.content);
});

/** Placeholder file download (module 05 data export parts) until the module 01 file service exists. */
devRoutes.get('/files/:id', (req, res, next) => {
  const f = placeholderFiles.get(Number(req.params.id));
  if (!f || f.status !== 'CLEAN') return next(new AppError(404, 'NOT_FOUND', 'File not found'));
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.send(f.content);
});
