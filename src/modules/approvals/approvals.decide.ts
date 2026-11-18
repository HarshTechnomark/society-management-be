import type { Transaction } from 'sequelize';
import { UniqueConstraintError } from 'sequelize';
import { z } from 'zod';
import { ApprovalRequest, sequelize } from '../../models';
import { nowMs, now, addDays } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../utils/errors';
import { stepUpMinutesFor } from '../auth/auth.sessions';
import { typeMeta } from './approvals.catalogue';
import { AUDIT, ENTITY, ERR, LIMITS, NOTIFY } from './approvals.constants';
import { announceStep, applyCapacity, decisionCtx, snapshotState, writeAction } from './approvals.engine';
import { resolveIdentity, type Resolved } from './approvals.eligibility';
import { assertSocietyWritable } from './approvals.engine.guard';
import { emitChanged, notifyClosed, notifyRequester } from './approvals.notify';
import { requireHandlers } from './approvals.registry';
import { stepStartFields } from './approvals.route';
import {
  afterCommit,
  evaluateStep,
  loadApprovers,
  requireSociety,
  roundState,
  toView,
} from './approvals.shared';

const n = (v: unknown): number => Number(v);

export interface DecisionInput {
  /** The version the caller read (BR-14-14). */
  version: number;
  comment?: string;
  reason?: string;
  onBehalfOfUserId?: number;
}
export type Verb = 'APPROVE' | 'REJECT' | 'CHANGES';

const reasonSchema = z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax);
const commentSchema = z.string().trim().max(LIMITS.commentMax).optional();

/** BR-14-13: `401 REAUTH_REQUIRED` unless the session authenticated within the step-up window (module 02 BR-02-40). */
export async function assertRecentAuth(ctx: Ctx): Promise<void> {
  const s = ctx.session;
  if (!s) throw new UnauthorizedError();
  const minutes = await stepUpMinutesFor(s.clientApp, s.activeSocietyId);
  if (s.amr.includes('PIN') || nowMs() - s.authTime.getTime() > minutes * 60_000)
    throw new UnauthorizedError(ERR.reauth, 'Confirm it is you to continue');
}

const isDeadlock = (e: unknown): boolean => {
  const x = e as { parent?: { errno?: number }; original?: { errno?: number } };
  return x?.parent?.errno === 1213 || x?.original?.errno === 1213;
};

/** BR-14-14: one retry of the whole transaction on a MySQL deadlock, then `409 STALE_VERSION`. */
export async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isDeadlock(err)) throw err;
    try {
      return await fn();
    } catch (err2) {
      if (isDeadlock(err2)) throw new ConflictError(ERR.stale, 'This item changed. Reload and try again.');
      throw err2;
    }
  }
}

/**
 * Decision transaction (6.3): lock, version, state, identity, eligibility, step-up, action, step completion, handler, update,
 * audit, after-commit effects. Pass `t` to join a caller's transaction, else one is opened (with the deadlock retry).
 */
export async function decide(
  ctx: Ctx,
  requestId: number,
  verb: Verb,
  input: DecisionInput,
  t?: Transaction,
): Promise<ApprovalRequest> {
  if (t) return decideTx(ctx, requestId, verb, input, t);
  return withDeadlockRetry(() => sequelize.transaction(tx => decideTx(ctx, requestId, verb, input, tx)));
}
export const approve = (ctx: Ctx, id: number, input: DecisionInput, t?: Transaction) =>
  decide(ctx, id, 'APPROVE', input, t);
export const reject = (ctx: Ctx, id: number, input: DecisionInput, t?: Transaction) =>
  decide(ctx, id, 'REJECT', input, t);
export const requestChanges = (ctx: Ctx, id: number, input: DecisionInput, t?: Transaction) =>
  decide(ctx, id, 'CHANGES', input, t);

async function decideTx(
  ctx: Ctx,
  requestId: number,
  verb: Verb,
  input: DecisionInput,
  t: Transaction,
): Promise<ApprovalRequest> {
  if (!ctx.user) throw new UnauthorizedError();
  const societyId = requireSociety(ctx);
  assertSocietyWritable(ctx);
  const req = await ApprovalRequest.findOne({
    where: { id: requestId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!req) throw new NotFoundError(ERR.notFound, 'Approval request not found');
  if (n(req.version) !== input.version)
    throw new ConflictError(ERR.stale, 'This item changed. Reload and try again.');
  if (req.status !== 'PENDING') throw new ConflictError(ERR.notPending, 'This item was already actioned');
  const meta = typeMeta(req.type)!;

  let reason: string | null = null;
  if (verb !== 'APPROVE') {
    const r = reasonSchema.safeParse(input.reason);
    if (!r.success)
      throw new ValidationError([{ field: 'reason', message: 'Give a reason of 5 to 500 characters' }]);
    reason = r.data;
    if (verb === 'CHANGES' && !meta.allowsChanges)
      throw new AppError(422, ERR.changesNotSupported, 'Changes cannot be requested for this type');
  }
  const c = commentSchema.safeParse(input.comment);
  if (!c.success) throw new ValidationError([{ field: 'comment', message: 'At most 500 characters' }]);

  const handlers = requireHandlers(req.type);
  const members = await loadApprovers(societyId, req.type);
  const round = await roundState(req, t);
  const ev = evaluateStep(req, members, round);
  if (!ev) throw new AppError(500, ERR.internal, 'Something went wrong');
  const who: Resolved = await resolveIdentity(ctx, req, ev, round, input.onBehalfOfUserId, t);
  if (verb === 'APPROVE' && req.stepUpRequired) await assertRecentAuth(ctx);

  const before = snapshotState(req);
  const actor = ctx.user.id;
  const onBehalf = who.onBehalf ? who.principalUserId : null;
  const at = now();
  const stepNo = n(req.currentStepNo);
  const actionKind = verb === 'APPROVE' ? 'APPROVED' : verb === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED';
  try {
    await writeAction(ctx, req, actionKind, t, {
      stepNo,
      onBehalfOfUserId: onBehalf,
      delegationId: who.delegationId,
      actorRoleKey: who.roleKey,
      slotType: who.slot.slotType,
      slotRef: who.slot.slotRef,
      comment: verb === 'APPROVE' ? c.data || null : reason,
      authTime: verb === 'APPROVE' && req.stepUpRequired ? (ctx.session?.authTime ?? null) : null,
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError)
      throw new ConflictError(ERR.alreadyActed, 'You already approved this item');
    throw err;
  }
  const hctx = (decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED') =>
    decisionCtx(ctx, req, decision, { actorUserId: actor, onBehalfOfUserId: onBehalf, reason });
  const audited = (action: string, after: Record<string, unknown>) =>
    audit(
      ctx,
      {
        action,
        entityType: ENTITY.request,
        entityId: n(req.id),
        entityLabel: req.title,
        societyId,
        before,
        after: { ...after, ...(onBehalf ? { onBehalfOfUserId: onBehalf } : {}) },
        reason,
      },
      t,
    );
  req.version = n(req.version) + 1;
  req.updatedBy = actor;

  if (verb === 'REJECT' || verb === 'CHANGES') {
    const rejected = verb === 'REJECT';
    req.status = rejected ? 'REJECTED' : 'CHANGES_REQUESTED';
    req.decisionReason = reason;
    req.decidedByUserId = actor;
    req.decidedAt = at;
    if (!rejected) req.changesDueAt = addDays(at, LIMITS.changesDueDays);
    await req.save({ transaction: t });
    await audited(rejected ? AUDIT.rejected : AUDIT.changesRequested, snapshotState(req));
    if (rejected) await handlers.onRejected(hctx('REJECTED'), toView(req), t);
    else await handlers.onChangesRequested?.(hctx('CHANGES_REQUESTED'), toView(req), t);
    afterCommit(t, async () => {
      await emitChanged(req);
      await notifyRequester(req, rejected ? NOTIFY.rejected : NOTIFY.changesRequested, { reason });
      if (rejected) await notifyClosed(req, reason);
    });
    return req;
  }

  // ---- approve: does this approval complete the step?
  const step = ev.step;
  const countAtStep = round.rows.filter(a => a.stepNo !== null && n(a.stepNo) === stepNo).length + 1;
  let complete: boolean;
  if (step.mode === 'ANY_OF') complete = true;
  else if (step.mode === 'N_OF') complete = countAtStep >= (step.requiredCount ?? 1);
  else {
    const covered = new Set(round.coveredRefs);
    covered.add(who.slot.slotRef);
    complete = ev.state.slots.every(s => covered.has(s.ref));
  }
  const last = stepNo >= n(req.totalSteps);
  if (!complete) {
    await req.save({ transaction: t });
    await audited(AUDIT.stepApproved, { ...snapshotState(req), stepApprovals: countAtStep, stepNo });
    afterCommit(t, () => emitChanged(req));
    return req;
  }
  if (!last) {
    req.currentStepNo = stepNo + 1;
    Object.assign(req, stepStartFields(req.ruleSnapshot, at));
    const nextRound = await roundState(req, t);
    const nextEv = evaluateStep(req, members, {
      principals: new Set([...nextRound.principals, who.principalUserId]),
      actors: new Set([...nextRound.actors, actor]),
      coveredRefs: nextRound.coveredRefs,
    });
    await applyCapacity(ctx, req, nextEv?.ok ?? false, t);
    await req.save({ transaction: t });
    await audited(AUDIT.stepApproved, { ...snapshotState(req), stepNo, stepComplete: true });
    afterCommit(t, () => emitChanged(req));
    if (req.hasEligibleApprover) announceStep(t, req);
    return req;
  }
  req.status = 'APPROVED';
  req.decidedAt = at;
  req.decidedByUserId = actor;
  req.nextReminderAt = null;
  req.escalateAt = null;
  req.dueAt = null;
  await req.save({ transaction: t });
  await audited(AUDIT.approved, snapshotState(req));
  await handlers.onApproved(hctx('APPROVED'), toView(req), t);
  afterCommit(t, async () => {
    await emitChanged(req);
    await notifyRequester(req, NOTIFY.approved);
  });
  return req;
}
