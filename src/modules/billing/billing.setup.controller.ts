import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import * as heads from './billing.heads.service';
import * as policies from './billing.latefee-policy.service';
import * as rules from './billing.rules.service';
import * as split from './billing.split.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

/** Controllers of 11.1 (sections 8.1 to 8.4): thin; the services hold the rules. */
export const billingSetupController = {
  // charge heads
  listHeads: h(async (req, res) => {
    const r = await heads.listHeads(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  createHead: h(async (req, res) =>
    created(res, await heads.createHead(req.ctx, sid(req), v(req).body), 'Charge head created'),
  ),
  updateHead: h(async (req, res) =>
    ok(res, await heads.updateHead(req.ctx, sid(req), v(req).params.id, v(req).body), 'Charge head saved'),
  ),
  archiveHead: h(async (req, res) =>
    ok(
      res,
      await heads.archiveHead(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Charge head archived',
    ),
  ),
  // billing rules
  listRules: h(async (req, res) => {
    const r = await rules.listRules(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  getRule: h(async (req, res) => ok(res, await rules.getRule(sid(req), v(req).params.id))),
  createRule: h(async (req, res) => {
    const rule = await rules.createRule(req.ctx, sid(req), v(req).body);
    created(res, rule, rule.currentVersion ? 'Billing rule created' : 'Billing rule sent for approval');
  }),
  updateRule: h(async (req, res) =>
    ok(res, await rules.updateRule(req.ctx, sid(req), v(req).params.id, v(req).body), 'Billing rule saved'),
  ),
  archiveRule: h(async (req, res) =>
    ok(
      res,
      await rules.archiveRule(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Billing rule archived',
    ),
  ),
  addVersion: h(async (req, res) => {
    const r = await rules.addVersion(req.ctx, sid(req), v(req).params.id, v(req).body);
    created(res, r.version, r.setupMode ? 'Rate saved' : 'Rule change sent for approval');
  }),
  // bill split rules
  listSplit: h(async (req, res) => {
    const r = await split.listSplitRules(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  createSplit: h(async (req, res) =>
    created(res, await split.createSplitRule(req.ctx, sid(req), v(req).body), 'Split rule created'),
  ),
  updateSplit: h(async (req, res) =>
    ok(
      res,
      await split.updateSplitRule(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Split rule saved',
    ),
  ),
  archiveSplit: h(async (req, res) =>
    ok(
      res,
      await split.archiveSplitRule(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Split rule archived',
    ),
  ),
  // late fee policies
  listPolicies: h(async (req, res) => {
    const r = await policies.listPolicies(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  createPolicy: h(async (req, res) => {
    const p = await policies.createPolicy(req.ctx, sid(req), v(req).body);
    created(res, p, p.status === 'ACTIVE' ? 'Late fee policy saved' : 'Late fee policy sent for approval');
  }),
};
