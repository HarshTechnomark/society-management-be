import type { Transaction } from 'sequelize';
import { Role, sequelize } from '../../models';
import { addDays, now } from '../../lib/clock';
import { AppError, ForbiddenError, PaymentRequiredError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { members, roles as roleApi, changeRole, endMember } from '../access-control/access-control.public';
import { residents } from '../residents/residents.public';
import { entitlements } from '../subscriptions/subscriptions.public';
import { holderBlockers, type HolderToCheck } from './committee.holders';
import {
  buildActions,
  handoverPairs,
  previewHash,
  staffSeatEffect,
  type ActivationAction,
  type BuiltPlan,
  type HandoverPair,
  type IncomingHolder,
  type OutgoingHolder,
  type PlanBlocker,
  type PlanFacts,
  type PlanWarning,
} from './committee.planner';
import { committeePorts } from './committee.ports';
import type { SeatJson } from './committee.schemas';
import { rule } from './committee.shared';
import type { Designation } from './committee.constants';
import { DESIGNATION_LABEL } from './committee.constants';

/**
 * The part of activation (6.3) and mid-term changes (6.4) both need: facts about the people, the role plan with its blockers and
 * warnings, the authority rules of BR-10-14, the module 03 calls in the planned order and the hand-over delegations of BR-10-18.
 */
export type Authority = 'NONE' | 'ENFORCE' | 'FIRST';

export interface PlanInput {
  ctx: Ctx;
  societyId: number;
  termId: number;
  termVersion: number;
  currentTermId: number | null;
  currentTermVersion: number | null;
  outs: OutgoingHolder[];
  ins: IncomingHolder[];
  /** Holders to check for BR-10-7 and BR-10-8 (seat id, user, flat). */
  eligibility: HolderToCheck[];
  /** Seated holders before and after, for the delegations. */
  before: Pick<SeatJson, 'designation' | 'userId' | 'name'>[];
  after: Pick<SeatJson, 'designation' | 'userId' | 'name'>[];
  authority: Authority;
  ownersOnly: boolean;
  /** Blockers found by the caller (term not started, office bearers missing). */
  extra?: PlanBlocker[];
}

export interface PlanResult {
  actions: ActivationAction[];
  staffSeats: { limit: number | null; used: number; delta: number };
  pairs: HandoverPair[];
  warnings: PlanWarning[];
  blockers: PlanBlocker[];
  hash: string;
  built: BuiltPlan;
}

async function loadFacts(societyId: number, userIds: number[], outIds: number[]): Promise<PlanFacts> {
  const [rows, roleRows] = await Promise.all([
    userIds.length ? members.listForSociety(societyId, { userIds }) : [],
    Role.findAll({ where: { societyId }, paranoid: false }),
  ]);
  const memberMap = new Map(
    rows.map(r => [
      r.userId,
      {
        userId: r.userId,
        memberId: r.memberId,
        roleKey: r.roleKey,
        status: r.status,
        consumesSeat: r.consumesSeat,
      },
    ]),
  );
  const relations = new Map<number, string[]>();
  for (const id of outIds)
    relations.set(
      id,
      (await residents.getActiveUnitLinks(societyId, id)).map(l => l.relation),
    );
  return {
    members: memberMap,
    roles: new Map(
      roleRows.map(r => [
        r.key,
        { key: r.key, scope: r.scope as string, isSystem: r.isSystem, consumesSeat: r.consumesSeat },
      ]),
    ),
    relations,
  };
}

const keysOf = (societyId: number, roleKey: string): Promise<string[]> =>
  roleApi.getPermissionKeys(societyId, roleKey);

/** BR-10-14. `FIRST` (first committee, MANUAL) needs `settings.roles.edit`; `ENFORCE` is the no-escalation and self-change rule. */
async function authorityBlockers(
  ctx: Ctx,
  societyId: number,
  actions: ActivationAction[],
  authority: Authority,
): Promise<PlanBlocker[]> {
  if (!ctx.user || authority === 'NONE') return [];
  if (authority === 'FIRST') {
    if (!ctx.permissions?.has('settings.roles.edit'))
      throw new ForbiddenError(
        'PERMISSION_DENIED',
        'Seating the first committee needs the permission to manage roles',
      );
    return [];
  }
  const out: PlanBlocker[] = [];
  const mine = actions.filter(a => a.kind !== 'NONE' && a.userId === ctx.user!.id);
  const selfBad: number[] = [];
  for (const a of mine) {
    if (a.kind === 'END_MEMBERSHIP') selfBad.push(a.userId);
    else if (a.kind === 'CHANGE_ROLE') {
      const [from, to] = [await keysOf(societyId, a.fromRoleKey), await keysOf(societyId, a.toRoleKey)];
      if (!to.every(k => from.includes(k))) selfBad.push(a.userId); // only stepping down is allowed
    }
  }
  if (selfBad.length)
    out.push({
      code: 'SELF_CHANGE',
      message: 'You cannot change your own role here, except to step down',
      userIds: selfBad,
    });
  const missing = new Set<string>();
  for (const a of actions)
    if (a.kind === 'CHANGE_ROLE' && a.reason !== 'OUTGOING')
      for (const k of await keysOf(societyId, a.toRoleKey)) if (!ctx.permissions?.has(k)) missing.add(k);
  if (missing.size)
    out.push({
      code: 'UNHELD_PERMISSION',
      message: 'You cannot give a role that has more access than you have',
      permissionKeys: [...missing].sort(),
    });
  return out;
}

const PRIORITY = [
  'TERM_NOT_STARTED',
  'OFFICE_BEARERS_REQUIRED',
  'HOLDER_NOT_MEMBER',
  'HOLDER_NOT_ACTIVE',
  'HOLDER_INELIGIBLE',
  'ROLE_CONFLICT',
  'SELF_CHANGE',
  'UNHELD_PERMISSION',
  'NO_FREE_SEAT',
];
const rank = (code: string): number => {
  const i = PRIORITY.indexOf(code);
  return i < 0 ? PRIORITY.length : i;
};

/** Computes the plan (no side effects). Throws only `403 PERMISSION_DENIED` for the first-committee authority rule. */
export async function evaluatePlan(i: PlanInput): Promise<PlanResult> {
  const userIds = [...new Set([...i.ins.map(x => x.userId), ...i.outs.map(x => x.userId)])];
  const facts = await loadFacts(
    i.societyId,
    userIds,
    i.outs.map(o => o.userId),
  );
  const built = buildActions(i.outs, i.ins, facts);
  const usage = await entitlements.getUsage(i.societyId, 'limit.admin_seats');
  const seats = staffSeatEffect(built.actions, usage);
  const blockers = [
    ...(i.extra ?? []),
    ...(await holderBlockers(i.societyId, i.eligibility, i.ownersOnly)),
    ...built.blockers,
    ...(await authorityBlockers(i.ctx, i.societyId, built.actions, i.authority)),
    ...seats.blockers,
  ].sort((a, b) => rank(a.code) - rank(b.code));
  return {
    actions: built.actions,
    staffSeats: seats.staffSeats,
    pairs: handoverPairs(i.before, i.after),
    warnings: built.warnings,
    blockers,
    hash: previewHash({
      termId: i.termId,
      termVersion: i.termVersion,
      currentTermId: i.currentTermId,
      currentTermVersion: i.currentTermVersion,
      actions: built.actions,
    }),
    built,
  };
}

/** The body of the two previews (8.7, 8.9). */
export async function previewBody(i: PlanInput, p: PlanResult, days: number) {
  return {
    termId: i.termId,
    termVersion: i.termVersion,
    currentTermId: i.currentTermId,
    currentTermVersion: i.currentTermVersion,
    actions: p.actions,
    staffSeats: p.staffSeats,
    handoverDelegations: p.pairs.map(x => ({ ...x, days })),
    warnings: p.warnings,
    blockers: p.blockers,
    previewHash: p.hash,
  };
}

const BLOCKER_ERROR: Record<string, [number, string]> = {
  TERM_NOT_STARTED: [422, 'COMMITTEE_TERM_NOT_STARTED'],
  OFFICE_BEARERS_REQUIRED: [422, 'COMMITTEE_OFFICE_BEARERS_REQUIRED'],
  HOLDER_NOT_MEMBER: [422, 'COMMITTEE_HOLDER_NOT_MEMBER'],
  HOLDER_NOT_ACTIVE: [422, 'COMMITTEE_HOLDER_NOT_ACTIVE'],
  HOLDER_INELIGIBLE: [422, 'COMMITTEE_HOLDER_INELIGIBLE'],
  ROLE_CONFLICT: [422, 'COMMITTEE_ROLE_CONFLICT'],
  SELF_CHANGE: [403, 'SELF_CHANGE_NOT_ALLOWED'],
  UNHELD_PERMISSION: [403, 'CANNOT_GRANT_UNHELD_PERMISSION'],
  NO_FREE_SEAT: [402, 'USAGE_LIMIT_EXCEEDED'],
};

/** Throws the error of the first blocker (section 12 codes). `seatBlockers` picks the staff seat blocker or every other one. */
export function throwFirstBlocker(blockers: PlanBlocker[], seatBlockers: boolean): void {
  const b = blockers.find(x => (x.code === 'NO_FREE_SEAT') === seatBlockers);
  if (!b) return;
  const [status, code] = BLOCKER_ERROR[b.code] ?? [422, `COMMITTEE_${b.code}`];
  if (code === 'USAGE_LIMIT_EXCEEDED')
    throw new PaymentRequiredError(code, b.message, [
      { field: 'limitKey', message: 'limit.admin_seats', userIds: b.userIds ?? [] },
    ]);
  if (code === 'CANNOT_GRANT_UNHELD_PERMISSION')
    throw new AppError(
      403,
      code,
      b.message,
      (b.permissionKeys ?? []).map(k => ({ field: 'permissionKey', message: k })),
    );
  if (status === 403) throw new ForbiddenError(code, b.message);
  throw rule(code, b.message, 'seats', {
    ...(b.seatIds ? { seatIds: b.seatIds } : {}),
    ...(b.userIds ? { userIds: b.userIds } : {}),
  });
}

/** `409 COMMITTEE_PREVIEW_STALE` when the plan the admin saw is not the plan now (BR-10-13). */
export function assertHash(p: PlanResult, given: string): void {
  if (p.hash !== given)
    throw new AppError(
      409,
      'COMMITTEE_PREVIEW_STALE',
      'The plan changed since you reviewed it. Review it again and confirm.',
    );
}

/**
 * Step 6 of 6.3: the module 03 calls in the planned order, inside the caller's transaction. Module 03 applies the last-chairman
 * guard (BR-03-8) and its seat rule on every call; any error passes through and rolls back the whole transaction.
 */
export async function runActions(
  ctx: Ctx,
  actions: ActivationAction[],
  context: string,
  t: Transaction,
): Promise<{ roleChanges: number; membershipsEnded: number }> {
  let roleChanges = 0;
  let membershipsEnded = 0;
  for (const a of actions) {
    if (a.kind === 'NONE') continue;
    const reason = `${context}: ${a.kind === 'CHANGE_ROLE' && a.reason === 'OUTGOING' ? 'left the committee' : a.kind === 'END_MEMBERSHIP' ? 'left the committee, no flat linked' : 'new role'}`;
    if (a.kind === 'CHANGE_ROLE') {
      await changeRole(ctx, a.memberId, a.toRoleKey, reason, t, { via: 'committee' });
      roleChanges++;
    } else {
      await endMember(ctx, a.memberId, reason, t, { via: 'committee' });
      membershipsEnded++;
    }
  }
  return { roleChanges, membershipsEnded };
}

const SKIPPABLE = [
  'DELEGATION_OVERLAP',
  'DELEGATION_CHAIN_NOT_ALLOWED',
  'DELEGATE_NOT_ELIGIBLE',
  'DELEGATION_WINDOW_INVALID',
  'DELEGATION_SELF',
];
export interface SkippedDelegation {
  designation: Designation;
  fromUserId: number;
  toUserId: number;
  skippedBecause: string;
}

/**
 * BR-10-18: one module 14 call per pair, each in its own savepoint. A refusal with one of the five module 14 codes rolls back
 * that savepoint only; the skip is returned (and audited by the caller). Any other error aborts the activation.
 */
export async function createDelegations(
  ctx: Ctx,
  pairs: HandoverPair[],
  o: { termName: string; committeeTermId: number; days: number },
  t: Transaction,
): Promise<{ created: number; skipped: SkippedDelegation[] }> {
  const startsAt = now();
  const endsAt = addDays(startsAt, o.days);
  const skipped: SkippedDelegation[] = [];
  let created = 0;
  for (const p of pairs) {
    try {
      await sequelize.transaction({ transaction: t }, st =>
        committeePorts().approvals.createHandoverDelegation(
          ctx,
          {
            fromUserId: p.fromUserId,
            toUserId: p.toUserId,
            startsAt,
            endsAt,
            reason: `Committee hand-over: ${o.termName}`.slice(0, 200),
            committeeTermId: o.committeeTermId,
          },
          st,
        ),
      );
      created++;
    } catch (err) {
      if (err instanceof AppError && SKIPPABLE.includes(err.code))
        skipped.push({
          designation: p.designation,
          fromUserId: p.fromUserId,
          toUserId: p.toUserId,
          skippedBecause: err.code,
        });
      else throw err;
    }
  }
  return { created, skipped };
}

export const designationLabel = (d: Designation): string => DESIGNATION_LABEL[d];
