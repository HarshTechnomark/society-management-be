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
import { noStore } from './modules/auth/auth.controller';
import { devRoutes } from './modules/dev/dev.routes';
import { accessControlRoutes } from './modules/access-control/access-control.routes';
import { authArea, publicRoute } from './middlewares/permission.middleware';
import { subscriptionsRoutes } from './modules/subscriptions/subscriptions.routes';
import { societiesRoutes } from './modules/societies/societies.routes';
import { platformBillingRoutes } from './modules/platform-billing/platform-billing.routes';
import { platformOpsRoutes } from './modules/platform-ops/platform-ops.routes';
import { platformIpAllowlist } from './modules/platform-ops/platform-ops.ip-allowlist';
import './modules/auth/auth.templates';
import './modules/access-control/access-control.templates';
import './modules/societies/societies.templates';
import './modules/platform-ops/platform-ops.templates';

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
  app.use(
    express.json({
      limit: '1mb',
      // webhooks are signed over the exact bytes (module 06 8.28)
      verify: (req, _res, buf) => {
        if ((req as express.Request).originalUrl.startsWith('/api/v1/webhooks/'))
          (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );

  const api = express.Router();
  // app from Origin, CSRF and Origin check, then authentication (module 02). Public routes are listed in
  // modules/auth/public.routes.ts; every other route needs a valid session.
  api.use(['/auth', '/me/security'], noStore); // sign-in and security responses are never cached (module 02 section 13)
  api.use(appContext);
  api.use(csrfMiddleware);
  api.use(authMiddleware);
  api.use('/health', publicRoute(), healthRoutes);
  if (env().NODE_ENV !== 'production') api.use('/dev', publicRoute(), devRoutes);
  api.use('/auth', authArea(), authRoutes);
  api.use('/me/security', authArea(), meSecurityRoutes);
  // module 07 (BR-07-43): the platform IP allowlist applies to every /platform route of every module
  api.use('/platform', platformIpAllowlist());
  // module 03: roles, members, invitations, grants, household and platform team (every route carries a marker)
  api.use(accessControlRoutes);
  // module 04: plans, subscriptions, entitlements and feature flags
  api.use(subscriptionsRoutes);
  // module 05: societies, lifecycle, support access, data exports, public sign-up
  api.use(societiesRoutes);
  // module 06: platform invoices, payments, TDS, credits, refunds and the gateway webhook
  api.use(platformBillingRoutes);
  // module 07: support tickets, settings and organizations (part 1)
  api.use(platformOpsRoutes);
  // each module mounts its routes here: api.use('/societies', societyRoutes), ...
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
