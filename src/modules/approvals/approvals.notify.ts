import { ApprovalAction, ApprovalRequest, SocietyMember } from '../../models';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { registerTemplates } from '../../lib/notify';
import { logger } from '../../lib/logger';
import { computeAccess, usersWithPermission } from '../access-control/access-control.public';
import { typeMeta } from './approvals.catalogue';
import { NOTIFY, PERM, RT, adminRoom } from './approvals.constants';
import { eligibleUserIds } from './approvals.eligibility';
import { approvalsPorts } from './approvals.ports';
import { bumpEpoch } from './approvals.engine.counts';

const n = (v: unknown): number => Number(v);

/** Section 10: data never carries payload PII; it has requestId, typeLabel, title, amountPaise (money types), stepName, reason. */
export function notificationData(req: ApprovalRequest, extra: Record<string, unknown> = {}) {
  const meta = typeMeta(req.type);
  const step = req.ruleSnapshot?.steps[n(req.currentStepNo) - 1];
  return {
    requestId: n(req.id),
    typeLabel: meta?.label ?? req.type,
    title: req.title,
    ...(meta?.isMoney ? { amountPaise: n(req.amountPaise) } : {}),
    ...(step ? { stepName: step.name } : {}),
    ...extra,
  };
}

export async function sendTo(
  template: string,
  userIds: number[],
  data: Record<string, unknown>,
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  try {
    await approvalsPorts().notifications.send(template, ids, data);
  } catch (err) {
    logger.error({ err, template }, 'approvals notification failed');
  }
}

/** Section 9.3: `approvals.changed` for the admin room (no title, amount or names) and `approvals.request.updated` for the requester. */
export async function emitChanged(req: ApprovalRequest): Promise<void> {
  const base = { requestId: n(req.id), type: req.type, status: req.status };
  emitToRoom(adminRoom(n(req.societyId)), RT.changed, { ...base, currentStepNo: n(req.currentStepNo) });
  emitToUser(n(req.requesterUserId), RT.requestUpdated, {
    ...base,
    entityType: req.entityType,
    entityId: n(req.entityId),
  });
  await bumpEpoch(n(req.societyId)); // 8.2: the counts cache key changes after every commit that changes a request
}
export function emitStuck(req: ApprovalRequest): void {
  emitToRoom(adminRoom(n(req.societyId)), RT.stuck, {
    requestId: n(req.id),
    type: req.type,
    stuckAt: req.stuckAt?.toISOString() ?? null,
  });
}

/** Chairman(s) and members with `settings.approval_rules.edit` (rule editors). */
export async function adminAudience(societyId: number): Promise<number[]> {
  const editors = await usersWithPermission(societyId, PERM.rulesEdit);
  const members = await SocietyMember.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['userId'],
  });
  const chairmen: number[] = [];
  for (const m of members)
    if ((await computeAccess(societyId, n(m.userId))).roleKey === 'chairman') chairmen.push(n(m.userId));
  return [...new Set([...editors, ...chairmen])];
}
export async function notifyStuck(req: ApprovalRequest): Promise<void> {
  await sendTo(NOTIFY.unroutable, await adminAudience(n(req.societyId)), notificationData(req));
}

/** Requester notice of a final or changes decision, only when the type's `notifyRequester` is set (BR-14-31). */
export async function notifyRequester(
  req: ApprovalRequest,
  template: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!typeMeta(req.type)?.notifyRequester || req.requesterKind === 'SYSTEM') return;
  await sendTo(template, [n(req.requesterUserId)], notificationData(req, extra));
}

/** `approvals.closed`: those who approved an earlier step of this round are told when the request ends without approval. */
export async function notifyClosed(req: ApprovalRequest, reason: string | null): Promise<void> {
  const rows = await ApprovalAction.findAll({
    where: { requestId: req.id, round: req.round, action: 'APPROVED' },
    attributes: ['actorUserId', 'onBehalfOfUserId'],
  });
  const ids = rows
    .flatMap(r => [r.actorUserId, r.onBehalfOfUserId])
    .filter((x): x is number => x !== null)
    .map(Number);
  await sendTo(NOTIFY.closed, ids, notificationData(req, { reason, status: req.status }));
}

/** Processor of `approvals:notify-approvers` (9.1): recompute the eligible approvers and tell them. */
export async function notifyApproversJob(data: Record<string, unknown>): Promise<void> {
  const req = await ApprovalRequest.findByPk(Number(data.requestId));
  if (
    !req ||
    req.status !== 'PENDING' ||
    n(req.round) !== Number(data.round) ||
    n(req.currentStepNo) !== Number(data.stepNo)
  )
    return;
  const event = String(data.event ?? 'pending');
  const template =
    event === 'reminder' ? NOTIFY.reminder : event === 'escalated' ? NOTIFY.escalated : NOTIFY.pending;
  const to = event === 'escalated' ? await escalationAudience(req) : await eligibleUserIds(req);
  await sendTo(template, to, notificationData(req));
}
async function escalationAudience(req: ApprovalRequest): Promise<number[]> {
  const roles = new Set(req.ruleSnapshot?.escalationRoleKeys ?? []);
  const members = await SocietyMember.findAll({
    where: { societyId: req.societyId, status: 'ACTIVE' },
    attributes: ['userId'],
  });
  const out: number[] = [];
  for (const m of members) {
    const a = await computeAccess(n(req.societyId), n(m.userId));
    if (a.roleKey && roles.has(a.roleKey)) out.push(n(m.userId));
  }
  return out;
}

/** Plain templates for the stand-in `notify()`; module 16 owns the real copy. */
export function registerApprovalTemplates(): void {
  const t = (subject: string, channels: ('EMAIL' | 'PUSH')[] = ['EMAIL', 'PUSH']) => ({
    channels,
    critical: false,
    render: (d: Record<string, any>) => ({
      email: {
        subject: `${subject}: ${d.title ?? ''}`,
        text: `${subject}: ${d.typeLabel ?? ''} "${d.title ?? ''}"${d.reason ? `. Reason: ${d.reason}` : ''}`,
      },
      link: `/approvals?id=${d.requestId}`,
    }),
  });
  registerTemplates({
    [NOTIFY.pending]: t('Waiting for your decision'),
    [NOTIFY.reminder]: t('Reminder: waiting for your decision'),
    [NOTIFY.escalated]: t('Escalated approval'),
    [NOTIFY.approved]: t('Approved'),
    [NOTIFY.rejected]: t('Rejected'),
    [NOTIFY.changesRequested]: t('Changes requested'),
    [NOTIFY.expired]: t('Expired'),
    [NOTIFY.closed]: t('Closed without approval'),
    [NOTIFY.unroutable]: t('Approval cannot be routed'),
    [NOTIFY.ruleHealth]: t('Approval rule may be unsatisfiable'),
    [NOTIFY.delegationCreated]: t('Approval delegation created'),
    [NOTIFY.delegationEnding]: t('Approval delegation ending'),
    [NOTIFY.delegationRevoked]: t('Approval delegation revoked'),
  });
}
