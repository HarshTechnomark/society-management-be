import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { ApprovalDelegation, type ApprovalRequest } from '../../models';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { AppError, ConflictError, ForbiddenError, UnprocessableError } from '../../utils/errors';
import { entitlements } from '../subscriptions/subscriptions.public';
import { ENT, ERR } from './approvals.constants';
import { evaluateStep, loadApprovers, roundState, slotFor, type StepEval } from './approvals.shared';
import type { ApproverMember, SlotMatch } from './approvals.types';

const n = (v: unknown): number => Number(v);

type Round = Awaited<ReturnType<typeof roundState>>;
export interface Identity {
  principalUserId: number;
  delegationId: number | null;
}
export type IdentityEval =
  { ok: true; slot: SlotMatch; roleKey: string } | { ok: false; code: 'MAKER' | 'ACTED' | 'NOT_ELIGIBLE' };

/** BR-14-23: the ACTIVE delegations that let `userId` act for someone on this request now (window, type, amount, plan). */
export async function activeDelegationsTo(
  societyId: number,
  userId: number,
  req: Pick<ApprovalRequest, 'type' | 'amountPaise'>,
  at: Date = now(),
  t?: Transaction,
): Promise<ApprovalDelegation[]> {
  const rows = await ApprovalDelegation.findAll({
    where: {
      societyId,
      delegateUserId: userId,
      status: 'ACTIVE',
      startsAt: { [Op.lte]: at },
      endsAt: { [Op.gt]: at },
    },
    transaction: t,
  });
  return filterDelegations(societyId, rows, req);
}
/** Delegations by delegator, for computing who may be told about a request. */
export async function activeDelegationsFrom(
  societyId: number,
  req: Pick<ApprovalRequest, 'type' | 'amountPaise'>,
  at: Date = now(),
  t?: Transaction,
): Promise<ApprovalDelegation[]> {
  const rows = await ApprovalDelegation.findAll({
    where: { societyId, status: 'ACTIVE', startsAt: { [Op.lte]: at }, endsAt: { [Op.gt]: at } },
    transaction: t,
  });
  return filterDelegations(societyId, rows, req);
}
async function filterDelegations(
  societyId: number,
  rows: ApprovalDelegation[],
  req: Pick<ApprovalRequest, 'type' | 'amountPaise'>,
): Promise<ApprovalDelegation[]> {
  const out: ApprovalDelegation[] = [];
  let oooOn: boolean | undefined;
  for (const d of rows) {
    if (d.types !== null && !d.types.includes(req.type)) continue;
    if (d.maxAmountPaise !== null && n(req.amountPaise) > n(d.maxAmountPaise)) continue;
    if (d.source === 'OUT_OF_OFFICE') {
      oooOn ??= await entitlements.isFeatureOn(societyId, ENT.delegation);
      if (!oooOn) continue;
    }
    out.push(d);
  }
  return out;
}

/** BR-14-7, BR-14-8, BR-14-9 for one identity (actor acting for the principal; both are the same person when not delegated). */
export function evaluateIdentity(
  req: ApprovalRequest,
  ev: StepEval,
  round: Round,
  actorUserId: number,
  principalUserId: number,
): IdentityEval {
  if (req.requesterKind !== 'SYSTEM') {
    const maker = n(req.requesterUserId);
    if (actorUserId === maker || principalUserId === maker) return { ok: false, code: 'MAKER' };
  }
  const acted = (u: number) => round.principals.has(u) || round.actors.has(u);
  if (acted(actorUserId) || acted(principalUserId)) return { ok: false, code: 'ACTED' };
  const member: ApproverMember | undefined = ev.members.find(m => m.userId === principalUserId);
  if (!member) return { ok: false, code: 'NOT_ELIGIBLE' };
  const slot = slotFor(ev, member);
  if (!slot) return { ok: false, code: 'NOT_ELIGIBLE' };
  return { ok: true, slot, roleKey: member.roleKey };
}

const ERRORS: Record<'MAKER' | 'ACTED' | 'NOT_ELIGIBLE', () => AppError> = {
  MAKER: () => new ConflictError(ERR.makerChecker, 'You created this. A different person must approve.'),
  ACTED: () => new ConflictError(ERR.alreadyActed, 'You already approved this item'),
  NOT_ELIGIBLE: () => new ForbiddenError(ERR.notEligible, 'You cannot decide this item at its current step'),
};

export interface Resolved {
  principalUserId: number;
  delegationId: number | null;
  slot: SlotMatch;
  roleKey: string;
  onBehalf: boolean;
}

/**
 * BR-14-25: the identity a decision is taken under. Self first; else the one delegated identity that is eligible; `422
 * ON_BEHALF_REQUIRED` when several are; `403 NO_ACTIVE_DELEGATION` when `onBehalfOfUserId` names someone without a delegation.
 * Errors follow the best identity: maker-checker and already-acted beat not-eligible.
 */
export async function resolveIdentity(
  ctx: Ctx,
  req: ApprovalRequest,
  ev: StepEval,
  round: Round,
  onBehalfOfUserId: number | undefined,
  t: Transaction,
): Promise<Resolved> {
  const actor = ctx.user!.id;
  const societyId = n(req.societyId);
  const delegations = await activeDelegationsTo(societyId, actor, req, now(), t);
  if (onBehalfOfUserId !== undefined && onBehalfOfUserId !== actor) {
    const d = delegations.find(x => n(x.delegatorUserId) === onBehalfOfUserId);
    if (!d) throw new ForbiddenError(ERR.noDelegation, 'You have no active delegation from that person');
    const r = evaluateIdentity(req, ev, round, actor, onBehalfOfUserId);
    if (!r.ok) throw ERRORS[r.code]();
    return {
      principalUserId: onBehalfOfUserId,
      delegationId: n(d.id),
      slot: r.slot,
      roleKey: r.roleKey,
      onBehalf: true,
    };
  }
  const self = evaluateIdentity(req, ev, round, actor, actor);
  if (self.ok)
    return {
      principalUserId: actor,
      delegationId: null,
      slot: self.slot,
      roleKey: self.roleKey,
      onBehalf: false,
    };
  const viaDelegation: Resolved[] = [];
  let best: 'MAKER' | 'ACTED' | 'NOT_ELIGIBLE' = self.code;
  for (const d of delegations) {
    const r = evaluateIdentity(req, ev, round, actor, n(d.delegatorUserId));
    if (r.ok)
      viaDelegation.push({
        principalUserId: n(d.delegatorUserId),
        delegationId: n(d.id),
        slot: r.slot,
        roleKey: r.roleKey,
        onBehalf: true,
      });
    else if (rank(r.code) > rank(best)) best = r.code;
  }
  if (viaDelegation.length === 1) return viaDelegation[0]!;
  if (viaDelegation.length > 1)
    throw new UnprocessableError(ERR.onBehalfRequired, 'Choose whom you are acting for', [
      { field: 'onBehalfOfUserId', message: 'More than one delegation applies' },
    ]);
  throw ERRORS[best]();
}
const rank = (c: 'MAKER' | 'ACTED' | 'NOT_ELIGIBLE'): number => (c === 'MAKER' ? 2 : c === 'ACTED' ? 1 : 0);

/** User ids who may act on the current step now (themselves or through a delegation): the audience of `approvals.pending`. */
export async function eligibleUserIds(req: ApprovalRequest, t?: Transaction): Promise<number[]> {
  const societyId = n(req.societyId);
  const members = await loadApprovers(societyId, req.type);
  const round = await roundState(req, t);
  const ev = evaluateStep(req, members, round);
  if (!ev) return [];
  const principals: number[] = [];
  for (const m of members) {
    const r = evaluateIdentity(req, ev, round, m.userId, m.userId);
    if (r.ok) principals.push(m.userId);
  }
  const out = new Set(principals);
  const delegations = await activeDelegationsFrom(societyId, req, now(), t);
  for (const d of delegations) {
    const p = n(d.delegatorUserId);
    const r = evaluateIdentity(req, ev, round, n(d.delegateUserId), p);
    if (r.ok) out.add(n(d.delegateUserId));
  }
  return [...out];
}
