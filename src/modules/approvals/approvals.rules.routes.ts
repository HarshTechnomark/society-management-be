import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './approvals.constants';
import { rulesController as c } from './approvals.rules.controller';
import { delegationsController as dc } from './approvals.delegations.controller';
import { settingsController as sc } from './approvals.settings.controller';
import {
  delegationSchemas as ds,
  ruleSchemas as s,
  settingsSchemas as ss,
} from './approvals.rules.validation';

/**
 * Sub-module 14.2b routes (sections 8.12 to 8.18): rules, simulate, settings and delegations. Order on a route: society
 * marker, permission, entitlement, validate, step-up, idempotency (create only). Mount this router BEFORE the inbox router so
 * `/approvals/rules`, `/approvals/settings` and `/approvals/delegations` are matched before `/approvals/:id`.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
/** `simulate` is a POST that writes nothing: it stays available while the society is suspended. */
const readOnlyPost = () => routeMeta({ suspended: 'allow' });

export const approvalsRulesRoutes = Router();
const r = approvalsRulesRoutes;
const F = ENT.unifiedInbox;

// ---- rules (8.12 to 8.16); static paths before `/rules/:id`
r.get(
  '/approvals/rules',
  society(),
  can(PERM.rulesView),
  feature(F, read),
  validate({ query: s.list }),
  c.list,
);
r.post(
  '/approvals/rules/reset-defaults',
  society(),
  can(PERM.rulesEdit),
  feature(F),
  validate({ body: s.reset }),
  stepUp(),
  c.reset,
);
r.post(
  '/approvals/rules/simulate',
  readOnlyPost(),
  society(),
  can(PERM.rulesView),
  feature(F, read),
  validate({ body: s.simulate }),
  c.simulate,
);
r.post(
  '/approvals/rules',
  society(),
  can(PERM.rulesEdit),
  feature(F),
  validate({ body: s.create }),
  stepUp(),
  idempotency(),
  c.create,
);
r.get(
  '/approvals/rules/:id',
  society(),
  can(PERM.rulesView),
  feature(F, read),
  validate({ params: s.idParam }),
  c.get,
);
r.patch(
  '/approvals/rules/:id',
  society(),
  can(PERM.rulesEdit),
  feature(F),
  validate({ params: s.idParam, body: s.patch }),
  stepUp(),
  c.patch,
);
r.delete(
  '/approvals/rules/:id',
  society(),
  can(PERM.rulesEdit),
  feature(F),
  validate({ params: s.idParam, body: s.remove }),
  stepUp(),
  c.remove,
);

// ---- settings (8.17)
r.get('/approvals/settings', society(), can(PERM.rulesView), feature(F, read), sc.get);
r.patch(
  '/approvals/settings',
  society(),
  can(PERM.rulesEdit),
  feature(F),
  validate({ body: ss.patch }),
  stepUp(),
  sc.patch,
);

// ---- delegations (8.18); creating needs the plan feature, revoking stays available after a downgrade
r.get(
  '/approvals/delegations',
  society(),
  can(PERM.inboxView, PERM.rulesView),
  feature(F, read),
  validate({ query: ds.list }),
  dc.list,
);
r.post(
  '/approvals/delegations',
  society(),
  can(PERM.inboxView, PERM.rulesEdit),
  feature(ENT.delegation),
  validate({ body: ds.create }),
  stepUp(),
  idempotency(),
  dc.create,
);
r.post(
  '/approvals/delegations/:id/revoke',
  society(),
  can(PERM.inboxView, PERM.rulesEdit),
  feature(F, read),
  validate({ params: ds.idParam, body: ds.revoke }),
  dc.revoke,
);
