import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { ApprovalAction, ApprovalRequest, SocietyMember } from '../../models';
import { logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { computeAccess } from '../access-control/access-control.public';
import { users } from '../auth/auth.public';
import { typeMeta } from './approvals.catalogue';
import { OPEN_STATUSES, type RequestStatus } from './approvals.constants';
import { openSlotFor, slotsOf, stepCapacity, type StepState } from './approvals.match';
import type {
  ApprovalRequestView,
  ApproverMember,
  RuleStep,
  SlotMatch,
  StepOverride,
} from './approvals.types';

const n = (v: unknown): number => Number(v);

/** A plain snapshot of the row for handlers and callers (BIGINT columns as numbers). */
export function toView(r: ApprovalRequest): ApprovalRequestView {
  return {
    id: n(r.id),
    societyId: n(r.societyId),
    type: r.type,
    entityType: r.entityType,
    entityId: n(r.entityId),
    title: r.title,
    summary: r.summary,
    categoryKey: r.categoryKey,
    unitId: r.unitId === null ? null : n(r.unitId),
    amountPaise: n(r.amountPaise),
    payload: r.payload,
    status: r.status,
    routing: r.routing,
    round: n(r.round),
    currentStepNo: n(r.currentStepNo),
    totalSteps: n(r.totalSteps),
    requesterUserId: n(r.requesterUserId),
    requesterKind: r.requesterKind,
    decisionReason: r.decisionReason,
    version: n(r.version),
  };
}
export const isOpen = (status: string): boolean => (OPEN_STATUSES as readonly string[]).includes(status);

/** Runs after the transaction commits; a failing effect is logged and never undoes the decision. */
export function afterCommit(t: Transaction, fn: () => void | Promise<void>): void {
  t.afterCommit(async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, 'approvals after-commit effect failed');
    }
  });
}

/** ACTIVE members holding the approve permission of the type, with their role key (BR-14-9, BR-14-11). */
export async function loadApprovers(societyId: number, type: string): Promise<ApproverMember[]> {
  const perm = typeMeta(type)?.approvePermission;
  if (!perm) return [];
  const rows = await SocietyMember.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['userId'],
  });
  const out: ApproverMember[] = [];
  for (const r of rows) {
    const a = await computeAccess(societyId, n(r.userId));
    if (a.status === 'ACTIVE' && a.roleKey && a.permissions.includes(perm))
      out.push({ userId: n(r.userId), roleKey: a.roleKey });
  }
  return out;
}

/** Role key and status of one member (null when not a member). */
export async function memberInfo(
  societyId: number,
  userId: number,
): Promise<{ active: boolean; roleKey: string | null; permissions: string[] }> {
  const a = await computeAccess(societyId, userId);
  return { active: a.status === 'ACTIVE', roleKey: a.roleKey, permissions: a.permissions };
}

/** The system user (BR-02-58) that owns requests raised by jobs and other modules acting for the platform. */
export const systemUserId = (): Promise<number> => users.getSystemUserId();

export function requireSociety(ctx: Ctx): number {
  const id = ctx.society?.id;
  if (!id) throw new Error('approvals needs ctx.society');
  return id;
}

export const stepOf = (req: ApprovalRequest, stepNo = n(req.currentStepNo)): RuleStep | undefined =>
  req.ruleSnapshot?.steps[stepNo - 1];

/** Actions of the current round: approvers so far (principal and actor), and the slots covered at the current step. */
export async function roundState(req: ApprovalRequest, t?: Transaction) {
  const rows = await ApprovalAction.findAll({
    where: { requestId: req.id, round: req.round, action: 'APPROVED' },
    order: [['id', 'ASC']],
    transaction: t,
  });
  const principals = new Set<number>();
  const actors = new Set<number>();
  const coveredRefs = new Set<string>();
  const coveredCount = { current: 0 };
  for (const a of rows) {
    const actor = a.actorUserId === null ? null : n(a.actorUserId);
    const principal = a.onBehalfOfUserId === null ? actor : n(a.onBehalfOfUserId);
    if (actor !== null) actors.add(actor);
    if (principal !== null) principals.add(principal);
    if (a.stepNo !== null && n(a.stepNo) === n(req.currentStepNo)) {
      coveredCount.current += 1;
      if (a.slotRef) coveredRefs.add(a.slotRef);
    }
  }
  return { rows, principals, actors, coveredRefs, approvedAtStep: coveredCount.current };
}

export interface StepEval {
  step: RuleStep;
  state: StepState;
  members: ApproverMember[];
  need: number;
  ok: boolean;
}
/** Live evaluation of the current step (BR-14-9, BR-14-11): capacity, widening and the slots people may take. */
export function evaluateStep(
  req: ApprovalRequest,
  members: ApproverMember[],
  round: { principals: Set<number>; actors: Set<number>; coveredRefs: Set<string> },
): StepEval | null {
  const step = stepOf(req);
  const snap = req.ruleSnapshot;
  if (!step || !snap) return null;
  const overrides = (req.stepOverrides ?? []) as StepOverride[];
  const slots = slotsOf(step, overrides, n(req.round));
  const excluded = new Set<number>([...round.principals, ...round.actors]);
  if (req.requesterKind !== 'SYSTEM') excluded.add(n(req.requesterUserId));
  const covered = step.mode === 'ALL_OF' ? round.coveredRefs : new Set<string>();
  const cap = stepCapacity(step, slots, members, excluded, snap.fallbackRoleKeys, covered);
  const state: StepState = {
    slots,
    coveredRefs: covered,
    widened: cap.widened,
    fallbackRoleKeys: snap.fallbackRoleKeys,
    vacantRefs: cap.vacantRefs,
    escalationOpen: req.escalatedAt !== null && Boolean(snap.escalationCanApprove),
    escalationRoleKeys: snap.escalationRoleKeys,
  };
  return { step, state, members, need: cap.need, ok: cap.ok };
}

/** The slot a member would cover, or null; maker-checker and distinct-approver rules are applied by the caller. */
export function slotFor(ev: StepEval, member: ApproverMember): SlotMatch | null {
  return openSlotFor(member, ev.step, ev.state);
}

export const statusIsOneOf = (s: string, list: RequestStatus[]): boolean => (list as string[]).includes(s);
export { Op };
