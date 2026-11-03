import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok, okList } from '../../utils/response';
import * as queries from './committee.queries';
import * as svc from './committee.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const committeeController = {
  overview: h(async (req, res) => ok(res, await queries.overview(sid(req)))),
  list: h(async (req, res) => {
    const r = await queries.listTerms(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  get: h(async (req, res) => ok(res, await queries.getTerm(req.ctx, sid(req), v(req).params.id))),
  create: h(async (req, res) => {
    const term = await svc.createTerm(req.ctx, sid(req), v(req).body);
    created(
      res,
      term,
      v(req).body.source === 'HISTORICAL' ? 'Past committee recorded' : 'Draft committee saved',
    );
  }),
  update: h(async (req, res) =>
    ok(res, await svc.updateTerm(req.ctx, sid(req), v(req).params.id, v(req).body), 'Committee saved'),
  ),
  remove: h(async (req, res) => {
    await svc.deleteTerm(req.ctx, sid(req), v(req).params.id, v(req).body);
    noContent(res);
  }),
  patchSeat: h(async (req, res) =>
    ok(
      res,
      await svc.patchSeat(req.ctx, sid(req), v(req).params.id, v(req).params.seatId, v(req).body),
      'Seat saved',
    ),
  ),
};
