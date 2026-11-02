import type { Request, RequestHandler, Response } from 'express';
import { paymentGateway } from '../../adapters';
import { env } from '../../lib/env';
import { enqueue } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/errors';
import { created, ok, okList } from '../../utils/response';
import { PlatformInvoice } from '../../models';
import * as invoicing from './platform-billing.service';
import * as payments from './platform-billing.payments';
import * as tds from './platform-billing.tds';
import * as credits from './platform-billing.credits';
import * as autopay from './platform-billing.autopay';
import * as queries from './platform-billing.queries';
import { PROCESS_WEBHOOK_JOB, HANDLED_EVENTS } from './platform-billing.webhook';
import { creditBalance } from './platform-billing.settlement';
import { num } from './platform-billing.shared';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;
const pid = (req: Request): number => req.valid.params.id;
const mine = (req: Request): queries.Audience => ({ societyId: sid(req) });

/** 8.14 response for a credit note: the original invoice after settlement and the credit balance. */
async function approvalView(dto: Awaited<ReturnType<typeof invoicing.approveDocument>>) {
  if (dto.documentType !== 'CREDIT_NOTE' || !dto.originalInvoiceId) return dto;
  const orig = await PlatformInvoice.findByPk(dto.originalInvoiceId);
  return {
    ...dto,
    originalInvoice: orig && {
      id: orig.id!,
      invoiceNo: orig.invoiceNo,
      status: orig.status,
      amountDuePaise: num(orig.amountDuePaise),
      excessToCreditPaise: num(orig.excessToCreditPaise),
    },
    creditBalancePaise: await creditBalance(dto.societyId),
  };
}

export const platformBillingController = {
  // ---- society (8.1 to 8.11)
  summary: h(async (req, res) => ok(res, await queries.billingSummary(sid(req)))),
  societyInvoices: h(async (req, res) => {
    const r = await queries.listInvoices(mine(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  societyInvoice: h(async (req, res) => ok(res, await queries.invoiceDetail(mine(req), pid(req)))),
  societyPdf: h(async (req, res) => ok(res, await queries.invoicePdfUrl(req.ctx, mine(req), pid(req)))),
  paymentOrder: h(async (req, res) =>
    created(
      res,
      await payments.createPaymentOrder(req.ctx, sid(req), pid(req), v(req).body),
      'Payment order created',
    ),
  ),
  verify: h(async (req, res) =>
    ok(res, await payments.verifyPayment(req.ctx, sid(req), pid(req), v(req).body.gatewayPaymentId)),
  ),
  societyPayments: h(async (req, res) => {
    const r = await queries.listPayments(mine(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  societyCredits: h(async (req, res) => {
    const r = await queries.listCredits({ societyId: sid(req) }, false, v(req).query);
    res.status(200).json({
      success: true,
      data: r.items,
      message: 'OK',
      balancePaise: r.balancePaise,
      pagination: r.pagination,
    });
  }),
  societyTds: h(async (req, res) =>
    created(
      res,
      await tds.claimTds(req.ctx, pid(req), v(req).body, { societyId: sid(req) }),
      'TDS claim recorded',
    ),
  ),
  attachCertificate: h(async (req, res) =>
    ok(res, await tds.attachCertificate(req.ctx, sid(req), pid(req), v(req).body), 'Certificate attached'),
  ),
  requestAutopay: h(async (req, res) =>
    created(res, await autopay.requestAutopay(req.ctx, sid(req), v(req).body), 'Autopay set-up started'),
  ),
  cancelAutopay: h(async (req, res) =>
    ok(res, await autopay.cancelAutopay(req.ctx, sid(req)), 'Autopay cancelled'),
  ),

  // ---- platform invoices (8.2, 8.3, 8.4, 8.9, 8.12 to 8.14)
  platformInvoices: h(async (req, res) => {
    const r = await queries.listInvoices({}, v(req).query);
    okList(res, r.data, r.pagination);
  }),
  exportInvoices: h(async (req, res) => {
    const csv = await queries.exportInvoicesCsv(req.ctx, v(req).query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="platform-invoices.csv"');
    res.status(200).send(csv);
  }),
  platformInvoice: h(async (req, res) => ok(res, await queries.invoiceDetail({}, pid(req)))),
  platformPdf: h(async (req, res) => ok(res, await queries.invoicePdfUrl(req.ctx, {}, pid(req)))),
  manualInvoice: h(async (req, res) =>
    created(res, await invoicing.createManualInvoice(req.ctx, v(req).body), 'Invoice draft created'),
  ),
  creditNote: h(async (req, res) =>
    created(
      res,
      await invoicing.createCreditNote(req.ctx, pid(req), v(req).body),
      'Credit note draft created',
    ),
  ),
  approveInvoice: h(async (req, res) =>
    ok(res, await approvalView(await invoicing.approveDocument(req.ctx, pid(req), v(req).body)), 'Approved'),
  ),
  rejectInvoice: h(async (req, res) =>
    ok(res, await invoicing.rejectDocument(req.ctx, pid(req), v(req).body), 'Rejected'),
  ),
  platformTds: h(async (req, res) =>
    created(res, await tds.claimTds(req.ctx, pid(req), v(req).body, {}), 'TDS claim recorded'),
  ),

  // ---- platform payments, TDS decision, refunds, credits (8.7, 8.8, 8.18 to 8.23)
  platformPayments: h(async (req, res) => {
    const r = await queries.listPayments({}, v(req).query);
    okList(res, r.data, r.pagination);
  }),
  manualPayment: h(async (req, res) =>
    created(res, await payments.recordManualPayment(req.ctx, v(req).body), 'Payment recorded for approval'),
  ),
  approvePayment: h(async (req, res) =>
    ok(res, await payments.approvePayment(req.ctx, pid(req), v(req).body), 'Approved'),
  ),
  rejectPayment: h(async (req, res) =>
    ok(res, await payments.rejectPayment(req.ctx, pid(req), v(req).body), 'Rejected'),
  ),
  tdsDecision: h(async (req, res) =>
    ok(res, await tds.decideTds(req.ctx, pid(req), v(req).body), 'TDS claim decided'),
  ),
  completeRefund: h(async (req, res) =>
    ok(res, await credits.completeRefund(req.ctx, pid(req), v(req).body), 'Refund completed'),
  ),
  requestRefund: h(async (req, res) =>
    created(
      res,
      await credits.requestRefund(req.ctx, v(req).params.societyId, v(req).body),
      'Refund requested',
    ),
  ),
  platformCredits: h(async (req, res) => {
    const r = await queries.listCredits({ societyId: v(req).params.societyId }, true, v(req).query);
    res.status(200).json({
      success: true,
      data: r.items,
      message: 'OK',
      balancePaise: r.balancePaise,
      pagination: r.pagination,
    });
  }),
  requestGoodwill: h(async (req, res) =>
    created(
      res,
      await credits.requestGoodwill(req.ctx, v(req).params.societyId, v(req).body),
      'Credit requested',
    ),
  ),
  approveCredit: h(async (req, res) =>
    ok(res, await credits.approveCredit(req.ctx, pid(req), v(req).body), 'Credit approved'),
  ),
  rejectCredit: h(async (req, res) =>
    ok(res, await credits.rejectCredit(req.ctx, pid(req), v(req).body), 'Credit rejected'),
  ),

  // ---- 8.28 webhook: raw body, signature first, then enqueue and answer
  webhook: h(async (req, res) => {
    const gw = paymentGateway();
    const raw = req.rawBody;
    const signature = req.get(gw.signatureHeader) ?? '';
    if (!raw || !gw.verifyWebhook(raw, signature, env().PLATFORM_RAZORPAY_WEBHOOK_SECRET)) {
      logger.warn({ ip: req.ip }, 'platform billing webhook signature invalid');
      throw new AppError(400, 'WEBHOOK_SIGNATURE_INVALID', 'The webhook signature is not valid');
    }
    let event;
    try {
      event = gw.parseWebhook(raw);
    } catch {
      throw new AppError(400, 'VALIDATION_FAILED', 'The webhook body could not be read');
    }
    if (!event.eventId) throw new AppError(400, 'VALIDATION_FAILED', 'The webhook has no event id');
    if ((HANDLED_EVENTS as readonly string[]).includes(event.type))
      await enqueue(
        'platform-billing',
        PROCESS_WEBHOOK_JOB,
        { eventId: event.eventId, event: event as unknown as Record<string, unknown> },
        { jobId: event.eventId },
      );
    ok(res, { received: true });
  }),
};
