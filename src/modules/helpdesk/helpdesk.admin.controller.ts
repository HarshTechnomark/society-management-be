import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok } from '../../utils/response';
import { exportTickets, listAssignees, listTickets, similarBuildingIssues } from './helpdesk.admin.list';
import {
  adminFileUrl,
  assign,
  createOnBehalf,
  deleteComment,
  getDetail,
  listComments,
  merge,
  patchTicket,
  postComment,
  reportBuildingIssue,
  sendEstimate,
  transition,
  unassign,
} from './helpdesk.admin.service';
import { defaultRange, summary } from './helpdesk.admin.stats';
import { toTicketDto } from './helpdesk.admin.dto';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid as { params: any; query: any; body: any };

export const adminController = {
  list: h(async (req, res) => {
    const r = await listTickets(req.ctx, v(req).query);
    return res.status(200).json({ success: true, data: r, message: 'OK', pagination: r.pagination });
  }),
  stats: h(async (req, res) => {
    const q = v(req).query;
    const range = await defaultRange(req.ctx.society!.id);
    return ok(res, await summary(req.ctx.society!.id, q.from ?? range.from, q.to ?? range.to, q));
  }),
  export: h(async (req, res) => {
    const r = await exportTickets(req.ctx, v(req).query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    return res.status(200).send(r.csv);
  }),
  assignees: h(async (req, res) => ok(res, await listAssignees(req.ctx, v(req).query))),
  detail: h(async (req, res) => ok(res, await getDetail(req.ctx, v(req).params.id))),
  create: h(async (req, res) => created(res, await createOnBehalf(req.ctx, v(req).body), 'Ticket raised')),
  buildingIssue: h(async (req, res) => {
    const t = await reportBuildingIssue(req.ctx, v(req).body, 'ADMIN');
    return created(res, await toTicketDto(req.ctx, t), 'Issue reported');
  }),
  similar: h(async (req, res) => ok(res, await similarBuildingIssues(req.ctx, v(req).query))),
  patch: h(async (req, res) => ok(res, await patchTicket(req.ctx, v(req).params.id, v(req).body), 'Saved')),
  assign: h(async (req, res) => ok(res, await assign(req.ctx, v(req).params.id, v(req).body), 'Assigned')),
  unassign: h(async (req, res) =>
    ok(res, await unassign(req.ctx, v(req).params.id, v(req).body), 'Unassigned'),
  ),
  transition: h(async (req, res) =>
    ok(res, await transition(req.ctx, v(req).params.id, v(req).body), 'Updated'),
  ),
  merge: h(async (req, res) => ok(res, await merge(req.ctx, v(req).params.id, v(req).body), 'Merged')),
  estimate: h(async (req, res) =>
    ok(res, await sendEstimate(req.ctx, v(req).params.id, v(req).body), 'Estimate sent'),
  ),
  comments: h(async (req, res) => ok(res, await listComments(req.ctx, v(req).params.id, v(req).query))),
  comment: h(async (req, res) => created(res, await postComment(req.ctx, v(req).params.id, v(req).body))),
  removeComment: h(async (req, res) => {
    const p = v(req).params;
    await deleteComment(req.ctx, p.id, p.commentId, v(req).body?.reason);
    return noContent(res);
  }),
  fileUrl: h(async (req, res) => {
    const p = v(req).params;
    return ok(res, await adminFileUrl(req.ctx, p.id, p.fileId, v(req).query.disposition));
  }),
};
