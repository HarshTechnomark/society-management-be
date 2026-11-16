import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { NotFoundError } from '../../utils/errors';
import { ok } from '../../utils/response';
import { advanceHistory } from './payments.advances.service';
import { exportPayments, type ExportInput } from './payments.admin.export';
import { getPayment, listPayments, type PaymentListQuery } from './payments.admin.queries';
import { myPayment, myPayments, myReceiptUrl } from './payments.admin.resident';
import { getSummary, liveFeed } from './payments.admin.summary';
import { adminReceiptUrl, resendReceipt } from './payments.receipts.service';
import {
  reallocatePayment,
  reversePayment,
  reviewDone,
  type ReallocateInput,
} from './payments.reverse.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;
const paged = (res: Response, data: unknown, pagination: unknown) =>
  res.status(200).json({ success: true, data, message: 'OK', pagination });

export const paymentsAdminController = {
  list: h(async (req, res) => {
    const r = await listPayments(sid(req), v(req).query as PaymentListQuery);
    return paged(res, r.items, r.pagination);
  }),
  get: h(async (req, res) => ok(res, await getPayment(sid(req), v(req).params.id))),
  summary: h(async (req, res) =>
    ok(res, await getSummary(sid(req), (v(req).query as { month?: string }).month)),
  ),
  feed: h(async (req, res) => ok(res, await liveFeed(sid(req)))),
  export: h(async (req, res) => {
    const file = await exportPayments(req.ctx, sid(req), v(req).query as ExportInput);
    const name = `${(v(req).query as ExportInput).type === 'REFUNDS' ? 'refunds' : 'payments'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(file);
  }),
  receiptUrl: h(async (req, res) => ok(res, await adminReceiptUrl(sid(req), v(req).params.id))),
  resend: h(async (req, res) =>
    ok(res, await resendReceipt(req.ctx, sid(req), v(req).params.id, v(req).body), 'Receipt sent'),
  ),
  reviewDone: h(async (req, res) =>
    ok(res, await reviewDone(req.ctx, sid(req), v(req).params.id, v(req).body), 'Review cleared'),
  ),
  reverse: h(async (req, res) =>
    ok(res, await reversePayment(req.ctx, sid(req), v(req).params.id, v(req).body), 'Payment reversed'),
  ),
  reallocate: h(async (req, res) =>
    ok(
      res,
      await reallocatePayment(req.ctx, sid(req), v(req).params.id, v(req).body as ReallocateInput),
      'Payment reallocated',
    ),
  ),
  // ---- advances
  myAdvances: h(async (req, res) => {
    const q = v(req).query as { unitId: number; page: number; limit: number };
    if (!(req.ctx.unitIds ?? []).includes(q.unitId))
      throw new NotFoundError('UNIT_NOT_FOUND', 'Unit not found');
    const r = await advanceHistory(sid(req), q.unitId, q.page, q.limit);
    return paged(res, r.data, r.pagination);
  }),
  unitAdvances: h(async (req, res) => {
    const q = v(req).query as { page: number; limit: number };
    const r = await advanceHistory(sid(req), v(req).params.unitId, q.page, q.limit);
    return paged(res, r.data, r.pagination);
  }),
  // ---- resident
  myList: h(async (req, res) => {
    const r = await myPayments(req.ctx, v(req).query as never);
    return paged(res, r.items, r.pagination);
  }),
  myGet: h(async (req, res) => ok(res, await myPayment(req.ctx, v(req).params.id))),
  myReceiptUrl: h(async (req, res) => ok(res, await myReceiptUrl(req.ctx, v(req).params.id))),
};
