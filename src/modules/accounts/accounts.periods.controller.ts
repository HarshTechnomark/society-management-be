import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import * as periods from './accounts.periods.service';
import { societyIdOf } from './accounts.shared';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;

export const periodController = {
  get: h(async (req, res) => ok(res, await periods.getPeriods(societyIdOf(req.ctx)))),
  lock: h(async (req, res) =>
    ok(
      res,
      await periods.lockPeriod(req.ctx, v(req).body as { lockThrough: string; version: number }),
      'Books locked',
    ),
  ),
  unlock: h(async (req, res) => {
    const r = await periods.requestUnlock(
      req.ctx,
      v(req).body as { fromDate: string; hours: number; reason: string },
    );
    res.status(r.status === 'APPROVED' ? 200 : 202).json({
      success: true,
      data: r,
      message: r.status === 'APPROVED' ? 'Books unlocked' : 'Unlock requested and waiting for approval',
    });
  }),
  relock: h(async (req, res) =>
    ok(res, await periods.relockPeriod(req.ctx, v(req).body as { version: number }), 'Books locked again'),
  ),
  close: h(async (req, res) => {
    const r = await periods.requestYearClose(
      req.ctx,
      v(req).params.fy as string,
      v(req).body as { confirm: true; version: number },
    );
    res.status(202).json({ success: true, data: r, message: 'Year close started' });
  }),
};
