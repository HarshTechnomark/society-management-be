import express, { Router, type Request } from 'express';
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
import { placeholderApprovalRequests } from '../billing/billing.ports';
import * as runApprovals from '../billing/billing.runs.approvals-hook';
import * as ruleApprovals from '../billing/billing.rules.approvals-hook';
import * as noteApprovals from '../billing/billing.notes.approvals-hook';
import { APPROVAL_TYPES } from '../billing/billing.constants';
import { readOptionalSession } from '../../middlewares/auth.middleware';
import { computeAccess, getSocietyInfo } from '../access-control/access-control.access';

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

/**
 * Who decides. The dev routes need no session, but a browser sends its cookies: when they carry a valid session whose active
 * society is the request's society and the person is an ACTIVE member there, the decision is made as that person (so the
 * maker-checker rule applies and the approver is recorded). Otherwise (scripts, tests, another society) the system decides.
 */
async function deciderCtx(req: Request, societyId: number): Promise<Ctx> {
  const s = await readOptionalSession(req);
  if (!s || !societyId || s.activeSocietyId !== societyId) return approvalCtx(societyId);
  const [access, society] = await Promise.all([
    computeAccess(societyId, s.user.id),
    getSocietyInfo(societyId),
  ]);
  if (access.status !== 'ACTIVE' || !society) return approvalCtx(societyId);
  return {
    requestId: req.ctx.requestId,
    ip: req.ctx.ip,
    userAgent: req.ctx.userAgent,
    clientApp: req.ctx.clientApp,
    user: s.user,
    society,
    membership: {
      id: access.memberId!,
      roleId: access.roleId!,
      roleKey: access.roleKey!,
      roleScope: access.roleScope!,
      status: 'ACTIVE',
      requiresMfa: access.requiresMfa,
    },
    permissions: new Set(access.permissions),
    unitLinks: access.unitLinks,
    unitIds: access.unitLinks.map(l => l.unitId),
    actorRoleKey: access.roleKey!,
  };
}

type ApprovalSource = 'residents' | 'billing';
const sourceOf = (v: unknown): ApprovalSource => (v === 'billing' ? 'billing' : 'residents');

/** The requests still waiting for a decision. `source` says which module's placeholder holds it (ids can repeat across modules). */
devRoutes.get(
  '/approvals',
  asyncHandler(async (_req, res) => {
    const row = (
      a: { id: number; type: string; entityId: number; societyId: number | null; status: string },
      source: ApprovalSource,
    ) => ({ id: a.id, type: a.type, entityId: a.entityId, societyId: a.societyId, status: a.status, source });
    const part3 = [...approvalStore.values()]
      .filter(a => a.status === 'PENDING')
      .map(a => row(a, 'residents'));
    const part2 = [...approvalStub.requests.values()]
      .filter(a => a.status === 'PENDING')
      .map(a => row(a, 'residents'));
    const billing = [...placeholderApprovalRequests.values()]
      .filter(a => a.status === 'PENDING')
      .map(a => row(a, 'billing'));
    ok(res, [...part2, ...part3, ...billing]);
  }),
);

interface BillingApprovalHook {
  approve: (id: number, ctx: Ctx) => Promise<unknown>;
  reject: (id: number, reason: string, ctx: Ctx) => Promise<unknown>;
}
/**
 * Billing approval types and the hook that decides each. Module 11.4 adds its note types here after merging
 * (`CREDIT_NOTE`, `INVOICE_CANCEL`, `WRITE_OFF`); any other type is refused with 422.
 */
const BILLING_APPROVAL_HOOKS: Record<string, BillingApprovalHook> = {
  [APPROVAL_TYPES.runPublish]: runApprovals,
  [APPROVAL_TYPES.ruleChange]: ruleApprovals,
  [APPROVAL_TYPES.lateFeePolicyChange]: ruleApprovals,
  [APPROVAL_TYPES.creditNote]: noteApprovals,
  [APPROVAL_TYPES.writeOff]: noteApprovals,
  [APPROVAL_TYPES.invoiceCancel]: noteApprovals,
};

async function decideBilling(req: Request, id: number, decision: 'approve' | 'reject', reason: string) {
  const r = placeholderApprovalRequests.get(id);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Approval request not found');
  if (r.status !== 'PENDING') throw new AppError(409, 'NOT_PENDING', 'This request was already decided');
  const hook = BILLING_APPROVAL_HOOKS[r.type];
  if (!hook) throw new AppError(422, 'UNKNOWN_APPROVAL_TYPE', `No development approval hook for ${r.type}`);
  const ctx = await deciderCtx(req, r.societyId ?? 0);
  // BR-14 maker-checker for every billing type (the runs hook checks it too; the rules hook does not)
  if (decision === 'approve' && ctx.user && ctx.user.id === r.requestedBy)
    throw new AppError(409, 'MAKER_CHECKER_VIOLATION', 'The person who requested this cannot approve it');
  const out = decision === 'approve' ? await hook.approve(id, ctx) : await hook.reject(id, reason, ctx);
  r.status = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  return out;
}

async function decide(
  req: Request,
  id: number,
  decision: 'approve' | 'reject',
  reason: string,
  source: ApprovalSource,
) {
  if (source === 'billing') return decideBilling(req, id, decision, reason);
  const p3 = approvalStore.get(id);
  if (p3) {
    if (p3.status !== 'PENDING') throw new AppError(409, 'NOT_PENDING', 'This request was already decided');
    const ctx = await deciderCtx(req, p3.societyId);
    return decision === 'approve' ? approvePart3Request(id, ctx) : rejectPart3Request(id, reason, ctx);
  }
  const p2 = approvalStub.requests.get(id);
  if (p2) {
    if (p2.status !== 'PENDING') throw new AppError(409, 'NOT_PENDING', 'This request was already decided');
    const ctx = await deciderCtx(req, p2.societyId);
    return decision === 'approve' ? approveRequest(id, ctx) : rejectRequest(id, reason, ctx);
  }
  throw new AppError(404, 'NOT_FOUND', 'Approval request not found');
}

devRoutes.post(
  '/approvals/:id/approve',
  asyncHandler(async (req, res) => {
    await decide(req, Number(req.params.id), 'approve', '', sourceOf(req.query.source));
    ok(res, { id: Number(req.params.id), status: 'APPROVED' });
  }),
);

devRoutes.post(
  '/approvals/:id/reject',
  asyncHandler(async (req, res) => {
    const reason = String((req.body as { reason?: string } | undefined)?.reason ?? 'Rejected in development');
    await decide(req, Number(req.params.id), 'reject', reason, sourceOf(req.query.source));
    ok(res, { id: Number(req.params.id), status: 'REJECTED' });
  }),
);
