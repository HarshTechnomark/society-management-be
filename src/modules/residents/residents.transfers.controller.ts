import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import * as svc from './residents.transfers.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

/** Controllers of the ownership transfer routes (8.17). The `/me` variants pass `RESIDENT`. */
export const transferController = {
  create: (actor: svc.Actor) =>
    h(async (req, res) =>
      created(res, await svc.createTransfer(req.ctx, sid(req), v(req).body, actor), 'Transfer drafted'),
    ),
  list: h(async (req, res) => {
    const r = await svc.listTransfers(sid(req), { sortOrder: 'desc', ...v(req).query });
    okList(res, r.data, r.pagination);
  }),
  listMine: h(async (req, res) => {
    const r = await svc.listTransfers(
      sid(req),
      { sortOrder: 'desc', ...v(req).query },
      req.ctx.unitIds ?? [],
    );
    okList(res, r.data, r.pagination);
  }),
  get: h(async (req, res) => ok(res, await svc.getTransfer(sid(req), v(req).params.id))),
  patch: (actor: svc.Actor) =>
    h(async (req, res) =>
      ok(
        res,
        await svc.patchTransfer(req.ctx, sid(req), v(req).params.id, v(req).body, actor),
        'Transfer saved',
      ),
    ),
  submit: (actor: svc.Actor) =>
    h(async (req, res) =>
      ok(
        res,
        await svc.submitTransfer(req.ctx, sid(req), v(req).params.id, v(req).body.version, actor),
        'Transfer submitted',
      ),
    ),
  complete: h(async (req, res) =>
    ok(
      res,
      await svc.completeTransfer(req.ctx, sid(req), v(req).params.id, v(req).body.version),
      'Transfer completed',
    ),
  ),
  cancel: (actor: svc.Actor) =>
    h(async (req, res) =>
      ok(
        res,
        await svc.cancelTransfer(req.ctx, sid(req), v(req).params.id, v(req).body, actor),
        'Transfer cancelled',
      ),
    ),
};
