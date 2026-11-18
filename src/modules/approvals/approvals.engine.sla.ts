import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { ApprovalRequest, sequelize } from '../../models';
import { addHours, istClock, now } from '../../lib/clock';
import { enqueueAfterCommit } from '../../lib/queue';
import { logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { APPROVALS_QUEUE, AUDIT, ENTITY, JOB, LIMITS } from './approvals.constants';
import { closeRequest, decisionCtx, snapshotState, writeAction } from './approvals.engine';
import { allowedSocieties, jobCtx } from './approvals.engine.guard';
import { recheckRequest } from './approvals.engine.recheck';
import { requireHandlers } from './approvals.registry';
import { emitChanged } from './approvals.notify';
import { afterCommit, toView } from './approvals.shared';

const n = (v: unknown): number => Number(v);
const BATCH = 200;

export interface SweepResult {
  expired: number;
  escalated: number;
  reminded: number;
  rechecked: number;
}

type Kind = 'expire' | 'escalate' | 'remind';

function dueWhere(kind: Kind, at: Date) {
  if (kind === 'expire')
    return {
      [Op.or]: [
        { status: 'PENDING', expiresAt: { [Op.lte]: at } },
        { status: 'CHANGES_REQUESTED', changesDueAt: { [Op.lte]: at } },
      ],
    };
  if (kind === 'escalate') return { status: 'PENDING', escalateAt: { [Op.lte]: at }, escalatedAt: null };
  return { status: 'PENDING', nextReminderAt: { [Op.lte]: at } };
}

/** Still due once the row is locked (BR-01-14: conditions are re-checked, so a second run does nothing). */
function stillDue(r: ApprovalRequest, kind: Kind, at: Date): boolean {
  const le = (d: Date | null) => d !== null && d.getTime() <= at.getTime();
  if (kind === 'expire')
    return (
      (r.status === 'PENDING' && le(r.expiresAt)) || (r.status === 'CHANGES_REQUESTED' && le(r.changesDueAt))
    );
  if (kind === 'escalate') return r.status === 'PENDING' && le(r.escalateAt) && r.escalatedAt === null;
  return r.status === 'PENDING' && le(r.nextReminderAt);
}

async function lockDue(ctx: Ctx, id: number, kind: Kind, at: Date, t: Transaction) {
  const r = await ApprovalRequest.findOne({
    where: { id, societyId: ctx.society!.id },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  return r && stillDue(r, kind, at) ? r : null;
}

function enqueueNotice(t: Transaction, req: ApprovalRequest, event: 'reminder' | 'escalated'): void {
  enqueueAfterCommit(
    t,
    APPROVALS_QUEUE,
    JOB.notifyApprovers,
    { requestId: n(req.id), round: n(req.round), stepNo: n(req.currentStepNo), event },
    { jobId: `notify:${n(req.id)}:${n(req.round)}:${n(req.currentStepNo)}:${event}:${n(req.reminderCount)}` },
  );
}

/** BR-14-22: EXPIRED, then `onExpired` or (default) `onRejected` with reason "Expired". */
async function expireOne(ctx: Ctx, id: number, at: Date, t: Transaction): Promise<boolean> {
  const req = await lockDue(ctx, id, 'expire', at, t);
  if (!req) return false;
  const reason = 'Expired';
  await closeRequest(ctx, req, 'EXPIRED', reason, t);
  const h = requireHandlers(req.type);
  await (h.onExpired ?? h.onRejected)(
    decisionCtx(ctx, req, 'EXPIRED', { actorUserId: null, reason }),
    toView(req),
    t,
  );
  return true;
}

/** BR-14-20: `escalatedAt`, an `ESCALATED` action, `approvals.escalated` to the escalation roles; capacity is recomputed. */
async function escalateOne(ctx: Ctx, id: number, at: Date, t: Transaction): Promise<boolean> {
  const req = await lockDue(ctx, id, 'escalate', at, t);
  if (!req) return false;
  const before = snapshotState(req);
  req.escalatedAt = at;
  req.version = n(req.version) + 1;
  await req.save({ transaction: t });
  await writeAction(ctx, req, 'ESCALATED', t, {
    stepNo: n(req.currentStepNo),
    comment: `Escalated to ${(req.ruleSnapshot?.escalationRoleKeys ?? []).join(', ') || 'no one'}`,
  });
  await audit(
    ctx,
    {
      action: AUDIT.escalated,
      entityType: ENTITY.request,
      entityId: n(req.id),
      entityLabel: req.title,
      societyId: n(req.societyId),
      before,
      after: { ...snapshotState(req), escalationRoleKeys: req.ruleSnapshot?.escalationRoleKeys ?? [] },
    },
    t,
  );
  enqueueNotice(t, req, 'escalated');
  afterCommit(t, () => emitChanged(req));
  return true;
}

/** BR-14-19: a reminder, `reminderCount` + 1, `nextReminderAt` moved forward first (null after the 5th). */
async function remindOne(ctx: Ctx, id: number, at: Date, t: Transaction): Promise<boolean> {
  const req = await lockDue(ctx, id, 'remind', at, t);
  if (!req) return false;
  const count = n(req.reminderCount) + 1;
  req.reminderCount = count;
  req.nextReminderAt =
    count >= LIMITS.maxRemindersPerStep || !req.ruleSnapshot?.reminderEveryHours
      ? null
      : addHours(at, req.ruleSnapshot.reminderEveryHours);
  await req.save({ transaction: t });
  await writeAction(ctx, req, 'REMINDED', t, { stepNo: n(req.currentStepNo), comment: `Reminder ${count}` });
  if (req.hasEligibleApprover) enqueueNotice(t, req, 'reminder');
  return true;
}

const doers: Record<Kind, (ctx: Ctx, id: number, at: Date, t: Transaction) => Promise<boolean>> = {
  expire: expireOne,
  escalate: escalateOne,
  remind: remindOne,
};

async function sweepKind(kind: Kind, at: Date, societyId?: number): Promise<number> {
  let done = 0;
  let last = 0;
  for (;;) {
    const rows = await ApprovalRequest.findAll({
      where: { id: { [Op.gt]: last }, ...(societyId ? { societyId } : {}), ...dueWhere(kind, at) },
      attributes: ['id', 'societyId'],
      order: [['id', 'ASC']],
      limit: BATCH,
    });
    if (!rows.length) return done;
    last = n(rows[rows.length - 1]!.id);
    const allowed = await allowedSocieties(rows.map(r => n(r.societyId)));
    for (const r of rows) {
      const status = allowed.get(n(r.societyId));
      if (!status) continue; // BR-14-30: suspended or closed societies catch up after reactivation
      try {
        if (await sequelize.transaction(t => doers[kind](jobCtx(n(r.societyId), status), n(r.id), at, t)))
          done++;
      } catch (err) {
        logger.error({ err, requestId: r.id, kind }, 'approvals sla-sweep item failed');
      }
    }
    if (rows.length < BATCH) return done;
  }
}

/** Once a day (the 03:xx IST tick) every open request older than one hour gets its capacity recomputed (9.1). */
async function recomputeOld(at: Date): Promise<number> {
  const rows = await ApprovalRequest.findAll({
    where: { status: 'PENDING', routing: 'STEPS', createdAt: { [Op.lte]: addHours(at, -1) } },
    attributes: ['id', 'societyId'],
    order: [['id', 'ASC']],
  });
  const allowed = await allowedSocieties(rows.map(r => n(r.societyId)));
  let changed = 0;
  for (const r of rows) {
    const status = allowed.get(n(r.societyId));
    if (!status) continue;
    try {
      const res = await sequelize.transaction(t =>
        recheckRequest(jobCtx(n(r.societyId), status), n(r.id), t),
      );
      if (res === 'stuck' || res === 'freed') changed++;
    } catch (err) {
      logger.error({ err, requestId: r.id }, 'approvals daily recompute failed');
    }
  }
  return changed;
}

/**
 * Job `approvals:sla-sweep` (9.1, every 15 minutes): expiries (`expiresAt`, `changesDueAt`), escalations, reminders, and once a
 * day the capacity recompute. Societies that do not allow `support` jobs are skipped (BR-14-30).
 */
export async function runSlaSweep(
  o: { at?: Date; societyId?: number; recompute?: boolean } = {},
): Promise<SweepResult> {
  const at = o.at ?? now();
  const expired = await sweepKind('expire', at, o.societyId);
  const escalated = await sweepKind('escalate', at, o.societyId);
  const reminded = await sweepKind('remind', at, o.societyId);
  const clock = istClock(at);
  const daily = o.recompute ?? (clock.hour === 3 && clock.minute < 15);
  const rechecked = daily ? await recomputeOld(at) : 0;
  return { expired, escalated, reminded, rechecked };
}
