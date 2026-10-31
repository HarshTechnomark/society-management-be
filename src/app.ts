import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './lib/env';
import { requestId } from './middlewares/requestId.middleware';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { healthRoutes } from './modules/health/health.routes';
import { appContext } from './middlewares/appContext.middleware';
import { csrfMiddleware } from './middlewares/csrf.middleware';
import { authMiddleware } from './middlewares/auth.middleware';
import { authRoutes, meSecurityRoutes } from './modules/auth/auth.routes';
import { devRoutes } from './modules/dev/dev.routes';
import './modules/auth/auth.templates';

/**
 * Express assembly. Order of the request pipeline: requestId > helmet/cors/cookies > appContext > csrf > auth > routes > error handler.
 * Later modules add rate limiting (01 later), authentication (02), society and permission checks (03) and
 * entitlement checks (04) in the places marked below.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(helmet());
  app.use(cors({ origin: env().appOrigins, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  // app from Origin, CSRF and Origin check, then authentication (module 02). Public routes are listed in
  // modules/auth/public.routes.ts; every other route needs a valid session.
  api.use(appContext);
  api.use(csrfMiddleware);
  api.use(authMiddleware);
  api.use('/health', healthRoutes);
  if (env().NODE_ENV !== 'production') api.use('/dev', devRoutes);
  api.use('/auth', authRoutes);
  api.use('/me/security', meSecurityRoutes);
  // each module mounts its routes here: api.use('/societies', societyRoutes), ...
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
