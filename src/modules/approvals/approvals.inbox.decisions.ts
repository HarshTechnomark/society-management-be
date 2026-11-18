import { ApprovalRequest, sequelize } from '../../models';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import { typeMeta } from './approvals.catalogue';
import { AUDIT, ENTITY, ERR } from './approvals.constants';
import { approve, reject, requestChanges, withDeadlockRetry } from './approvals.decide';
import { cancelByRequester } from './approvals.engine';
import { seeRequest } from './approvals.history.service';
import { engine, type ReassignInput } from './approvals.inbox.adapter';
import { requestDetail } from './approvals.inbox.detail';
import { loadActions, Viewer } from './approvals.inbox.eval';
import { bulkBelowOf } from './approvals.inbox.service';
import { assertMine } from './approvals.resident.service';

const n = (v: unknown): number => Number(v);

/** 8.7: approve (the version, state, eligibility and step-up checks live in the decision transaction). */
export async function approveRequest(
  ctx: Ctx,
  id: number,
  body: { version: number; comment?: string; onBehalfOfUserId?: number },
) {
  const { req: before } = await seeRequest(ctx, id);
  const stepBefore = n(before.currentStepNo);
  const req = await approve(ctx, id, body);
  const done = req.status === 'APPROVED';
  const advanced = n(req.currentStepNo) > stepBefore;
  const next = req.ruleSnapshot?.steps[n(req.currentStepNo) - 1]?.name;
  return {
    message: done ? 'Approved' : advanced && next ? `Approved. Sent to ${next}` : 'Approved',
    data: {
      id: n(req.id),
      status: req.status,
      currentStepNo: n(req.currentStepNo),
      totalSteps: n(req.totalSteps),
      stepCompleted: done || advanced,
      version: n(req.version),
    },
  };
}

/** 8.8: reject or send back with a reason. */
export async function rejectRequest(
  ctx: Ctx,
  id: number,
  verb: 'reject' | 'changes',
  body: { version: number; reason: string; onBehalfOfUserId?: number },
) {
  await seeRequest(ctx, id);
  const req = await (verb === 'reject' ? reject : requestChanges)(ctx, id, body);
  return { id: n(req.id), status: req.status, version: n(req.version) };
}

/** 8.9 and 8.19: the requester withdraws (the engine checks requester, state, version and `onCancelled`). */
export async function cancelRequest(ctx: Ctx, id: number, body: { version: number; reason: string }) {
  await seeRequest(ctx, id);
  const req = await withDeadlockRetry(() => sequelize.transaction(t => cancelByRequester(ctx, id, body, t)));
  return { id: n(req.id), status: req.status, version: n(req.version) };
}

/** 8.19 resident cancel: same engine path as 8.9, visibility by the resident scope. */
export async function cancelMine(ctx: Ctx, id: number, body: { version: number; reason: string }) {
  await assertMine(ctx, id);
  const req = await withDeadlockRetry(() => sequelize.transaction(t => cancelByRequester(ctx, id, body, t)));
  return { id: n(req.id), status: req.status, version: n(req.version) };
}

/** 8.10: add a named approver to a stuck or current step, then return the detail. */
export async function reassignRequest(ctx: Ctx, id: number, body: ReassignInput) {
  await seeRequest(ctx, id);
  await engine.reassign(ctx, id, body);
  return requestDetail(ctx, id);
}

export interface BulkItemResult {
  id: number;
  ok: boolean;
  status?: string;
  version?: number;
  code?: string;
  message?: string;
}

/** 8.11 and BR-14-27: each item in its own transaction; ineligible items are reported, never touched. */
export async function bulkApprove(ctx: Ctx, items: { id: number; version: number }[]) {
  const societyId = ctx.society!.id;
  const below = await bulkBelowOf(societyId);
  const reqs = await ApprovalRequest.findAll({ where: { societyId, id: items.map(i => i.id) } });
  const byId = new Map(reqs.map(r => [n(r.id), r]));
  const viewer = await Viewer.load(societyId, ctx.user!.id);
  const seen = await viewer.evaluate(reqs, await loadActions(reqs.map(r => n(r.id))));
  const results: BulkItemResult[] = [];
  for (const it of items) {
    const r = byId.get(it.id);
    const fail = (code: string, message: string) => results.push({ id: it.id, ok: false, code, message });
    if (!r || !seen.get(n(r.id))?.visible) {
      fail(ERR.notFound, 'Approval request not found');
      continue;
    }
    if (n(r.version) !== it.version) {
      fail(ERR.stale, 'This item changed. Reload and try again.');
      continue;
    }
    if (r.status !== 'PENDING') {
      fail(ERR.notPending, 'This item was already actioned');
      continue;
    }
    const meta = typeMeta(r.type)!;
    if (r.stepUpRequired) {
      fail(ERR.bulkNotAllowed, 'Needs a fresh code: approve it on its own');
      continue;
    }
    if (!meta.allowBulk || !r.allowBulk || n(r.amountPaise) >= below) {
      fail(ERR.bulkNotAllowed, 'This item cannot be approved in bulk');
      continue;
    }
    try {
      const done = await approve(ctx, it.id, { version: it.version });
      results.push({ id: it.id, ok: true, status: done.status, version: n(done.version) });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      fail(err.code, err.message);
    }
  }
  const approved = results.filter(x => x.ok).length;
  const skipped = results.length - approved;
  if (approved)
    await sequelize.transaction(t =>
      audit(
        ctx,
        {
          action: AUDIT.bulkApproved,
          entityType: ENTITY.request,
          entityId: items[0]!.id,
          societyId,
          after: { approved, skipped, ids: results.filter(x => x.ok).map(x => x.id) },
        },
        t,
      ),
    );
  return { message: `${approved} approved, ${skipped} skipped`, data: { approved, skipped, results } };
}
