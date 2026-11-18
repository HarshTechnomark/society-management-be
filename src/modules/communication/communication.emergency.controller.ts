import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import {
  activeFor,
  getBroadcastDetail,
  listBroadcasts,
  rollCall,
  toBroadcastDto,
} from './communication.emergency.read';
import {
  attendResponse,
  cancel,
  realert,
  recordResponse,
  resolve,
  sendUpdate,
  startBroadcast,
} from './communication.emergency.service';
import { startedByNames } from './communication.emergency.shared';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid as { params: any; query: any; body: any };

export const emergencyController = {
  start: h(async (req, res) => {
    const b = await startBroadcast(req.ctx, v(req).body);
    const dto = toBroadcastDto(b, await startedByNames([b.startedBy]));
    return created(res, dto, 'Emergency alert sent');
  }),
  list: h(async (req, res) => {
    const r = await listBroadcasts(req.ctx, v(req).query);
    return res.status(200).json({ success: true, data: r.data, message: 'OK', pagination: r.pagination });
  }),
  detail: h(async (req, res) => ok(res, await getBroadcastDetail(req.ctx, v(req).params.id))),
  rollCall: (gate: boolean) =>
    h(async (req, res) => {
      const r = await rollCall(req.ctx, v(req).params.id, v(req).query, { gate });
      return res
        .status(200)
        .json({ success: true, data: r.data, byFloor: r.byFloor, message: 'OK', pagination: r.pagination });
    }),
  update: h(async (req, res) =>
    ok(res, await sendUpdate(req.ctx, v(req).params.id, v(req).body), 'Update sent'),
  ),
  realert: h(async (req, res) =>
    ok(res, await realert(req.ctx, v(req).params.id, v(req).body), 'Re-alert sent'),
  ),
  resolve: h(async (req, res) =>
    ok(res, await resolve(req.ctx, v(req).params.id, v(req).body), 'All clear sent'),
  ),
  cancel: h(async (req, res) =>
    ok(res, await cancel(req.ctx, v(req).params.id, v(req).body), 'Alert cancelled'),
  ),
  respond: (via: 'APP' | 'GATE') =>
    h(async (req, res) =>
      created(res, await recordResponse(req.ctx, v(req).params.id, v(req).body, via), 'Response recorded'),
    ),
  attend: h(async (req, res) => {
    const p = v(req).params;
    return ok(res, await attendResponse(req.ctx, p.id, p.responseId, v(req).body), 'Marked attended');
  }),
  active: (mode: 'me' | 'gate') => h(async (req, res) => ok(res, await activeFor(req.ctx, mode))),
};
