import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok } from '../../utils/response';
import { getMine, listMine, respond } from './communication.surveys.me';
import { exportResults, getResults } from './communication.surveys.results';
import {
  cancelSurvey,
  closeSurvey,
  createSurvey,
  deleteSurvey,
  getSurvey,
  listSurveys,
  patchSurvey,
  publishSurvey,
} from './communication.surveys.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid as { params: any; query: any; body: any };

export const surveyController = {
  list: h(async (req, res) => {
    const r = await listSurveys(req.ctx, v(req).query);
    return res.status(200).json({ success: true, data: r.data, message: 'OK', pagination: r.pagination });
  }),
  create: h(async (req, res) => created(res, await createSurvey(req.ctx, v(req).body), 'Survey saved')),
  detail: h(async (req, res) => ok(res, await getSurvey(req.ctx, v(req).params.id))),
  patch: h(async (req, res) => ok(res, await patchSurvey(req.ctx, v(req).params.id, v(req).body), 'Saved')),
  remove: h(async (req, res) => {
    await deleteSurvey(req.ctx, v(req).params.id, v(req).query.version);
    return noContent(res);
  }),
  publish: h(async (req, res) =>
    ok(res, await publishSurvey(req.ctx, v(req).params.id, v(req).body), 'Survey published'),
  ),
  close: h(async (req, res) =>
    ok(res, await closeSurvey(req.ctx, v(req).params.id, v(req).body.version), 'Survey closed'),
  ),
  cancel: h(async (req, res) =>
    ok(res, await cancelSurvey(req.ctx, v(req).params.id, v(req).body), 'Survey cancelled'),
  ),
  results: h(async (req, res) => ok(res, await getResults(req.ctx, v(req).params.id))),
  export: h(async (req, res) => {
    const r = await exportResults(req.ctx, v(req).params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    return res.status(200).send(r.csv);
  }),
  mine: h(async (req, res) => ok(res, await listMine(req.ctx))),
  mineDetail: h(async (req, res) => ok(res, await getMine(req.ctx, v(req).params.id))),
  respond: h(async (req, res) =>
    created(res, await respond(req.ctx, v(req).params.id, v(req).body), 'Response submitted'),
  ),
};
