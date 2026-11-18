import type { Transaction } from 'sequelize';
import { z } from 'zod';
import { ApprovalRequest, sequelize } from '../../models';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import { AUDIT, ENTITY, ERR, LIMITS, NOTIFY } from './approvals.constants';
import { applyCapacity, snapshotState, writeAction } from './approvals.engine';
import { assertSocietyWritable } from './approvals.engine.guard';
import { slotsOf } from './approvals.match';
import { emitChanged, notificationData, sendTo } from './approvals.notify';
import { afterCommit, evaluateStep, loadApprovers, requireSociety, roundState } from './approvals.shared';
import type { StepOverride } from './approvals.types';
import { withDeadlockRetry } from './approvals.decide';

const n = (v: unknown): number => Number(v);
const reasonSchema = z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax);

export interface ReassignInput {
  version: number;
  userId: number;
  slotIndex?: number;
  reason: string;
}

/**
 * 8.10, BR-14-21: adds one named member to the current step as an extra `USER` slot (stored in `stepOverrides`, never on the
 * rule). `ALL_OF` needs `slotIndex` of a vacant slot, which the target replaces. The caller checks `settings.approval_rules.edit`
 * and the step-up window (route). Recomputes capacity (a stuck request is freed) and sends `approvals.pending` to the target.
 */
export async function reassign(
  ctx: Ctx,
  requestId: number,
  input: ReassignInput,
  t?: Transaction,
): Promise<ApprovalRequest> {
  if (t) return reassignTx(ctx, requestId, input, t);
  return withDeadlockRetry(() => sequelize.transaction(tx => reassignTx(ctx, requestId, input, tx)));
}

async function reassignTx(
  ctx: Ctx,
  requestId: number,
  input: ReassignInput,
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
  const r = reasonSchema.safeParse(input.reason);
  if (!r.success)
    throw new ValidationError([{ field: 'reason', message: 'Give a reason of 5 to 500 characters' }]);
  const reason = r.data;
  if (!Number.isInteger(input.userId) || input.userId < 1)
    throw new ValidationError([{ field: 'userId', message: 'Choose a member' }]);

  const members = await loadApprovers(societyId, req.type);
  const round = await roundState(req, t);
  const ev = evaluateStep(req, members, round);
  if (!ev) throw new AppError(500, ERR.internal, 'Something went wrong');
  const target = members.find(m => m.userId === input.userId);
  const isMaker = req.requesterKind !== 'SYSTEM' && n(req.requesterUserId) === input.userId;
  if (!target || isMaker || round.principals.has(input.userId) || round.actors.has(input.userId))
    throw new UnprocessableError(ERR.reassignTarget, 'This member cannot be given this approval', [
      { field: 'userId', message: 'Must be an active member with the permission who has not acted on it' },
    ]);

  let slotIndex: number | null = null;
  if (ev.step.mode === 'ALL_OF') {
    const slots = slotsOf(ev.step, (req.stepOverrides ?? []) as StepOverride[], n(req.round));
    const s = input.slotIndex === undefined ? undefined : slots[input.slotIndex];
    if (
      input.slotIndex === undefined ||
      !s ||
      ev.state.coveredRefs.has(s.ref) ||
      !ev.state.vacantRefs.includes(s.ref)
    )
      throw new UnprocessableError(ERR.slotNotVacant, 'Choose a vacant slot of this step', [
        { field: 'slotIndex', message: 'Must be the index of a vacant, uncovered slot' },
      ]);
    slotIndex = input.slotIndex;
  }

  const before = snapshotState(req);
  const override: StepOverride = {
    stepNo: n(req.currentStepNo),
    round: n(req.round),
    slotIndex,
    userId: input.userId,
    byUserId: ctx.user.id,
    at: now().toISOString(),
  };
  req.stepOverrides = [...((req.stepOverrides ?? []) as StepOverride[]), override];
  const after = evaluateStep(req, members, round);
  const wasStuck = req.stuckAt !== null;
  await applyCapacity(ctx, req, after?.ok ?? false, t);
  req.version = n(req.version) + 1;
  req.updatedBy = ctx.user.id;
  await req.save({ transaction: t });
  await writeAction(ctx, req, 'REASSIGNED', t, {
    stepNo: n(req.currentStepNo),
    slotType: 'USER',
    slotRef: String(input.userId),
    comment: reason,
  });
  await audit(
    ctx,
    {
      action: AUDIT.reassigned,
      entityType: ENTITY.request,
      entityId: n(req.id),
      entityLabel: req.title,
      societyId,
      before,
      after: {
        ...snapshotState(req),
        targetUserId: input.userId,
        slotIndex,
        freedStuck: wasStuck && !req.stuckAt,
      },
      reason,
    },
    t,
  );
  afterCommit(t, async () => {
    await emitChanged(req);
    await sendTo(NOTIFY.pending, [input.userId], notificationData(req));
  });
  return req;
}
