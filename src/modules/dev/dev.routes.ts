import express, { Router } from 'express';
import { clearInbox, listInbox } from '../../lib/inbox';
import { placeholderExports } from '../access-control/access-control.ports';
import { placeholderFiles } from '../societies/societies.ports';
import { putPlaceholderFile } from '../society-setup/society-setup.ports';
import { AppError } from '../../utils/errors';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { paymentGateway } from '../../adapters';
import { FakePaymentGateway } from '../../adapters/payments/payment-gateway';
import { systemCtx, type Ctx } from '../../types/context';
import { approveRequest, rejectRequest } from '../residents/residents.public';
import { approvePart3Request, rejectPart3Request } from '../residents/residents.public';
import { approvalStore } from '../residents/residents.part3.ports';
import { approvalStub } from '../residents/residents.part2.ports';

/** Non-production only: the last messages the fake adapters recorded (module 01 section 8.9). */
export const devRoutes = Router();

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
    const gw = paymentGateway();
    if (!(gw instanceof FakePaymentGateway)) throw new AppError(404, 'NOT_FOUND', 'Not found');
    const orderId = String(req.params.orderId);
    if (!gw.orders.has(orderId)) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const body = (req.body ?? {}) as {
      amountPaise?: number;
      status?: 'captured' | 'failed' | 'pending';
      method?: string;
    };
    const p = gw.payOrder(orderId, body);
    ok(res, { gatewayPaymentId: p.paymentId, orderId, status: p.status, amountPaise: p.amountPaise });
  }),
);

// ---------------------------------------------------------------- module 14 stand-in (development only)
// Module 14 (approvals) does not exist yet. Requests that module 09 raises through its placeholder (renovation permits,
// ownership transfers, and join requests or moves when the placeholder is in manual mode) wait here until someone decides.

const approvalCtx = (societyId: number): Ctx =>
  ({ ...systemCtx('dev-approvals'), society: { id: societyId } }) as Ctx;

/** The requests still waiting for a decision. */
devRoutes.get(
  '/approvals',
  asyncHandler(async (_req, res) => {
    const part3 = [...approvalStore.values()]
      .filter(a => a.status === 'PENDING')
      .map(a => ({ id: a.id, type: a.type, entityId: a.entityId, societyId: a.societyId, status: a.status }));
    const part2 = [...approvalStub.requests.values()]
      .filter(a => a.status === 'PENDING')
      .map(a => ({ id: a.id, type: a.type, entityId: a.entityId, societyId: a.societyId, status: a.status }));
    ok(res, [...part2, ...part3]);
  }),
);

async function decide(id: number, decision: 'approve' | 'reject', reason: string) {
  const p3 = approvalStore.get(id);
  if (p3) {
    if (p3.status !== 'PENDING') throw new AppError(409, 'NOT_PENDING', 'This request was already decided');
    const ctx = approvalCtx(p3.societyId);
    return decision === 'approve' ? approvePart3Request(id, ctx) : rejectPart3Request(id, reason, ctx);
  }
  const p2 = approvalStub.requests.get(id);
  if (p2) {
    if (p2.status !== 'PENDING') throw new AppError(409, 'NOT_PENDING', 'This request was already decided');
    const ctx = approvalCtx(p2.societyId);
    return decision === 'approve' ? approveRequest(id, ctx) : rejectRequest(id, reason, ctx);
  }
  throw new AppError(404, 'NOT_FOUND', 'Approval request not found');
}

devRoutes.post(
  '/approvals/:id/approve',
  asyncHandler(async (req, res) => {
    await decide(Number(req.params.id), 'approve', '');
    ok(res, { id: Number(req.params.id), status: 'APPROVED' });
  }),
);

devRoutes.post(
  '/approvals/:id/reject',
  asyncHandler(async (req, res) => {
    const reason = String((req.body as { reason?: string } | undefined)?.reason ?? 'Rejected in development');
    await decide(Number(req.params.id), 'reject', reason);
    ok(res, { id: Number(req.params.id), status: 'REJECTED' });
  }),
);
