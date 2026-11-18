import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { ENT, PERM } from './helpdesk.constants';
import { setupController as c } from './helpdesk.setup.controller';
import { setupSchemas as s } from './helpdesk.setup.validation';

/**
 * Part 15.1 routes (sections 8.1 to 8.6): ticket categories, SLA policies, escalation rules and `helpdesk.*` settings, plus the
 * category lists of the resident, gate and staff apps. Order: society marker, permission, entitlement, validate, idempotency (create only).
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

export const helpdeskSetupRoutes = Router();
const r = helpdeskSetupRoutes;

// ---- categories (static paths before `/:id`)
r.get(
  '/ticket-categories',
  society(),
  can(PERM.settingsView, PERM.ticketsView),
  feature(ENT.categoryCatalogue, read),
  validate({ query: s.category.list }),
  c.listCategories,
);
r.post(
  '/ticket-categories',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.categoryCatalogue),
  validate({ body: s.category.create }),
  idempotency(),
  c.createCategory,
);
r.patch(
  '/ticket-categories/:id',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.categoryCatalogue),
  validate({ params: s.idParam, body: s.category.patch }),
  c.updateCategory,
);
r.post(
  '/ticket-categories/:id/archive',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.categoryCatalogue),
  validate({ params: s.idParam, body: s.versionBody }),
  c.archiveCategory,
);
r.post(
  '/ticket-categories/:id/restore',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.categoryCatalogue),
  validate({ params: s.idParam, body: s.versionBody }),
  c.restoreCategory,
);

// ---- category lists of the apps (active only, no assignee fields)
r.get(
  '/me/ticket-categories',
  society(),
  can(PERM.residentView, PERM.residentCreate),
  feature(ENT.categoryCatalogue, read),
  validate({ query: s.category.kind }),
  c.listCategoriesFor,
);
r.get(
  '/gate/ticket-categories',
  society(),
  can(PERM.gateBuildingIssues),
  feature(ENT.buildingIssueByAnyone, read),
  c.listBuildingCategories,
);
r.get(
  '/work/ticket-categories',
  society(),
  can(PERM.workBuildingIssues),
  feature(ENT.buildingIssueByAnyone, read),
  c.listBuildingCategories,
);

// ---- SLA policies
r.get(
  '/sla-policies',
  society(),
  can(PERM.settingsView),
  feature(ENT.slaPolicies, read),
  validate({ query: s.policy.list }),
  c.listPolicies,
);
r.post(
  '/sla-policies',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.slaPolicies),
  validate({ body: s.policy.create }),
  idempotency(),
  c.createPolicy,
);
r.patch(
  '/sla-policies/:id',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.slaPolicies),
  validate({ params: s.idParam, body: s.policy.patch }),
  c.updatePolicy,
);
r.post(
  '/sla-policies/:id/archive',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.slaPolicies),
  validate({ params: s.idParam, body: s.versionBody }),
  c.archivePolicy,
);

// ---- escalation rules
r.get(
  '/escalation-rules',
  society(),
  can(PERM.settingsView),
  feature(ENT.escalationMatrix, read),
  validate({ query: s.rule.list }),
  c.listRules,
);
r.post(
  '/escalation-rules',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.escalationMatrix),
  validate({ body: s.rule.create }),
  idempotency(),
  c.createRule,
);
r.patch(
  '/escalation-rules/:id',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.escalationMatrix),
  validate({ params: s.idParam, body: s.rule.patch }),
  c.updateRule,
);
r.delete(
  '/escalation-rules/:id',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.escalationMatrix),
  validate({ params: s.idParam, query: s.rule.remove }),
  c.deleteRule,
);

// ---- settings
r.get(
  '/helpdesk/settings',
  society(),
  can(PERM.settingsView),
  feature(ENT.categoryCatalogue, read),
  c.getSettings,
);
r.patch(
  '/helpdesk/settings',
  society(),
  can(PERM.settingsEdit),
  feature(ENT.categoryCatalogue),
  validate({ body: s.settings.patch }),
  c.patchSettings,
);
