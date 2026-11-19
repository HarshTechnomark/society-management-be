import { Router, type Request, type RequestHandler } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, okList } from '../../utils/response';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { platformMiddleware } from '../../middlewares/society.middleware';
import {
  publicRoute,
  requirePlatformPermission as canPlatform,
} from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { PERM } from './communication.constants';
import {
  getTemplateRow,
  listTemplates,
  previewTemplate,
  updateTemplate,
} from './communication.templates.admin';
import { searchDeliveries } from './communication.platform.deliveries';
import { platformSchemas as s } from './communication.platform.validation';
import { receiveWebhook } from './communication.webhooks.service';

/**
 * Module 16.4 routes: platform template registry (8.35), platform delivery log (8.36) and the messaging webhook (8.37). Order on a route:
 * platform marker, permission, validate, step-up, controller.
 */
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const v = (req: Request) => req.valid;
const h = (fn: (req: Request, res: Parameters<RequestHandler>[1]) => Promise<unknown>): RequestHandler =>
  asyncHandler(fn);

export const communicationPlatformRoutes = Router();
const r = communicationPlatformRoutes;

r.get(
  '/platform/notification-templates',
  platformMiddleware(),
  canPlatform(PERM.platformSettingsView),
  validate({ query: s.templateList }),
  h(async (req, res) => {
    const out = await listTemplates(v(req).query);
    okList(res, out.data, out.pagination);
  }),
);
r.get(
  '/platform/notification-templates/:id',
  platformMiddleware(),
  canPlatform(PERM.platformSettingsView),
  validate({ params: s.idParam }),
  h(async (req, res) => ok(res, await getTemplateRow(v(req).params.id))),
);
r.patch(
  '/platform/notification-templates/:id',
  platformMiddleware(),
  canPlatform(PERM.platformSettingsEdit),
  validate({ params: s.idParam, body: s.templatePatch }),
  stepUp(),
  h(async (req, res) =>
    ok(res, await updateTemplate(req.ctx, v(req).params.id, v(req).body), 'Template updated'),
  ),
);
r.post(
  '/platform/notification-templates/:id/preview',
  platformMiddleware(),
  canPlatform(PERM.platformSettingsView),
  validate({ params: s.idParam, body: s.preview }),
  h(async (req, res) => ok(res, await previewTemplate(v(req).params.id, v(req).body.data))),
);
r.get(
  '/platform/notification-deliveries',
  platformMiddleware(),
  canPlatform(PERM.platformHealthView),
  validate({ query: s.deliveries }),
  h(async (req, res) => {
    const out = await searchDeliveries(req.ctx, v(req).query);
    okList(res, out.data, out.pagination);
  }),
);

// ---- 8.37 messaging webhook: signature only (no cookie, no CSRF); 600 per minute per provider key
r.post(
  '/webhooks/messaging/:providerKey',
  publicRoute(),
  rateLimit({
    name: 'messaging-webhook',
    limit: 600,
    windowSeconds: 60,
    key: req => String(req.params.providerKey ?? 'unknown'),
  }),
  h(async (req, res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, val] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(val) ? val[0] : val;
    ok(res, await receiveWebhook(String(req.params.providerKey), req.rawBody, headers), 'Received');
  }),
);
