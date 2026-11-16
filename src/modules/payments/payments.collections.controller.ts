import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok, okList } from '../../utils/response';
import {
  collectionDetail,
  createCollection,
  deleteCollection,
  listCollections,
  patchCollection,
} from './payments.collections.service';
import {
  addRequests,
  collectionStatement,
  exportRequests,
  listRequests,
  waiveRequest,
} from './payments.collections.requests';
import { getMyCollection, listMyCollections } from './payments.collections.resident';
import {
  cancelCollection,
  closeCollection,
  publishCollection,
  remindCollection,
  submitCollection,
} from './payments.collections.workflow';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const collectionsController = {
  list: h(async (req, res) => {
    const r = await listCollections(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  get: h(async (req, res) => ok(res, await collectionDetail(sid(req), v(req).params.id))),
  create: h(async (req, res) =>
    created(res, await createCollection(req.ctx, v(req).body), 'Collection created'),
  ),
  patch: h(async (req, res) =>
    ok(res, await patchCollection(req.ctx, v(req).params.id, v(req).body), 'Collection updated'),
  ),
  remove: h(async (req, res) => {
    await deleteCollection(req.ctx, v(req).params.id, v(req).query.version);
    return noContent(res);
  }),
  submit: h(async (req, res) =>
    ok(res, await submitCollection(req.ctx, v(req).params.id, v(req).body.version), 'Sent for approval'),
  ),
  publish: h(async (req, res) =>
    ok(res, await publishCollection(req.ctx, v(req).params.id, v(req).body.version), 'Collection published'),
  ),
  remind: h(async (req, res) =>
    ok(res, await remindCollection(req.ctx, v(req).params.id, v(req).body.version), 'Reminder sent'),
  ),
  close: h(async (req, res) =>
    ok(
      res,
      await closeCollection(req.ctx, v(req).params.id, v(req).body.version, v(req).body.reason),
      'Collection closed',
    ),
  ),
  cancel: h(async (req, res) =>
    ok(
      res,
      await cancelCollection(req.ctx, v(req).params.id, v(req).body.version, v(req).body.reason),
      'Collection cancelled',
    ),
  ),
  requests: h(async (req, res) => {
    const r = await listRequests(sid(req), v(req).params.id, v(req).query);
    okList(res, r.data, r.pagination);
  }),
  addRequests: h(async (req, res) =>
    ok(res, await addRequests(req.ctx, v(req).params.id, v(req).body), 'Flats added'),
  ),
  exportRequests: h(async (req, res) => {
    const r = await exportRequests(req.ctx, v(req).params.id, v(req).query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(r.csv);
  }),
  waive: h(async (req, res) =>
    ok(res, await waiveRequest(req.ctx, v(req).params.id, v(req).body), 'Request waived'),
  ),
  statement: h(async (req, res) =>
    ok(res, await collectionStatement(req.ctx, v(req).params.id, v(req).query.format)),
  ),
  meList: h(async (req, res) => ok(res, await listMyCollections(req.ctx))),
  meGet: h(async (req, res) => ok(res, await getMyCollection(req.ctx, v(req).params.id))),
};
