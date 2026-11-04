import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import * as svc from './billing.runs.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const runsController = {
  list: h(async (req, res) => {
    const r = await svc.listRuns(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  create: h(async (req, res) =>
    created(res, await svc.createRun(req.ctx, v(req).body), 'Billing run created; computing'),
  ),
  get: h(async (req, res) => ok(res, await svc.getRun(sid(req), v(req).params.id))),
  items: h(async (req, res) => {
    const r = await svc.listItems(sid(req), v(req).params.id, v(req).query);
    okList(res, r.data, r.pagination);
  }),
  patch: h(async (req, res) =>
    ok(res, await svc.patchRun(req.ctx, v(req).params.id, v(req).body), 'Billing run updated; computing'),
  ),
  recompute: h(async (req, res) =>
    ok(
      res,
      await svc.recomputeRun(req.ctx, v(req).params.id, v(req).body.version),
      'Billing run recomputing',
    ),
  ),
  exclude: h(async (req, res) =>
    ok(
      res,
      await svc.excludeItem(req.ctx, v(req).params.id, v(req).params.itemId, v(req).body),
      'Flat excluded',
    ),
  ),
  include: h(async (req, res) =>
    ok(
      res,
      await svc.includeItem(req.ctx, v(req).params.id, v(req).params.itemId, v(req).body),
      'Flat included',
    ),
  ),
  publish: h(async (req, res) => {
    const run = await svc.publishRun(req.ctx, v(req).params.id, v(req).body);
    ok(
      res,
      run,
      run.status === 'PENDING_APPROVAL' ? 'Sent for approval' : 'Approved; bills are being issued',
    );
  }),
  cancel: h(async (req, res) =>
    ok(res, await svc.cancelRun(req.ctx, v(req).params.id, v(req).body), 'Billing run cancelled'),
  ),
  resume: h(async (req, res) =>
    ok(res, await svc.resumeIssue(req.ctx, v(req).params.id, v(req).body.version), 'Issue resumed'),
  ),
};
