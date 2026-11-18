import { randomUUID } from 'node:crypto';
import { ApprovalRequest, ApprovalRule, Society, User } from '../../src/models';
import { decide, decideAsCommittee, memberCtx } from '../../src/modules/approvals/approvals.public';
import { computeAccess } from '../../src/modules/access-control/access-control.public';
import { AppError } from '../../src/utils/errors';
import type { Ctx } from '../../src/types/context';
import { loadApprovers } from '../../src/modules/approvals/approvals.shared';
import { memberUser } from './access';
import { makeUser } from './auth';

export const OFFICERS = ['chairman', 'treasurer', 'secretary'] as const;

/**
 * Module 14 is real in every test (`approvals-decide`): a request is decided through the engine (`decide`), never by calling the type hook. Before
 * deciding, the society gets one ACTIVE chairman, treasurer and secretary besides the requester and `exclude` when it lacks
 * them (the default rules of 7.5 need one or two of them). Returns the request row after the decision(s).
 */
export async function committeeDecide(
  requestId: number,
  verb: 'APPROVE' | 'REJECT' | 'CHANGES' = 'APPROVE',
  o: { reason?: string; exclude?: number[] } = {},
): Promise<ApprovalRequest> {
  const req = await ApprovalRequest.findByPk(requestId);
  if (!req) throw new Error(`approval request ${requestId} not found`);
  const societyId = Number(req.societyId);
  const skip = new Set<number>([Number(req.requesterUserId), ...(o.exclude ?? [])]);
  const members = (await loadApprovers(societyId, req.type)).filter(m => !skip.has(m.userId));
  const society = await Society.findByPk(societyId);
  for (const role of OFFICERS)
    if (!members.some(m => m.roleKey === role)) await memberUser(society!, role, { name: `Test ${role}` });
  return decideAsCommittee(requestId, verb, o);
}

export const committeeApprove = (requestId: number, exclude?: number[]) =>
  committeeDecide(requestId, 'APPROVE', { exclude });
export const committeeReject = (
  requestId: number,
  reason = 'Rejected by the committee',
  exclude?: number[],
) => committeeDecide(requestId, 'REJECT', { reason, exclude });
export const committeeChanges = (requestId: number, reason = 'Please change this', exclude?: number[]) =>
  committeeDecide(requestId, 'CHANGES', { reason, exclude });

/**
 * A custom rule of `type` in the society: every request needs one of `roles` (BR-14-6: a society with any rule row of a type
 * gets no default rules). Tests use it where the module's flow is "always PENDING" (the placeholders' old behaviour).
 */
export async function everyRequestNeeds(
  societyId: number,
  type: string,
  roles: string[] = ['treasurer', 'chairman'],
): Promise<void> {
  await ApprovalRule.create({
    societyId,
    type,
    name: `Every ${type.toLowerCase().replace(/_/g, ' ')}`,
    priority: 1,
    steps: [
      { stepNo: 1, name: 'Test step', mode: 'ANY_OF', roleKeys: roles, userIds: [], requiredCount: null },
    ],
    action: 'REQUIRE_APPROVAL',
  } as never);
}

/** Turns every live rule of `type` (all societies) into an auto-approval: `request` runs `onApproved` and answers APPROVED. */
export async function autoApproveType(type: string, societyId?: number): Promise<void> {
  const where = societyId ? { type, societyId } : { type };
  if (!(await ApprovalRule.count({ where })) && societyId) {
    await ApprovalRule.create({
      societyId,
      type,
      name: 'Auto',
      priority: 1,
      steps: [],
      action: 'AUTO_APPROVE',
    } as never);
    return;
  }
  await ApprovalRule.update({ action: 'AUTO_APPROVE', steps: [] } as never, { where });
}

type Caller = (
  m: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body?: unknown,
  o?: { headers?: Record<string, string>; query?: Record<string, unknown> },
) => Promise<{ status: number; body: any }>;

/** A decision over HTTP (`POST /approvals/:id/approve|reject|request-changes`) by the signed-in caller `c`, at the current version. */
export async function decideOver(
  c: Caller,
  requestId: number,
  decision: 'approve' | 'reject' | 'request-changes' = 'approve',
  reason = 'Decided in the test',
) {
  const row = await ApprovalRequest.findByPk(requestId);
  const version = row ? Number(row.version) : 1;
  return c(
    'post',
    `/approvals/${requestId}/${decision}`,
    decision === 'approve' ? { version } : { version, reason },
    {
      headers: { 'Idempotency-Key': randomUUID() },
    },
  );
}

/** The latest request of an entity (id), or undefined. */
export async function requestOf(type: string, entityId: number): Promise<ApprovalRequest | null> {
  return ApprovalRequest.findOne({ where: { type, entityId }, order: [['id', 'DESC']] });
}

/** Module 14 raises requests of system contexts (jobs, owner modules) as the system user: make sure it exists. */
export async function ensureSystemUser(): Promise<void> {
  if (await User.count({ where: { status: 'SYSTEM' } })) return;
  await makeUser({ status: 'SYSTEM', email: 'system@societyapp.in', password: null, name: 'System' });
}

/**
 * Inbox decisions with the signature of the retired development hooks (`approve(id, ctx)`, `reject(id, reason, ctx)`,
 * `requestChanges(id, ctx)`), now through the real engine: the person of `ctx` decides when `ctx` names a member (so
 * maker-checker and eligibility apply), else the committee does. An approval completes the request (a second officer signs
 * when the rule needs two). Deciding a request that is no longer pending changes nothing and returns its state.
 */
async function hookDecide(
  requestId: number,
  ctx: Ctx | null,
  verb: 'APPROVE' | 'REJECT' | 'CHANGES',
  reason?: string,
) {
  const req = await ApprovalRequest.findByPk(requestId);
  if (!req) throw new AppError(404, 'APPROVAL_NOT_FOUND', 'Approval request not found');
  const out = () => ({ type: req.type, entityId: Number(req.entityId), status: req.status });
  if (req.status !== 'PENDING') return out();
  const userId = ctx?.user?.id;
  const member =
    userId !== undefined && (await computeAccess(Number(req.societyId), userId)).status === 'ACTIVE';
  let done = false;
  if (member)
    try {
      await decide(await memberCtx(Number(req.societyId), userId!), requestId, verb, {
        version: Number(req.version),
        ...(verb === 'APPROVE' ? {} : { reason: reason ?? 'Decided in the test' }),
      });
      done = true;
      await req.reload();
      if (verb === 'APPROVE' && req.status === 'PENDING') await committeeDecide(requestId, 'APPROVE');
    } catch (err) {
      // a member the rule does not name (another role): the committee decides, as the old stand-in let anyone do
      if (!(err instanceof AppError) || err.code !== 'NOT_ELIGIBLE_APPROVER') throw err;
    }
  if (!done) await committeeDecide(requestId, verb, { reason });
  await req.reload();
  return out();
}
export const approve = (requestId: number, ctx?: Ctx | null) => hookDecide(requestId, ctx ?? null, 'APPROVE');
export const reject = (requestId: number, reason: string, ctx?: Ctx | null) =>
  hookDecide(requestId, ctx ?? null, 'REJECT', reason.length >= 5 ? reason : `${reason} (test)`);
export const requestChanges = (requestId: number, ctx?: Ctx | null, reason = 'Please change this') =>
  hookDecide(requestId, ctx ?? null, 'CHANGES', reason);

/** The module 14 requests made so far (what the placeholders used to record as `approvals.request`), oldest first. */
export async function approvalRequests(where: Record<string, unknown> = {}) {
  const rows = await ApprovalRequest.findAll({ where, order: [['id', 'ASC']] });
  return rows.map(r => ({
    id: Number(r.id),
    type: r.type,
    entityType: r.entityType,
    entityId: Number(r.entityId),
    title: r.title,
    summary: r.summary,
    amountPaise: Number(r.amountPaise),
    payload: r.payload,
    status: r.status,
    round: Number(r.round),
    routing: r.routing,
    categoryKey: r.categoryKey,
    unitId: r.unitId === null ? null : Number(r.unitId),
    requesterUserId: Number(r.requesterUserId),
  }));
}
