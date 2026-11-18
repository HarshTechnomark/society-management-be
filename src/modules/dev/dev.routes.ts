import express, { Router } from 'express';
import { clearInbox, listInbox } from '../../lib/inbox';
import { placeholderExports } from '../access-control/access-control.ports';
import { placeholderFiles } from '../societies/societies.ports';
import { putPlaceholderFile } from '../society-setup/society-setup.ports';
import { AppError } from '../../utils/errors';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { devActivateMandate, devPayOrder, devProcessRefund, devSimulateOrder } from './dev.payments';
import { devGenerateSettlement } from './dev.accounts';
import { sampleStatementCsv } from '../accounts/accounts.statements.sample';

/** Non-production only: the last messages the fake adapters recorded (module 01 section 8.9). */
export const devRoutes = Router();

/** Module 13 (13.3b): a sample bank statement CSV built from the recent postings on a bank account, to demo import and auto-match. */
devRoutes.get(
  '/accounts/sample-statement',
  asyncHandler(async (req, res) => {
    const id = Number(req.query.bankAccountId);
    if (!Number.isInteger(id) || id < 1)
      throw new AppError(400, 'VALIDATION_FAILED', 'bankAccountId is required');
    const { csv } = await sampleStatementCsv(id);
    res
      .type('text/csv')
      .set('Content-Disposition', `attachment; filename="sample-statement-${id}.csv"`)
      .send(csv);
  }),
);

devRoutes.get(
  '/inbox',
  asyncHandler(async (req, res) => {
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const channel = typeof req.query.channel === 'string' ? req.query.channel.toUpperCase() : undefined;
    const items = (await listInbox()).filter(
      m => (!to || m.to === to) && (!channel || m.channel === channel),
    );
    ok(res, items);
  }),
);

devRoutes.delete(
  '/inbox',
  asyncHandler(async (_req, res) => {
    await clearInbox();
    ok(res, null, 'Inbox cleared');
  }),
);

/** Placeholder download for exports until the module 01 file service exists (module 03 members export). */
devRoutes.get('/exports/:id', (req, res, next) => {
  const f = placeholderExports.get(Number(req.params.id));
  if (!f || f.expiresAt < new Date()) return next(new AppError(404, 'NOT_FOUND', 'Export not found'));
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.send(f.content);
});

/** Placeholder file download (module 05 data export parts) until the module 01 file service exists. */
devRoutes.get('/files/:id', (req, res, next) => {
  const f = placeholderFiles.get(Number(req.params.id));
  if (!f || f.status !== 'CLEAN') return next(new AppError(404, 'NOT_FOUND', 'File not found'));
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.send(f.content);
});

/**
 * Development upload until module 01's files service exists: the raw request body becomes a CLEAN file in the memory
 * store (`?societyId=&ownerUserId=&name=&purpose=IMPORT_FILE`, at most 20 MB) and the answer is `{ fileId }`.
 * The dev routes carry no session, so the society and the uploader are named in the query. Never mounted in production.
 */
devRoutes.post(
  '/files',
  express.raw({ type: () => true, limit: '20mb' }),
  asyncHandler(async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const societyId = Number(q.societyId);
    const ownerUserId = Number(q.ownerUserId);
    const name = (q.name ?? '').trim();
    if (!Number.isInteger(societyId) || !Number.isInteger(ownerUserId) || !name || !Buffer.isBuffer(req.body))
      throw new AppError(400, 'VALIDATION_FAILED', 'societyId, ownerUserId and name are required');
    const fileId = putPlaceholderFile({
      societyId,
      ownerUserId,
      name: name.slice(0, 200),
      purpose: (q.purpose ?? 'IMPORT_FILE').toUpperCase(),
      contentType: req.get('content-type') ?? 'application/octet-stream',
      content: req.body,
    });
    ok(res, { fileId }, 'File stored (development only)', 201);
  }),
);

/** Non-production only: what the checkout would do on the fake gateway. Pay a platform order (module 01 section 10). */
devRoutes.post(
  '/payments/:orderId/pay',
  asyncHandler(async (req, res) => {
    // module 06 platform orders and module 12 society orders (12.1: captured through the webhook code path)
    ok(res, await devPayOrder(String(req.params.orderId), (req.body ?? {}) as Record<string, never>));
  }),
);

/** Module 12 (12.4): the fake gateway confirms an AutoPay mandate (`mandate.activated` through the webhook path). */
devRoutes.post(
  '/payments/mandates/:gatewayMandateId/activate',
  asyncHandler(async (req, res) => {
    ok(res, await devActivateMandate(String(req.params.gatewayMandateId)));
  }),
);

/** Module 12 (12.4): the fake gateway finishes a refund (`refund.processed|failed` through the webhook path). */
devRoutes.post(
  '/payments/refunds/:gatewayRefundId/process',
  asyncHandler(async (req, res) => {
    ok(
      res,
      await devProcessRefund(String(req.params.gatewayRefundId), (req.body ?? {}) as { outcome?: unknown }),
    );
  }),
);

/** Module 12 alias by payment order id (`PO-<id>`): body `{ outcome: 'success' | 'fail' }`. */
devRoutes.post(
  '/payments/orders/:orderId/simulate',
  asyncHandler(async (req, res) => {
    ok(res, await devSimulateOrder(Number(req.params.orderId), (req.body ?? {}) as { outcome?: unknown }));
  }),
);

/** Module 13 (13.3a): a gateway settlement built from the captured online payments no settlement lists yet. */
devRoutes.post(
  '/accounts/settlements/generate',
  asyncHandler(async (req, res) => {
    ok(
      res,
      await devGenerateSettlement((req.body ?? {}) as Record<string, unknown>),
      'Settlement generated (development only)',
      201,
    );
  }),
);
