import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import * as refunds from './payments.refunds.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const refundController = {
  list: h(async (req, res) => {
    const r = await refunds.listRefunds(sid(req), v(req).query as refunds.RefundListQuery);
    res.status(200).json({ success: true, data: r.items, message: 'OK', pagination: r.pagination });
  }),
  get: h(async (req, res) => ok(res, await refunds.getRefund(sid(req), v(req).params.id as number))),
  create: h(async (req, res) =>
    created(
      res,
      await refunds.requestRefund(req.ctx, v(req).body as refunds.RefundRequestInput),
      'Refund requested and waiting for approval',
    ),
  ),
  complete: h(async (req, res) =>
    ok(
      res,
      await refunds.completeRefund(
        req.ctx,
        v(req).params.id as number,
        v(req).body as { paidOutOn: string; bankReference?: string; version: number },
      ),
      'Refund recorded as paid out',
    ),
  ),
};
