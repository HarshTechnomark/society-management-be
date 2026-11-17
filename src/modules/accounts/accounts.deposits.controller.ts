import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import * as deposits from './accounts.deposits.service';
import type { DepositKind, DepositRefundMode } from './accounts.constants';
import { societyIdOf } from './accounts.shared';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;

export const depositController = {
  list: h(async (req, res) => {
    const r = await deposits.listDeposits(societyIdOf(req.ctx), v(req).query as deposits.DepositListQuery);
    res.status(200).json({ success: true, data: r.items, message: 'OK', pagination: r.pagination });
  }),
  get: h(async (req, res) =>
    ok(res, await deposits.getDeposit(societyIdOf(req.ctx), v(req).params.id as number)),
  ),
  create: h(async (req, res) =>
    created(
      res,
      await deposits.createDeposit(req.ctx, v(req).body as deposits.CreateDepositInput),
      'Deposit recorded',
    ),
  ),
  deduct: h(async (req, res) =>
    ok(
      res,
      await deposits.deductDeposit(
        req.ctx,
        v(req).params.id as number,
        v(req).body as { amountPaise: number; reason: string; date: string; version: number },
      ),
      'Deduction recorded',
    ),
  ),
  forfeit: h(async (req, res) =>
    ok(
      res,
      await deposits.forfeitDeposit(
        req.ctx,
        v(req).params.id as number,
        v(req).body as { reason: string; date: string; version: number },
      ),
      'Deposit forfeited',
    ),
  ),
  refundRequest: h(async (req, res) =>
    ok(
      res,
      await deposits.requestDepositRefund(
        req.ctx,
        v(req).params.id as number,
        v(req).body as { reason?: string; version: number },
      ),
      'Refund requested',
    ),
  ),
  refundPaid: h(async (req, res) =>
    ok(
      res,
      await deposits.markRefundPaid(
        req.ctx,
        v(req).params.id as number,
        v(req).body as {
          paidFromLedgerAccountId: number;
          refundMode: DepositRefundMode;
          refundReference?: string;
          date: string;
          version: number;
        },
      ),
      'Refund recorded as paid',
    ),
  ),
  cancel: h(async (req, res) =>
    ok(
      res,
      await deposits.cancelDeposit(
        req.ctx,
        v(req).params.id as number,
        v(req).body as { reason: string; version: number },
      ),
      'Deposit cancelled',
    ),
  ),
  mine: h(async (req, res) => ok(res, await deposits.listMyDeposits(req.ctx))),
};
export type { DepositKind };
