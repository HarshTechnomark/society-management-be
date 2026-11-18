import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { entityHistory } from './approvals.history.service';
import { requestDetail } from './approvals.inbox.detail';
import {
  approveRequest,
  bulkApprove,
  cancelMine,
  cancelRequest,
  reassignRequest,
  rejectRequest,
} from './approvals.inbox.decisions';
import { inboxCounts, listInbox, listSubmitted, listTypes, type Page } from './approvals.inbox.service';
import { getMine, listMine } from './approvals.resident.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;

/** List envelope with the `meta.truncated` flag of 8.1. */
const okPage = (res: Response, p: Page<unknown>): Response =>
  res
    .status(200)
    .json({ success: true, data: p.data, message: 'OK', pagination: p.pagination, meta: p.meta });

export const inboxController = {
  list: h(async (req, res) => okPage(res, await listInbox(req.ctx, v(req).query))),
  submitted: h(async (req, res) => okPage(res, await listSubmitted(req.ctx, v(req).query))),
  counts: h(async (req, res) => ok(res, await inboxCounts(req.ctx.society!.id, req.ctx.user!.id))),
  types: h(async (_req, res) => ok(res, listTypes())),
  history: h(async (req, res) => ok(res, await entityHistory(req.ctx, v(req).query))),
  detail: h(async (req, res) => ok(res, await requestDetail(req.ctx, v(req).params.id))),
  approve: h(async (req, res) => {
    const r = await approveRequest(req.ctx, v(req).params.id, v(req).body);
    return ok(res, r.data, r.message);
  }),
  reject: h(async (req, res) =>
    ok(res, await rejectRequest(req.ctx, v(req).params.id, 'reject', v(req).body), 'Rejected'),
  ),
  requestChanges: h(async (req, res) =>
    ok(res, await rejectRequest(req.ctx, v(req).params.id, 'changes', v(req).body), 'Sent back for changes'),
  ),
  cancel: h(async (req, res) =>
    ok(res, await cancelRequest(req.ctx, v(req).params.id, v(req).body), 'Cancelled'),
  ),
  reassign: h(async (req, res) =>
    ok(res, await reassignRequest(req.ctx, v(req).params.id, v(req).body), 'Reassigned'),
  ),
  bulk: h(async (req, res) => {
    const r = await bulkApprove(req.ctx, v(req).body.items);
    return ok(res, r.data, r.message);
  }),
  meList: h(async (req, res) => {
    const r = await listMine(req.ctx, v(req).query);
    return res.status(200).json({ success: true, data: r.data, message: 'OK', pagination: r.pagination });
  }),
  meGet: h(async (req, res) => ok(res, await getMine(req.ctx, v(req).params.id))),
  meCancel: h(async (req, res) =>
    ok(res, await cancelMine(req.ctx, v(req).params.id, v(req).body), 'Request withdrawn'),
  ),
};
