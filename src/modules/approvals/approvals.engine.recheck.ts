import type { Transaction } from 'sequelize';
import { ApprovalRequest, sequelize } from '../../models';
import { logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { nowMs } from '../../lib/clock';
import { enqueueAfterCommit } from '../../lib/queue';
import { APPROVALS_QUEUE, JOB } from './approvals.constants';
import { applyCapacity } from './approvals.engine';
import { allowedSocieties, jobCtx } from './approvals.engine.guard';
import { emitChanged } from './approvals.notify';
import { afterCommit, evaluateStep, loadApprovers, roundState } from './approvals.shared';

const n = (v: unknown): number => Number(v);

export type RecheckResult = 'stuck' | 'freed' | 'same' | 'skipped';

/**
 * BR-14-11 (b), BR-14-32: recomputes the capacity of one open request's current step (after a member change). Newly STUCK:
 * `approvals.unroutable` and `approvals.stuck` (inside `applyCapacity`); freed: `stuckAt` cleared and `approvals.pending` sent.
 */
export async function recheckRequest(ctx: Ctx, requestId: number, t: Transaction): Promise<RecheckResult> {
  const req = await ApprovalRequest.findOne({
    where: { id: requestId, societyId: ctx.society!.id },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!req || req.status !== 'PENDING' || req.routing !== 'STEPS') return 'skipped';
  const members = await loadApprovers(n(req.societyId), req.type);
  const ev = evaluateStep(req, members, await roundState(req, t));
  const ok = ev?.ok ?? false;
  const wasStuck = req.stuckAt !== null;
  if (ok === !wasStuck) return 'same';
  const becameStuck = await applyCapacity(ctx, req, ok, t);
  await req.save({ transaction: t });
  afterCommit(t, () => emitChanged(req));
  if (ok && wasStuck) {
    // a fresh job id: the first `approvals.pending` notice of this step already used the plain one
    enqueueAfterCommit(
      t,
      APPROVALS_QUEUE,
      JOB.notifyApprovers,
      { requestId: n(req.id), round: n(req.round), stepNo: n(req.currentStepNo), event: 'pending' },
      { jobId: `notify:${n(req.id)}:${n(req.round)}:${n(req.currentStepNo)}:pending:freed:${nowMs()}` },
    );
    return 'freed';
  }
  return becameStuck ? 'stuck' : 'same';
}

/** Job `approvals:recheck-member`: every open request of the society (or one request when `requestId` is given). */
export async function recheckSociety(societyId: number): Promise<{ stuck: number; freed: number }> {
  const allowed = await allowedSocieties([societyId]);
  const out = { stuck: 0, freed: 0 };
  if (!allowed.has(societyId)) return out;
  const ctx = jobCtx(societyId, allowed.get(societyId));
  const rows = await ApprovalRequest.findAll({
    where: { societyId, status: 'PENDING', routing: 'STEPS' },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  for (const r of rows) {
    try {
      const res = await sequelize.transaction(t => recheckRequest(ctx, n(r.id), t));
      if (res === 'stuck') out.stuck++;
      if (res === 'freed') out.freed++;
    } catch (err) {
      logger.error({ err, requestId: r.id }, 'approvals recheck failed');
    }
  }
  return out;
}
