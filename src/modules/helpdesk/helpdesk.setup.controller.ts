import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import {
  archiveCategory,
  createCategory,
  listCategories,
  listCategoriesFor,
  restoreCategory,
  updateCategory,
} from './helpdesk.categories.service';
import { archivePolicy, createPolicy, listPolicies, updatePolicy } from './helpdesk.policies.service';
import { createRule, deleteRule, listRules, updateRule } from './helpdesk.rules.admin.service';
import { getHelpdeskSettings, updateHelpdeskSettings } from './helpdesk.setup.settings';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const idOf = (req: Request): number => (req.valid.params as { id: number }).id;

export const setupController = {
  // categories
  listCategories: h(async (req, res) => ok(res, await listCategories(req.ctx, req.valid.query as never))),
  listCategoriesFor: h(async (req, res) =>
    ok(res, await listCategoriesFor(req.ctx, (req.valid.query as { kind: 'PERSONAL' | 'BUILDING' }).kind)),
  ),
  listBuildingCategories: h(async (req, res) => ok(res, await listCategoriesFor(req.ctx, 'BUILDING'))),
  createCategory: h(async (req, res) =>
    created(res, await createCategory(req.ctx, req.valid.body as never), 'Category created'),
  ),
  updateCategory: h(async (req, res) =>
    ok(res, await updateCategory(req.ctx, idOf(req), req.valid.body as never), 'Category updated'),
  ),
  archiveCategory: h(async (req, res) =>
    ok(
      res,
      await archiveCategory(req.ctx, idOf(req), (req.valid.body as { version: number }).version),
      'Category archived',
    ),
  ),
  restoreCategory: h(async (req, res) =>
    ok(
      res,
      await restoreCategory(req.ctx, idOf(req), (req.valid.body as { version: number }).version),
      'Category restored',
    ),
  ),
  // SLA policies
  listPolicies: h(async (req, res) =>
    ok(
      res,
      await listPolicies(req.ctx, (req.valid.query as { status: 'ACTIVE' | 'ARCHIVED' | 'ALL' }).status),
    ),
  ),
  createPolicy: h(async (req, res) =>
    created(res, await createPolicy(req.ctx, req.valid.body as never), 'SLA policy created'),
  ),
  updatePolicy: h(async (req, res) =>
    ok(res, await updatePolicy(req.ctx, idOf(req), req.valid.body as never), 'SLA policy updated'),
  ),
  archivePolicy: h(async (req, res) =>
    ok(
      res,
      await archivePolicy(req.ctx, idOf(req), (req.valid.body as { version: number }).version),
      'SLA policy archived',
    ),
  ),
  // escalation rules
  listRules: h(async (req, res) =>
    ok(res, await listRules(req.ctx, (req.valid.query as { status: 'ACTIVE' | 'INACTIVE' | 'ALL' }).status)),
  ),
  createRule: h(async (req, res) =>
    created(res, await createRule(req.ctx, req.valid.body as never), 'Escalation rule created'),
  ),
  updateRule: h(async (req, res) =>
    ok(res, await updateRule(req.ctx, idOf(req), req.valid.body as never), 'Escalation rule updated'),
  ),
  deleteRule: h(async (req, res) => {
    await deleteRule(req.ctx, idOf(req), (req.valid.query as { version: number }).version);
    return ok(res, { id: idOf(req) }, 'Escalation rule deleted');
  }),
  // settings
  getSettings: h(async (req, res) => ok(res, await getHelpdeskSettings(req.ctx))),
  patchSettings: h(async (req, res) =>
    ok(
      res,
      await updateHelpdeskSettings(req.ctx, (req.valid.body as { changes: never[] }).changes),
      'Helpdesk settings updated',
    ),
  ),
};
