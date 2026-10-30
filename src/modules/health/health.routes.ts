import { Router } from 'express';
import { sequelize } from '../../models';
import { env } from '../../lib/env';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { NotReadyError } from '../../utils/errors';

export const healthRoutes = Router();
const startedAt = Date.now();

/** Liveness: the process is up. No database call, so it stays fast under load. */
healthRoutes.get('/', (_req, res) => {
  ok(res, {
    status: 'ok',
    version: env().APP_VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

/** Readiness: the database answers. Modules add their own checks (Redis, migrations) later. */
healthRoutes.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    try {
      await sequelize.query('SELECT 1');
    } catch {
      throw new NotReadyError({ db: 'unreachable' });
    }
    ok(res, { db: 'ok' });
  }),
);
