import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './lib/env';
import { requestId } from './middlewares/requestId.middleware';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { healthRoutes } from './modules/health/health.routes';

/**
 * Express assembly. Order of the request pipeline: requestId > helmet/cors/cookies > routes > error handler.
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
  // rate limiting goes here
  // authentication goes here (module 02)

  const api = express.Router();
  api.use('/health', healthRoutes);
  // each module mounts its routes here: api.use('/auth', authRoutes), ...
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
