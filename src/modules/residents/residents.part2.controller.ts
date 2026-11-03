import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import * as joins from './residents.joins.service';
import * as tenancies from './residents.tenancies.service';
import * as moves from './residents.moves.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

/** Controllers of module 09 part 2: each reads the request and calls one service function. */
export const part2Controller = {
  // ---- tenancies (8.13)
  tenancyList: h(async (req, res) => {
    const r = await tenancies.listTenancies(req.ctx, sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  tenancyCreate: h(async (req, res) =>
    created(res, await tenancies.createTenancy(req.ctx, sid(req), v(req).body), 'Tenancy created'),
  ),
  tenancyGet: h(async (req, res) => ok(res, await tenancies.getTenancy(req.ctx, sid(req), v(req).params.id))),
  tenancyPatch: h(async (req, res) =>
    ok(res, await tenancies.patchTenancy(req.ctx, sid(req), v(req).params.id, v(req).body), 'Tenancy saved'),
  ),
  tenancySubmit: h(async (req, res) =>
    ok(
      res,
      await tenancies.submitTenancy(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Tenancy submitted',
    ),
  ),
  tenancyApprove: h(async (req, res) =>
    ok(
      res,
      await tenancies.approveTenancy(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Tenancy approved',
    ),
  ),
  tenancyReject: h(async (req, res) =>
    ok(
      res,
      await tenancies.rejectTenancy(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Tenancy rejected',
    ),
  ),
  tenancyActivate: h(async (req, res) =>
    ok(
      res,
      await tenancies.activateTenancy(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Tenancy activated',
    ),
  ),
  tenancyRenew: h(async (req, res) =>
    ok(
      res,
      await tenancies.renewTenancy(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Tenancy renewed',
    ),
  ),
  tenancyEnd: h(async (req, res) =>
    ok(res, await tenancies.endTenancy(req.ctx, sid(req), v(req).params.id, v(req).body), 'Tenancy ended'),
  ),
  tenancyCancel: h(async (req, res) =>
    ok(
      res,
      await tenancies.cancelTenancy(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Tenancy cancelled',
    ),
  ),
  police: h(async (req, res) =>
    ok(
      res,
      await tenancies.updatePoliceVerification(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Police verification saved',
    ),
  ),
  myTenancyList: h(async (req, res) => ok(res, await tenancies.listMyTenancies(req.ctx, sid(req)))),
  myTenancyGet: h(async (req, res) =>
    ok(res, await tenancies.getMyTenancy(req.ctx, sid(req), v(req).params.id)),
  ),
  myTenancyCreate: h(async (req, res) =>
    created(
      res,
      await tenancies.createTenancy(req.ctx, sid(req), v(req).body, { mine: true }),
      'Tenancy created',
    ),
  ),
  myTenancySubmit: h(async (req, res) =>
    ok(
      res,
      await tenancies.submitTenancy(req.ctx, sid(req), v(req).params.id, v(req).body, { mine: true }),
      'Tenancy submitted',
    ),
  ),
  myTenancyCancel: h(async (req, res) =>
    ok(
      res,
      await tenancies.cancelTenancy(req.ctx, sid(req), v(req).params.id, v(req).body, { mine: true }),
      'Tenancy cancelled',
    ),
  ),
  myTenancyDocs: h(async (req, res) =>
    created(
      res,
      await tenancies.attachMyTenancyDocuments(req.ctx, sid(req), v(req).params.id, v(req).body.fileIds),
      'Documents added',
    ),
  ),

  // ---- join requests (8.14)
  joinSociety: h(async (req, res) => ok(res, await joins.lookupSociety(v(req).params.code))),
  joinUnits: h(async (req, res) => ok(res, await joins.searchUnits(v(req).params.code, v(req).query.q))),
  joinSubmit: h(async (req, res) => {
    const r = await joins.submitJoinRequest(req.ctx, v(req).body);
    const { message, ...data } = r;
    created(res, data, message);
  }),
  joinMine: h(async (req, res) => ok(res, await joins.listMine(req.ctx))),
  joinWithdraw: h(async (req, res) =>
    ok(res, await joins.withdraw(req.ctx, v(req).params.id, v(req).body), 'Request withdrawn'),
  ),
  joinConfirmList: h(async (req, res) => ok(res, await joins.listForConfirmer(req.ctx, sid(req)))),
  joinConfirm: h(async (req, res) =>
    ok(res, await joins.confirm(req.ctx, sid(req), v(req).params.id, v(req).body), 'Request confirmed'),
  ),
  joinDecline: h(async (req, res) =>
    ok(res, await joins.decline(req.ctx, sid(req), v(req).params.id, v(req).body), 'Request declined'),
  ),
  joinList: h(async (req, res) => {
    const r = await joins.listJoinRequests(req.ctx, sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  joinGet: h(async (req, res) => ok(res, await joins.getJoinRequest(req.ctx, sid(req), v(req).params.id))),

  // ---- move requests (8.15)
  moveList: h(async (req, res) => {
    const r = await moves.listMoves(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  moveCreate: h(async (req, res) =>
    created(res, await moves.createMove(req.ctx, sid(req), v(req).body), 'Move request created'),
  ),
  moveGet: h(async (req, res) => ok(res, await moves.getMove(sid(req), v(req).params.id))),
  movePatch: h(async (req, res) =>
    ok(res, await moves.patchMove(req.ctx, sid(req), v(req).params.id, v(req).body), 'Move request saved'),
  ),
  moveRecheck: h(async (req, res) =>
    ok(res, await moves.recheckDues(req.ctx, sid(req), v(req).params.id, v(req).body), 'Dues checked'),
  ),
  moveOverride: h(async (req, res) =>
    ok(res, await moves.overrideDues(req.ctx, sid(req), v(req).params.id, v(req).body), 'Dues overridden'),
  ),
  moveStart: h(async (req, res) =>
    ok(res, await moves.startMove(req.ctx, sid(req), v(req).params.id, v(req).body), 'Move started'),
  ),
  moveComplete: h(async (req, res) =>
    ok(res, await moves.completeMove(req.ctx, sid(req), v(req).params.id, v(req).body), 'Move completed'),
  ),
  moveInspect: h(async (req, res) =>
    ok(res, await moves.inspectMove(req.ctx, sid(req), v(req).params.id, v(req).body), 'Inspection saved'),
  ),
  moveCancel: h(async (req, res) =>
    ok(res, await moves.cancelMove(req.ctx, sid(req), v(req).params.id, v(req).body), 'Move cancelled'),
  ),
  myMoveList: h(async (req, res) => ok(res, await moves.listMyMoves(req.ctx, sid(req)))),
  myMoveGet: h(async (req, res) => ok(res, await moves.getMyMove(req.ctx, sid(req), v(req).params.id))),
  myMoveCreate: h(async (req, res) =>
    created(
      res,
      await moves.createMove(req.ctx, sid(req), v(req).body, { mine: true }),
      'Move request created',
    ),
  ),
  myMovePatch: h(async (req, res) =>
    ok(
      res,
      await moves.patchMove(req.ctx, sid(req), v(req).params.id, v(req).body, { mine: true }),
      'Move request saved',
    ),
  ),
  myMoveRecheck: h(async (req, res) =>
    ok(
      res,
      await moves.recheckDues(req.ctx, sid(req), v(req).params.id, v(req).body, { mine: true }),
      'Dues checked',
    ),
  ),
  myMoveConfirm: h(async (req, res) =>
    ok(res, await moves.ownerConfirm(req.ctx, sid(req), v(req).params.id, v(req).body), 'Move confirmed'),
  ),
  myMoveDecline: h(async (req, res) =>
    ok(res, await moves.ownerDecline(req.ctx, sid(req), v(req).params.id, v(req).body), 'Move declined'),
  ),
  myMoveCancel: h(async (req, res) =>
    ok(
      res,
      await moves.cancelMove(req.ctx, sid(req), v(req).params.id, v(req).body, { mine: true }),
      'Move cancelled',
    ),
  ),
  gateList: h(async (req, res) => ok(res, await moves.gateList(sid(req), v(req).query.date))),
  gateStart: h(async (req, res) =>
    ok(
      res,
      await moves.startMove(req.ctx, sid(req), v(req).params.id, v(req).body, { gate: true }),
      'Move started',
    ),
  ),
  gateComplete: h(async (req, res) =>
    ok(res, await moves.completeMove(req.ctx, sid(req), v(req).params.id, v(req).body), 'Move completed'),
  ),
};
