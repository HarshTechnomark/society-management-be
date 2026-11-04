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
import { societySetupRoutes } from './modules/society-setup/society-setup.routes';
import { residentsRoutes } from './modules/residents/residents.routes';
import { residentsPart2Routes } from './modules/residents/residents.part2.routes';
import { committeeRoutes } from './modules/committee/committee.routes';
import { billingRunsRoutes } from './modules/billing/billing.runs.routes';
import { billingSimRoutes } from './modules/billing/billing.sim.routes';
import { billingSetupRoutes } from './modules/billing/billing.setup.routes';
import { billingLedgerRoutes } from './modules/billing/billing.ledger.routes';
import { billingInvoicesRoutes } from './modules/billing/billing.invoices.routes';
import { requestMetrics } from './modules/platform-ops/platform-ops.metrics';
import { platformIpAllowlist } from './modules/platform-ops/platform-ops.ip-allowlist';
import './modules/auth/auth.templates';
import './modules/access-control/access-control.templates';
import './modules/societies/societies.templates';
import './modules/platform-ops/platform-ops.templates';
import './modules/society-setup/society-setup.templates';
import './modules/residents/residents.templates';
import './modules/committee/committee.templates';

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
  app.use(requestMetrics()); // module 07 (9.4): request counts and latency buckets
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
  // module 07: support tickets, settings, organizations, dashboard, providers, incidents, announcements, queues, audit
  api.use(platformOpsRoutes);
  // module 08: society profile, settings, buildings, units, generator, locations, holidays, onboarding
  api.use(societySetupRoutes);
  // module 09: residents, unit links, documents, directory, pets, emergency profiles (join requests, tenancies, moves, permits and transfers follow in parts 2 and 3)
  api.use(residentsRoutes);
  api.use(residentsPart2Routes); // module 09 part 2: tenancies, join requests, move requests
  // module 10: committee terms and seats (10.1); activation, changes, hand-over and the resident page follow in 10.2 and 10.3
  api.use(committeeRoutes);
  // module 11 (11.3): billing runs, compute and issue
  api.use(billingRunsRoutes);
  api.use(billingSimRoutes); // POST /billing/rules/simulate (spec 8.2)
  // module 11 (11.1): charge heads, billing rules and versions, bill split rules, late fee policies
  api.use(billingSetupRoutes);
  // module 11 (11.2): unit statement of account and opening balances; 11.1, 11.3, 11.4 and 11.5 mount their routers beside it
  api.use(billingLedgerRoutes);
  // module 11 (11.4): invoices, ad-hoc invoices, credit and debit notes, cancellation, write-off, PDFs
  api.use(billingInvoicesRoutes);
  // each module mounts its routes here: api.use('/societies', societyRoutes), ...
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
