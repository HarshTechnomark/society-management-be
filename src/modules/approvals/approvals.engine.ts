import type { Transaction } from 'sequelize';
import { z } from 'zod';
import { ApprovalAction, ApprovalRequest } from '../../models';
import { enqueueAfterCommit } from '../../lib/queue';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';
import { typeMeta } from './approvals.catalogue';
import {
  APPROVALS_QUEUE,
  AUDIT,
  ENTITY,
  ERR,
  JOB,
  LIMITS,
  NOTIFY,
  OPEN_STATUSES,
  STATUS_LABEL,
  type RequestStatus,
} from './approvals.constants';
import { payloadHash } from './approvals.match';
import { emitChanged, emitStuck, notifyClosed, notifyRequester, notifyStuck } from './approvals.notify';
import { requireHandlers } from './approvals.registry';
import { routeRequest, stepStartFields, type Routed } from './approvals.route';
import { afterCommit, loadApprovers, requireSociety, systemUserId, toView } from './approvals.shared';
import type { ApprovalCtx, ApprovalRequestView, RequestInput, ResubmitInput } from './approvals.types';

const n = (v: unknown): number => Number(v);
const CATEGORY = /^[A-Z0-9_]{2,40}$/;

const requestSchema = z.object({
  title: z.string().trim().min(LIMITS.titleMin).max(LIMITS.titleMax),
  summary: z.string().max(LIMITS.summaryMax).optional(),
  amountPaise: z.number().int().min(0).max(LIMITS.maxAmountPaise).optional(),
  categoryKey: z.string().regex(CATEGORY).optional(),
  unitId: z.number().int().positive().optional(),
  entityId: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new ValidationError(
    r.error.issues.map(i => ({ field: i.path.join('.') || 'input', message: i.message })),
  );
}
function checkPayload(payload: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(payload)) > LIMITS.payloadBytes)
    throw new ValidationError([{ field: 'payload', message: 'The payload is larger than 16 KB' }]);
}

const decisionCtx = (
  ctx: Ctx,
  req: ApprovalRequest,
  decision: ApprovalCtx['approval']['decision'],
  extra: Partial<ApprovalCtx['approval']> = {},
): ApprovalCtx => ({
  ...ctx,
  approval: {
    requestId: n(req.id),
    decision,
    actorUserId: ctx.user?.id ?? null,
    onBehalfOfUserId: null,
    reason: null,
    ...extra,
  },
});
export { decisionCtx };

/** Writes one history row of the request (append-only). */
export async function writeAction(
  ctx: Ctx,
  req: ApprovalRequest,
  action: (typeof import('./approvals.constants').ACTION)[number],
  t: Transaction,
  o: Partial<{
    stepNo: number | null;
    onBehalfOfUserId: number | null;
    delegationId: number | null;
    actorRoleKey: string | null;
    slotType: 'ROLE' | 'USER' | 'FALLBACK' | 'ESCALATION' | null;
    slotRef: string | null;
    comment: string | null;
    authTime: Date | null;
    system: boolean;
  }> = {},
): Promise<void> {
  const system = o.system ?? !ctx.user;
  await ApprovalAction.create(
    {
      societyId: req.societyId,
      requestId: req.id,
      round: req.round,
      stepNo: o.stepNo ?? null,
      action,
      actorUserId: system ? null : (ctx.user?.id ?? null),
      onBehalfOfUserId: o.onBehalfOfUserId ?? null,
      delegationId: o.delegationId ?? null,
      actorRoleKey: system ? 'system' : (o.actorRoleKey ?? ctx.actorRoleKey ?? null),
      actorName: system ? 'System' : (ctx.user?.name ?? null),
      slotType: o.slotType ?? null,
      slotRef: o.slotRef ?? null,
      comment: o.comment ?? null,
      authTime: o.authTime ?? null,
      ip: ctx.ip ? ctx.ip.slice(0, 45) : null,
    },
    { transaction: t },
  );
}

export const snapshotState = (r: ApprovalRequest) => ({
  status: r.status,
  currentStepNo: n(r.currentStepNo),
  round: n(r.round),
  version: n(r.version),
});

/** After-commit work common to every change: realtime, and the approver notice of a newly started step. */
export function announceStep(
  t: Transaction,
  req: ApprovalRequest,
  event: 'pending' | 'reminder' = 'pending',
): void {
  enqueueAfterCommit(
    t,
    APPROVALS_QUEUE,
    JOB.notifyApprovers,
    { requestId: n(req.id), round: n(req.round), stepNo: n(req.currentStepNo), event },
    { jobId: `notify:${n(req.id)}:${n(req.round)}:${n(req.currentStepNo)}:${event}:${n(req.reminderCount)}` },
  );
}

/** BR-14-11: after routing or a step start, record STUCK (and alert) or clear it. Returns true when the request just became stuck. */
export async function applyCapacity(
  ctx: Ctx,
  req: ApprovalRequest,
  routable: boolean,
  t: Transaction,
): Promise<boolean> {
  if (!routable) {
    const wasStuck = req.stuckAt !== null;
    req.hasEligibleApprover = false;
    req.stuckAt = req.stuckAt ?? now();
    if (!wasStuck) {
      await audit(
        ctx,
        {
          action: AUDIT.stuck,
          entityType: ENTITY.request,
          entityId: n(req.id),
          societyId: n(req.societyId),
          after: { stepNo: n(req.currentStepNo) },
        },
        t,
      );
      afterCommit(t, async () => {
        emitStuck(req);
        await notifyStuck(req);
      });
    }
    return !wasStuck;
  }
  if (req.stuckAt !== null)
    await audit(
      ctx,
      { action: AUDIT.unstuck, entityType: ENTITY.request, entityId: n(req.id), societyId: n(req.societyId) },
      t,
    );
  req.hasEligibleApprover = true;
  req.stuckAt = null;
  return false;
}

async function requesterOf(
  ctx: Ctx,
): Promise<{ userId: number; kind: 'ADMIN' | 'RESIDENT' | 'SYSTEM'; roleKey: string | null }> {
  if (!ctx.user) return { userId: await systemUserId(), kind: 'SYSTEM', roleKey: null };
  const roleKey = ctx.actorRoleKey ?? ctx.membership?.roleKey ?? null;
  return {
    userId: ctx.user.id,
    kind: ctx.membership?.roleScope === 'resident' ? 'RESIDENT' : 'ADMIN',
    roleKey,
  };
}

/** Auto-approval inside the caller's transaction (BR-14-4): the handler has run when this returns. */
async function finishAuto(ctx: Ctx, req: ApprovalRequest, t: Transaction): Promise<void> {
  const at = now();
  req.status = 'APPROVED';
  req.decidedAt = at;
  req.decidedByUserId = null;
  req.currentStepNo = 0;
  req.hasEligibleApprover = true;
  req.stuckAt = null;
  await req.save({ transaction: t });
  await writeAction(ctx, req, 'AUTO_APPROVED', t, {
    system: true,
    comment: `Rule: ${req.ruleSnapshot?.name ?? 'no rule matches'}`,
  });
  await audit(
    ctx,
    {
      action: AUDIT.autoApproved,
      entityType: ENTITY.request,
      entityId: n(req.id),
      societyId: n(req.societyId),
      after: { routing: req.routing, ruleId: req.ruleId },
    },
    t,
  );
  await requireHandlers(req.type).onApproved(
    decisionCtx(ctx, req, 'APPROVED', { actorUserId: null }),
    toView(req),
    t,
  );
  afterCommit(t, () => emitChanged(req));
}

/**
 * `approvals.request` (8.20, BR-14-1 to BR-14-6, BR-14-13, BR-14-16). Idempotent per open request of the entity: the same
 * payload returns the open request, another payload is `409 APPROVAL_ALREADY_PENDING`. PENDING, or APPROVED (auto) with
 * `onApproved` already run in `t`.
 */
export async function request(ctx: Ctx, input: RequestInput, t: Transaction): Promise<ApprovalRequest> {
  const societyId = requireSociety(ctx);
  const meta = typeMeta(input.type);
  if (!meta) throw new ValidationError([{ field: 'type', message: 'Unknown approval type' }]);
  if (input.entityType !== meta.entityType)
    throw new ValidationError([
      { field: 'entityType', message: `Expected ${meta.entityType} for ${meta.type}` },
    ]);
  const v = parse(requestSchema, input);
  const payload = v.payload ?? {};
  checkPayload(payload);
  if (input.expiresAt && input.expiresAt.getTime() <= now().getTime())
    throw new ValidationError([{ field: 'expiresAt', message: 'Must be in the future' }]);
  requireHandlers(meta.type);

  const amountPaise = v.amountPaise ?? 0;
  const hash = payloadHash({
    title: v.title,
    summary: v.summary ?? null,
    amountPaise,
    categoryKey: v.categoryKey ?? null,
    payload,
  });
  const open = await ApprovalRequest.findOne({
    where: { societyId, type: meta.type, entityId: v.entityId, status: [...OPEN_STATUSES] },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (open) {
    if (open.payloadHash === hash) return open;
    throw new ConflictError(ERR.alreadyPending, 'This item already has an open approval request');
  }

  const who = await requesterOf(ctx);
  const members = await loadApprovers(societyId, meta.type);
  const routed = await routeRequest(
    ctx,
    societyId,
    meta,
    {
      amountPaise,
      categoryKey: v.categoryKey ?? null,
      requesterRoleKey: who.roleKey,
      requesterUserId: who.kind === 'SYSTEM' ? null : who.userId,
    },
    t,
    members,
  );
  const at = now();
  const req = await ApprovalRequest.create(
    {
      societyId,
      type: meta.type,
      entityType: meta.entityType,
      entityId: v.entityId,
      title: v.title,
      summary: v.summary ?? null,
      categoryKey: v.categoryKey ?? null,
      unitId: v.unitId ?? null,
      amountPaise,
      payload,
      payloadHash: hash,
      status: 'PENDING',
      routing: routed.routing,
      ruleId: routed.ruleId,
      ruleVersion: routed.ruleVersion,
      ruleSnapshot: routed.snapshot,
      stepOverrides: null,
      totalSteps: routed.totalSteps,
      currentStepNo: routed.routing === 'STEPS' ? 1 : 0,
      requesterUserId: who.userId,
      requesterKind: who.kind,
      requesterRoleKey: who.roleKey,
      residentVisible: meta.residentVisible,
      stepUpRequired: routed.stepUpRequired,
      stepUpAbovePaise: routed.stepUpAbovePaise,
      allowBulk: routed.allowBulk,
      expiresAt: input.expiresAt ?? null,
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
      ...(routed.routing === 'STEPS' ? stepStartFields(routed.snapshot, at) : {}),
    },
    { transaction: t },
  );
  await writeAction(ctx, req, 'SUBMITTED', t, { actorRoleKey: who.roleKey });
  await audit(
    ctx,
    {
      action: AUDIT.created,
      entityType: ENTITY.request,
      entityId: n(req.id),
      entityLabel: v.title,
      societyId,
      after: {
        type: meta.type,
        entityId: v.entityId,
        amountPaise,
        routing: routed.routing,
        ruleId: routed.ruleId,
      },
    },
    t,
  );
  if (routed.routing !== 'STEPS') {
    await finishAuto(ctx, req, t);
    return req;
  }
  await applyCapacity(ctx, req, routed.routable, t);
  await req.save({ transaction: t });
  afterCommit(t, () => emitChanged(req));
  if (req.hasEligibleApprover) announceStep(t, req);
  return req;
}

async function lockById(ctx: Ctx, requestId: number, t: Transaction): Promise<ApprovalRequest> {
  const req = await ApprovalRequest.findOne({
    where: { id: requestId, societyId: requireSociety(ctx) },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!req) throw new NotFoundError(ERR.notFound, 'Approval request not found');
  return req;
}

/** `approvals.resubmit` (BR-14-17): CHANGES_REQUESTED to PENDING (or APPROVED), round + 1, routed again with today's rules. */
export async function resubmit(
  ctx: Ctx,
  requestId: number,
  input: ResubmitInput,
  t: Transaction,
): Promise<ApprovalRequest> {
  const req = await lockById(ctx, requestId, t);
  if (req.status !== 'CHANGES_REQUESTED')
    throw new ConflictError(ERR.notPending, 'This request is not waiting for changes');
  if (ctx.user && ctx.user.id !== n(req.requesterUserId))
    throw new ForbiddenError(ERR.notRequester, 'Only the person who raised this can resubmit it');
  const meta = typeMeta(req.type)!;
  const next = parse(
    requestSchema
      .pick({ title: true, summary: true, amountPaise: true, categoryKey: true, payload: true })
      .partial(),
    input,
  );
  const title = next.title ?? req.title;
  const summary = next.summary ?? req.summary;
  const amountPaise = next.amountPaise ?? n(req.amountPaise);
  const categoryKey = next.categoryKey ?? req.categoryKey;
  const payload = next.payload ?? req.payload;
  checkPayload(payload);
  const before = snapshotState(req);
  const members = await loadApprovers(n(req.societyId), req.type);
  const routed: Routed = await routeRequest(
    ctx,
    n(req.societyId),
    meta,
    {
      amountPaise,
      categoryKey,
      requesterRoleKey: req.requesterRoleKey,
      requesterUserId: req.requesterKind === 'SYSTEM' ? null : n(req.requesterUserId),
    },
    t,
    members,
  );
  Object.assign(req, {
    title,
    summary,
    amountPaise,
    categoryKey,
    payload,
    payloadHash: payloadHash({ title, summary, amountPaise, categoryKey, payload }),
    status: 'PENDING',
    routing: routed.routing,
    ruleId: routed.ruleId,
    ruleVersion: routed.ruleVersion,
    ruleSnapshot: routed.snapshot,
    stepOverrides: null,
    totalSteps: routed.totalSteps,
    currentStepNo: routed.routing === 'STEPS' ? 1 : 0,
    round: n(req.round) + 1,
    stepUpRequired: routed.stepUpRequired,
    stepUpAbovePaise: routed.stepUpAbovePaise,
    allowBulk: routed.allowBulk,
    changesDueAt: null,
    decisionReason: null,
    decidedAt: null,
    decidedByUserId: null,
    version: n(req.version) + 1,
    updatedBy: ctx.user?.id ?? null,
    ...stepStartFields(routed.routing === 'STEPS' ? routed.snapshot : null, now()),
  });
  await req.save({ transaction: t });
  await writeAction(ctx, req, 'RESUBMITTED', t, { actorRoleKey: req.requesterRoleKey });
  await audit(
    ctx,
    {
      action: AUDIT.resubmitted,
      entityType: ENTITY.request,
      entityId: n(req.id),
      societyId: n(req.societyId),
      before,
      after: { ...snapshotState(req), routing: routed.routing, amountPaise },
    },
    t,
  );
  if (routed.routing !== 'STEPS') {
    await finishAuto(ctx, req, t);
    return req;
  }
  await applyCapacity(ctx, req, routed.routable, t);
  await req.save({ transaction: t });
  afterCommit(t, () => emitChanged(req));
  if (req.hasEligibleApprover) announceStep(t, req);
  return req;
}

async function closeRequest(
  ctx: Ctx,
  req: ApprovalRequest,
  status: 'CANCELLED' | 'EXPIRED',
  reason: string,
  t: Transaction,
): Promise<void> {
  const before = snapshotState(req);
  req.status = status;
  req.decidedAt = now();
  req.decidedByUserId = ctx.user?.id ?? null;
  req.decisionReason = reason;
  req.version = n(req.version) + 1;
  req.updatedBy = ctx.user?.id ?? null;
  await req.save({ transaction: t });
  await writeAction(ctx, req, status, t, { comment: reason, stepNo: null });
  await audit(
    ctx,
    {
      action: status === 'CANCELLED' ? AUDIT.cancelled : AUDIT.expired,
      entityType: ENTITY.request,
      entityId: n(req.id),
      societyId: n(req.societyId),
      before,
      after: snapshotState(req),
      reason,
    },
    t,
  );
  afterCommit(t, async () => {
    await emitChanged(req);
    await notifyClosed(req, reason);
    if (status === 'EXPIRED') await notifyRequester(req, NOTIFY.expired, { reason });
  });
}
export { closeRequest };

/** `approvals.cancel` (owner-initiated): PENDING or CHANGES_REQUESTED to CANCELLED, no handler call. */
export async function cancel(ctx: Ctx, requestId: number, reason: string, t: Transaction): Promise<void> {
  const req = await lockById(ctx, requestId, t);
  if (!(OPEN_STATUSES as readonly string[]).includes(req.status))
    throw new ConflictError(ERR.notPending, 'This request is already closed');
  await closeRequest(
    ctx,
    req,
    'CANCELLED',
    (reason ?? '').trim().slice(0, LIMITS.reasonMax) || 'Cancelled',
    t,
  );
}

/**
 * API cancel by the requester (BR-14-18): only for types that registered `onCancelled`, reason 5 to 500 characters.
 * `403 NOT_THE_REQUESTER`, `422 CANCEL_NOT_SUPPORTED`.
 */
export async function cancelByRequester(
  ctx: Ctx,
  requestId: number,
  input: { reason: string; version?: number },
  t: Transaction,
): Promise<ApprovalRequest> {
  const req = await lockById(ctx, requestId, t);
  if (!ctx.user || ctx.user.id !== n(req.requesterUserId))
    throw new ForbiddenError(ERR.notRequester, 'Only the person who raised this can cancel it');
  if (!(OPEN_STATUSES as readonly string[]).includes(req.status))
    throw new ConflictError(ERR.notPending, 'This request is already closed');
  if (input.version !== undefined && n(req.version) !== input.version)
    throw new AppError(409, ERR.stale, 'This item changed. Reload and try again.');
  const h = requireHandlers(req.type);
  if (!h.onCancelled)
    throw new AppError(422, ERR.cancelNotSupported, 'This request is withdrawn from where it was raised');
  const reason = parse(z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax), input.reason);
  await closeRequest(ctx, req, 'CANCELLED', reason, t);
  await h.onCancelled(decisionCtx(ctx, req, 'CANCELLED', { reason }), toView(req), t);
  return req;
}

/** Lock order step 1 (BR-14-14): the open request of an entity, `SELECT … FOR UPDATE`, or null. */
export async function lockOpenForEntity(
  societyId: number,
  type: string,
  entityId: number,
  t: Transaction,
): Promise<ApprovalRequest | null> {
  return ApprovalRequest.findOne({
    where: { societyId, type, entityId, status: [...OPEN_STATUSES] },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}
/** The same by entity type, for the port the placeholders expose (`lockOpenForEntity(societyId, entityType, entityId, t)`). */
export async function lockOpenForEntityType(
  societyId: number,
  entityType: string,
  entityId: number,
  t?: Transaction,
): Promise<ApprovalRequest | null> {
  return ApprovalRequest.findOne({
    where: { societyId, entityType, entityId, status: [...OPEN_STATUSES] },
    ...(t ? { transaction: t, lock: t.LOCK.UPDATE } : {}),
  });
}
export const getOpenForEntity = (
  societyId: number,
  type: string,
  entityId: number,
): Promise<ApprovalRequest | null> =>
  ApprovalRequest.findOne({ where: { societyId, type, entityId, status: [...OPEN_STATUSES] } });

/** Resident-safe status of the latest request of an entity: no approver names (8.20). */
export async function publicStatus(
  societyId: number,
  type: string,
  entityId: number,
): Promise<{ status: string; statusLabel: string; reason: string | null } | null> {
  const r = await ApprovalRequest.findOne({ where: { societyId, type, entityId }, order: [['id', 'DESC']] });
  if (!r) return null;
  const step = r.ruleSnapshot?.steps[n(r.currentStepNo) - 1];
  const label =
    r.status === 'PENDING' && step ? `Waiting for ${step.name}` : STATUS_LABEL[r.status as RequestStatus];
  const showReason = ['REJECTED', 'CHANGES_REQUESTED', 'CANCELLED', 'EXPIRED'].includes(r.status);
  return { status: r.status, statusLabel: label, reason: showReason ? r.decisionReason : null };
}
export const requestView = (r: ApprovalRequest): ApprovalRequestView => toView(r);
