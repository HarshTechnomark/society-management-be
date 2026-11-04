import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok, okList } from '../../utils/response';
import * as activation from './committee.activation';
import * as changes from './committee.changes';
import * as handover from './committee.handover';
import * as resident from './committee.resident';
import * as staff from './committee.staff';
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
  activationPreview: h(async (req, res) =>
    ok(res, await activation.activationPreview(req.ctx, sid(req), v(req).params.id)),
  ),
  activate: h(async (req, res) => {
    const r = await activation.activate(req.ctx, sid(req), v(req).params.id, v(req).body);
    ok(res, r.data, r.message);
  }),
  changesPreview: h(async (req, res) =>
    ok(res, await changes.changesPreview(req.ctx, sid(req), v(req).params.id, v(req).body)),
  ),
  applyChanges: h(async (req, res) =>
    ok(
      res,
      await changes.applyChanges(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Committee changes saved',
    ),
  ),
  handover: h(async (req, res) => ok(res, await handover.getHandover(req.ctx, sid(req), v(req).params.id))),
  addHandoverItem: h(async (req, res) =>
    created(
      res,
      await handover.addItem(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Checklist item added',
    ),
  ),
  updateHandoverItem: h(async (req, res) =>
    ok(
      res,
      await handover.updateItem(req.ctx, sid(req), v(req).params.id, v(req).params.itemId, v(req).body),
      'Checklist item saved',
    ),
  ),
  seatUsage: h(async (req, res) => ok(res, await staff.seatUsage(sid(req)))),
  myCommittee: h(async (req, res) => ok(res, await resident.myCommittee(req.ctx, sid(req)))),
  myCommitteeHistory: h(async (req, res) => {
    const r = await resident.myCommitteeHistory(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
};
