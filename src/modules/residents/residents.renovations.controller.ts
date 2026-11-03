import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import * as svc from './residents.renovations.service';
import { societyToday } from './residents.shared';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

/** Controllers of the renovation permit routes (8.16). The `/me` variants pass `RESIDENT` so the services check ownership. */
export const permitController = {
  create: (actor: svc.Actor) =>
    h(async (req, res) =>
      created(res, await svc.createPermit(req.ctx, sid(req), v(req).body, actor), 'Permit requested'),
    ),
  list: h(async (req, res) => {
    const r = await svc.listPermits(sid(req), { sortOrder: 'asc', ...v(req).query });
    okList(res, r.data, r.pagination);
  }),
  listMine: h(async (req, res) => {
    const r = await svc.listPermits(sid(req), { sortOrder: 'desc', ...v(req).query }, req.ctx.unitIds ?? []);
    okList(res, r.data, r.pagination);
  }),
  get: h(async (req, res) => ok(res, await svc.getPermit(sid(req), v(req).params.id))),
  patch: h(async (req, res) =>
    ok(res, await svc.patchPermit(req.ctx, sid(req), v(req).params.id, v(req).body), 'Permit saved'),
  ),
  resubmit: h(async (req, res) =>
    ok(res, await svc.resubmitPermit(req.ctx, sid(req), v(req).params.id, v(req).body), 'Permit resubmitted'),
  ),
  start: h(async (req, res) =>
    ok(res, await svc.startPermit(req.ctx, sid(req), v(req).params.id, v(req).body.version), 'Work started'),
  ),
  extend: h(async (req, res) =>
    ok(res, await svc.extendPermit(req.ctx, sid(req), v(req).params.id, v(req).body), 'Permit extended'),
  ),
  violation: h(async (req, res) =>
    ok(
      res,
      await svc.recordViolation(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Violation recorded',
    ),
  ),
  suspend: h(async (req, res) =>
    ok(res, await svc.suspendPermit(req.ctx, sid(req), v(req).params.id, v(req).body), 'Work stopped'),
  ),
  resume: h(async (req, res) =>
    ok(res, await svc.resumePermit(req.ctx, sid(req), v(req).params.id, v(req).body), 'Work resumed'),
  ),
  workDone: (actor: svc.Actor) =>
    h(async (req, res) =>
      ok(
        res,
        await svc.workDone(req.ctx, sid(req), v(req).params.id, v(req).body, actor),
        'Inspection requested',
      ),
    ),
  inspect: h(async (req, res) =>
    ok(res, await svc.inspectPermit(req.ctx, sid(req), v(req).params.id, v(req).body), 'Inspection saved'),
  ),
  cancel: (actor: svc.Actor) =>
    h(async (req, res) =>
      ok(
        res,
        await svc.cancelPermit(req.ctx, sid(req), v(req).params.id, v(req).body, actor),
        'Permit cancelled',
      ),
    ),
  gate: h(async (req, res) =>
    ok(res, await svc.listForGate(sid(req), v(req).query.date ?? (await societyToday(sid(req))))),
  ),
};
