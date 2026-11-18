import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  resetDefaults,
  updateRule,
} from './approvals.rules.service';
import { simulateRule } from './approvals.rules.simulate';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;

export const rulesController = {
  list: h(async (req, res) => {
    const data = await listRules(req.ctx, v(req).query);
    okList(res, data, { page: 1, limit: data.length || 1, total: data.length, totalPages: 1 });
  }),
  get: h(async (req, res) => ok(res, await getRule(req.ctx.society!.id, v(req).params.id))),
  create: h(async (req, res) => created(res, await createRule(req.ctx, v(req).body), 'Rule created')),
  patch: h(async (req, res) =>
    ok(res, await updateRule(req.ctx, v(req).params.id, v(req).body), 'Rule updated'),
  ),
  remove: h(async (req, res) =>
    ok(res, await deleteRule(req.ctx, v(req).params.id, v(req).body), 'Rule deleted'),
  ),
  reset: h(async (req, res) => {
    const r = await resetDefaults(req.ctx, v(req).body);
    // the rules are the data (8.15); the BR-14-32 warnings ride beside them
    res
      .status(200)
      .json({ success: true, data: r.rules, message: 'Defaults restored', warnings: r.warnings });
  }),
  simulate: h(async (req, res) => ok(res, await simulateRule(req.ctx, v(req).body))),
};
