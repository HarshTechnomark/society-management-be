import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import {
  reportBuildingIssue,
  reportResponse,
  qrPrefill,
  similarIssues,
  type Audience,
} from './helpdesk.building.service';
import {
  cancelMine,
  confirmMine,
  decideEstimateMine,
  escalateMine,
  rateMine,
  reopenMine,
} from './helpdesk.me.actions';
import {
  addMyComment,
  createMyComplaint,
  getMyTicket,
  listBuildingIssues,
  listMyComments,
  listMyTickets,
  myFileUrl,
  removeUpvoteMine,
  upvoteMine,
} from './helpdesk.me.service';
import { transparency } from './helpdesk.me.transparency';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;

const report = (audience: Audience) =>
  h(async (req, res) => {
    const made = await reportBuildingIssue(req.ctx, v(req).body, audience);
    const r = await reportResponse(req.ctx, audience, made);
    return created(res, r.data, r.message);
  });

const similar = (audience: Audience) =>
  h(async (req, res) => ok(res, await similarIssues(req.ctx, audience, v(req).query)));

/** Resident (`/me`), guard (`/gate`) and staff (`/work`) controllers of module 15.3. */
export const meController = {
  list: h(async (req, res) => {
    const r = await listMyTickets(req.ctx, v(req).query);
    return okList(res, r.items, r.pagination);
  }),
  get: h(async (req, res) => ok(res, await getMyTicket(req.ctx, v(req).params.id))),
  create: h(async (req, res) =>
    created(res, await createMyComplaint(req.ctx, v(req).body), 'Request raised'),
  ),
  buildingList: h(async (req, res) => {
    const r = await listBuildingIssues(req.ctx, v(req).query);
    return res
      .status(200)
      .json({ success: true, data: { items: r.items }, message: 'OK', pagination: r.pagination });
  }),
  qr: h(async (req, res) => ok(res, await qrPrefill(req.ctx, v(req).params.qrToken))),
  report: report('RESIDENT'),
  similar: similar('RESIDENT'),
  upvote: h(async (req, res) =>
    created(res, await upvoteMine(req.ctx, v(req).params.id, v(req).body.note), 'Noted'),
  ),
  removeUpvote: h(async (req, res) => ok(res, await removeUpvoteMine(req.ctx, v(req).params.id), 'Removed')),
  comments: h(async (req, res) => ok(res, await listMyComments(req.ctx, v(req).params.id, v(req).query))),
  addComment: h(async (req, res) =>
    created(res, await addMyComment(req.ctx, v(req).params.id, v(req).body), 'Comment added'),
  ),
  fileUrl: h(async (req, res) =>
    ok(res, await myFileUrl(req.ctx, v(req).params.id, v(req).params.fileId, v(req).query.disposition)),
  ),
  confirm: h(async (req, res) =>
    ok(res, await confirmMine(req.ctx, v(req).params.id, v(req).body), 'Closed'),
  ),
  rating: h(async (req, res) => ok(res, await rateMine(req.ctx, v(req).params.id, v(req).body), 'Thank you')),
  reopen: h(async (req, res) =>
    ok(res, await reopenMine(req.ctx, v(req).params.id, v(req).body), 'Reopened'),
  ),
  cancel: h(async (req, res) =>
    ok(res, await cancelMine(req.ctx, v(req).params.id, v(req).body), 'Cancelled'),
  ),
  escalate: h(async (req, res) =>
    ok(res, await escalateMine(req.ctx, v(req).params.id, v(req).body), 'Escalation requested'),
  ),
  estimate: h(async (req, res) =>
    ok(res, await decideEstimateMine(req.ctx, v(req).params.id, v(req).body), 'Decision saved'),
  ),
  transparency: h(async (req, res) => ok(res, await transparency(req.ctx, v(req).query.months))),
  gateReport: report('GATE'),
  gateSimilar: similar('GATE'),
  workReport: report('WORK'),
  workSimilar: similar('WORK'),
};
