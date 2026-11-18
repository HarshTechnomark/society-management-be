import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok } from '../../utils/response';
import { listNoticeTemplates } from './communication.notices.templates';
import {
  audiencePreview,
  createNotice,
  deleteNotice,
  duplicateNotice,
  getNotice,
  listNotices,
  updateNotice,
} from './communication.notices.service';
import {
  archiveNotice,
  cancelSchedule,
  markRestored,
  pinNotice,
  publishNotice,
  recallNotice,
  remindNotice,
  unpinNotice,
  withdrawNotice,
} from './communication.notices.publish';
import {
  acknowledgeNotice,
  exportReceipts,
  listReceipts,
  noticeFileUrl,
} from './communication.notices.receipts';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid as { params: any; query: any; body: any };

export const noticeController = {
  list: h(async (req, res) => {
    const r = await listNotices(req.ctx, v(req).query);
    return res.status(200).json({ success: true, data: r.items, message: 'OK', pagination: r.pagination });
  }),
  create: h(async (req, res) => created(res, await createNotice(req.ctx, v(req).body), 'Draft saved')),
  templates: h(async (req, res) => ok(res, listNoticeTemplates(v(req).query.locale))),
  preview: h(async (req, res) => ok(res, await audiencePreview(req.ctx, v(req).body.audience))),
  detail: h(async (req, res) => ok(res, await getNotice(req.ctx, v(req).params.id))),
  patch: h(async (req, res) => ok(res, await updateNotice(req.ctx, v(req).params.id, v(req).body), 'Saved')),
  remove: h(async (req, res) => {
    await deleteNotice(req.ctx, v(req).params.id, v(req).query.version);
    return noContent(res);
  }),
  publish: h(async (req, res) => {
    const r = await publishNotice(req.ctx, v(req).params.id, v(req).body);
    return ok(res, r.notice, r.message);
  }),
  withdraw: h(async (req, res) =>
    ok(res, await withdrawNotice(req.ctx, v(req).params.id, v(req).body), 'Withdrawn'),
  ),
  cancelSchedule: h(async (req, res) =>
    ok(res, await cancelSchedule(req.ctx, v(req).params.id, v(req).body), 'Schedule cancelled'),
  ),
  recall: h(async (req, res) =>
    ok(res, await recallNotice(req.ctx, v(req).params.id, v(req).body), 'Recalled'),
  ),
  pin: h(async (req, res) =>
    ok(res, await pinNotice(req.ctx, v(req).params.id, v(req).body.version), 'Pinned'),
  ),
  unpin: h(async (req, res) =>
    ok(res, await unpinNotice(req.ctx, v(req).params.id, v(req).body.version), 'Unpinned'),
  ),
  archive: h(async (req, res) =>
    ok(res, await archiveNotice(req.ctx, v(req).params.id, v(req).body.version), 'Archived'),
  ),
  duplicate: h(async (req, res) =>
    created(res, await duplicateNotice(req.ctx, v(req).params.id), 'Copied to a new draft'),
  ),
  remind: h(async (req, res) =>
    ok(res, await remindNotice(req.ctx, v(req).params.id, v(req).body.version), 'Reminder queued'),
  ),
  restored: h(async (req, res) =>
    ok(res, await markRestored(req.ctx, v(req).params.id, v(req).body), 'Marked restored'),
  ),
  receipts: h(async (req, res) => {
    const r = await listReceipts(req.ctx, v(req).params.id, v(req).query);
    return res.status(200).json({ success: true, data: r.data, message: 'OK', pagination: r.pagination });
  }),
  receiptsExport: h(async (req, res) => {
    const r = await exportReceipts(req.ctx, v(req).params.id, v(req).query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    return res.status(200).send(r.csv);
  }),
  fileUrl: h(async (req, res) => {
    const p = v(req).params;
    return ok(res, await noticeFileUrl(req.ctx, p.id, p.fileId, v(req).query.disposition));
  }),
  acknowledge: h(async (req, res) =>
    ok(res, await acknowledgeNotice(req.ctx, v(req).params.id, v(req).body)),
  ),
};
