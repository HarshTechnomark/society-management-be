import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import * as autopay from './payments.autopay.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;
const list = (res: Response, r: { items: unknown[]; pagination: object }) =>
  res.status(200).json({ success: true, data: r.items, message: 'OK', pagination: r.pagination });

export const autopayController = {
  listMine: h(async (req, res) =>
    list(res, await autopay.listMine(req.ctx, v(req).query as Parameters<typeof autopay.listMine>[1])),
  ),
  create: h(async (req, res) =>
    created(
      res,
      await autopay.createMandate(req.ctx, v(req).body as autopay.MandateCreateInput),
      'Mandate started',
    ),
  ),
  pause: h(async (req, res) =>
    ok(
      res,
      await autopay.pauseMandate(
        req.ctx,
        v(req).params.id as number,
        (v(req).body as { version: number }).version,
      ),
      'Mandate paused',
    ),
  ),
  resume: h(async (req, res) =>
    ok(
      res,
      await autopay.resumeMandate(
        req.ctx,
        v(req).params.id as number,
        (v(req).body as { version: number }).version,
      ),
      'Mandate resumed',
    ),
  ),
  cancel: h(async (req, res) =>
    ok(
      res,
      await autopay.cancelMine(
        req.ctx,
        v(req).params.id as number,
        v(req).body as { version: number; reason?: string },
      ),
      'Mandate cancelled',
    ),
  ),
  listAdmin: h(async (req, res) =>
    list(res, await autopay.listAdmin(sid(req), v(req).query as Parameters<typeof autopay.listAdmin>[1])),
  ),
  cancelAdmin: h(async (req, res) =>
    ok(
      res,
      await autopay.cancelByAdmin(
        req.ctx,
        v(req).params.id as number,
        v(req).body as { version: number; reason: string },
      ),
      'Mandate cancelled',
    ),
  ),
};
