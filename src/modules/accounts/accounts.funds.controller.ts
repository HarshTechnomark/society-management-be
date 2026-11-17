import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import { createFund, fundStatement, listFunds, patchFund } from './accounts.funds.service';
import { requestFundTransfer } from './accounts.funds.transfer';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const fundsController = {
  list: h(async (req, res) => ok(res, await listFunds(sid(req), v(req).query))),
  statement: h(async (req, res) => ok(res, await fundStatement(sid(req), v(req).params.id, v(req).query))),
  create: h(async (req, res) => created(res, await createFund(req.ctx, v(req).body), 'Fund created')),
  patch: h(async (req, res) =>
    ok(res, await patchFund(req.ctx, v(req).params.id, v(req).body), 'Fund updated'),
  ),
  transfer: h(async (req, res) => {
    const r = await requestFundTransfer(req.ctx, v(req).body);
    if (r.status === 'APPROVED') return created(res, r, 'Fund transfer posted');
    return ok(res, r, 'Sent for approval', 202);
  }),
};
