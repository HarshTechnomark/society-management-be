import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import * as svc from './accounts.settlements.service';
import { importSettlements, type ReportSettlement } from './accounts.settlements.import';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const settlementController = {
  list: h(async (req, res) => {
    const r = await svc.listSettlements(sid(req), v(req).query as Parameters<typeof svc.listSettlements>[1]);
    res.status(200).json({ success: true, data: r.items, message: 'OK', pagination: r.pagination });
  }),
  get: h(async (req, res) => ok(res, await svc.getSettlement(sid(req), v(req).params.id as number))),
  import: h(async (req, res) => {
    const b = v(req).body as { gatewayProvider: string; fileId?: number; settlements?: ReportSettlement[] };
    const r = await importSettlements(req.ctx, b);
    ok(res, r, 'Settlement report imported', 202);
  }),
  reconcile: h(async (req, res) =>
    ok(res, await svc.reconcileNow(req.ctx, v(req).params.id as number), 'Settlement posted'),
  ),
  accept: h(async (req, res) =>
    ok(
      res,
      await svc.acceptDifference(
        req.ctx,
        v(req).params.id as number,
        v(req).body as { reason: string; version: number },
      ),
      'Difference accepted and settlement posted',
    ),
  ),
};
