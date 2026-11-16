import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import { logger } from '../../lib/logger';
import { NotFoundError } from '../../utils/errors';
import { ERR } from './payments.constants';
import { paymentsPorts } from './payments.ports';
import { createPayListOrder } from './payments.orders.create';
import { getPayables } from './payments.orders.payables';
import {
  adminOrderDetail,
  cancelOrder,
  forceCheck,
  listOrders,
  residentOrder,
  societyOrder,
  statusBody,
  verifyOrder,
} from './payments.orders.service';
import {
  createPaymentLink,
  publicLinkCheckout,
  publicLinkInfo,
  publicLinkVerify,
} from './payments.links.service';
import { ingestWebhook } from './payments.webhooks.service';

const v = (req: Request) => req.valid as { body: any; query: any; params: any };
const h = (fn: (req: Request, res: Parameters<RequestHandler>[1]) => Promise<unknown>): RequestHandler =>
  asyncHandler(async (req, res) => {
    await fn(req, res);
  });

/** Token of a public pay request: body field or the `X-Pay-Token` header (never logged). */
const tokenOf = (req: Request): string | undefined =>
  (req.valid as { body?: { token?: string } } | undefined)?.body?.token ??
  req.get('x-pay-token') ??
  undefined;

export const onlineController = {
  payables: h(async (req, res) => ok(res, await getPayables(req.ctx, v(req).query.unitId))),
  createOrder: h(async (req, res) =>
    created(res, await createPayListOrder(req.ctx, v(req).body), 'Payment order created'),
  ),
  verify: h(async (req, res) => {
    const o = await residentOrder(req.ctx, v(req).params.id);
    ok(res, await verifyOrder(req.ctx, o, v(req).body.gatewayPaymentId));
  }),
  status: h(async (req, res) => {
    const o = await residentOrder(req.ctx, v(req).params.id);
    ok(res, await statusBody(Number(o.id)));
  }),
  cancelOwn: h(async (req, res) => {
    const o = await residentOrder(req.ctx, v(req).params.id);
    // another member's checkout of the same flat is not theirs to cancel
    if (o.payerUserId !== req.ctx.user!.id)
      throw new NotFoundError(ERR.orderNotFound, 'Payment order not found');
    ok(res, await cancelOrder(req.ctx, o, 'Cancelled by the payer'), 'Payment cancelled');
  }),
  adminList: h(async (req, res) => {
    const r = await listOrders(req.ctx.society!.id, v(req).query);
    okList(res, r.data, r.pagination);
  }),
  adminDetail: h(async (req, res) => ok(res, await adminOrderDetail(req.ctx.society!.id, v(req).params.id))),
  adminCancel: h(async (req, res) => {
    const o = await societyOrder(req.ctx.society!.id, v(req).params.id);
    await cancelOrder(req.ctx, o, v(req).body.reason);
    ok(res, await adminOrderDetail(req.ctx.society!.id, Number(o.id)), 'Order cancelled');
  }),
  adminCheck: h(async (req, res) => ok(res, await forceCheck(req.ctx, v(req).params.id))),
  createLink: h(async (req, res) =>
    created(res, await createPaymentLink(req.ctx, v(req).body), 'Payment link created'),
  ),
  // ---- public pay routes (8.24)
  linkInfo: h(async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex');
    ok(res, await publicLinkInfo(v(req).params.code, tokenOf(req)));
  }),
  linkCheckout: h(async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex');
    ok(res, await publicLinkCheckout(v(req).params.code, tokenOf(req)), 'Checkout ready');
  }),
  linkVerify: h(async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex');
    ok(res, await publicLinkVerify(v(req).params.code, tokenOf(req), v(req).body.gatewayPaymentId));
  }),
  webhook: h(async (req, res) => {
    const acct = v(req).params.gatewayAccountId as number;
    const account = await paymentsPorts().gateways.getAccount(acct);
    const signature = account
      ? (req.get(paymentsPorts().gateways.clientFor(account).signatureHeader) ?? '')
      : '';
    const r = await ingestWebhook(acct, req.rawBody, signature, account);
    logger.debug({ acct, duplicate: Boolean(r.duplicate) }, 'payment webhook received');
    ok(res, { received: true, ...(r.duplicate ? { duplicate: true } : {}) });
  }),
};
