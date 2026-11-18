import { Op } from 'sequelize';
import { ApprovalAction, ApprovalDelegation, type ApprovalRequest } from '../../models';
import { now } from '../../lib/clock';
import { computeAccess } from '../access-control/access-control.public';
import { entitlements } from '../subscriptions/subscriptions.public';
import { typeMeta } from './approvals.catalogue';
import { ENT, OPEN_STATUSES } from './approvals.constants';
import { evaluateIdentity } from './approvals.eligibility';
import { needOf, slotsOf } from './approvals.match';
import { evaluateStep, loadApprovers, stepOf } from './approvals.shared';
import type { ApproverMember } from './approvals.types';

const n = (v: unknown): number => Number(v);

export type MyReason = 'MAKER_CHECKER' | 'ALREADY_ACTED' | 'NOT_IN_STEP' | 'NO_PERMISSION';
export const REASON_TEXT: Record<MyReason, string> = {
  MAKER_CHECKER: 'You created this. A different person must approve.',
  ALREADY_ACTED: 'You already approved this item.',
  NOT_IN_STEP: 'Waiting for another approver.',
  NO_PERMISSION: 'You do not have permission to approve this type.',
};

export interface MyAction {
  canAct: boolean;
  /** The one delegated identity used when the caller is not eligible as themselves. */
  onBehalfOf: { userId: number } | null;
  /** Every delegated identity that could be used (detail screen). */
  options: number[];
  reason: MyReason | null;
}
export interface StepInfo {
  currentStepName: string | null;
  approvalsNeeded: number;
  approvalsGiven: number;
}
export interface Evaluated {
  visible: boolean;
  my: MyAction;
  step: StepInfo;
}

type Code = 'MAKER' | 'ACTED' | 'NOT_ELIGIBLE';
const RANK: Record<Code, number> = { MAKER: 2, ACTED: 1, NOT_ELIGIBLE: 0 };

/** Step name, how many approvals the current step needs and has (any request, open or closed). */
export function stepInfo(req: ApprovalRequest, rows: ApprovalAction[]): StepInfo {
  const step = stepOf(req);
  if (!step) return { currentStepName: null, approvalsNeeded: 0, approvalsGiven: 0 };
  const slots = slotsOf(step, req.stepOverrides ?? [], n(req.round));
  const given = rows.filter(
    a =>
      a.action === 'APPROVED' &&
      n(a.round) === n(req.round) &&
      a.stepNo !== null &&
      n(a.stepNo) === n(req.currentStepNo),
  ).length;
  return { currentStepName: step.name, approvalsNeeded: needOf(step, slots), approvalsGiven: given };
}

/** Approvers of this round and the slots covered at the current step, from the loaded action rows. */
export function roundOf(req: ApprovalRequest, rows: ApprovalAction[]) {
  const principals = new Set<number>();
  const actors = new Set<number>();
  const coveredRefs = new Set<string>();
  const mine: ApprovalAction[] = [];
  let approvedAtStep = 0;
  for (const a of rows) {
    if (a.action !== 'APPROVED' || n(a.round) !== n(req.round)) continue;
    mine.push(a);
    if (a.stepNo !== null && n(a.stepNo) === n(req.currentStepNo)) approvedAtStep += 1;
    const actor = a.actorUserId === null ? null : n(a.actorUserId);
    const principal = a.onBehalfOfUserId === null ? actor : n(a.onBehalfOfUserId);
    if (actor !== null) actors.add(actor);
    if (principal !== null) principals.add(principal);
    if (a.stepNo !== null && n(a.stepNo) === n(req.currentStepNo) && a.slotRef) coveredRefs.add(a.slotRef);
  }
  return { rows: mine, principals, actors, coveredRefs, approvedAtStep };
}

/**
 * One reader of the inbox: loads the caller's permissions and delegations once, then evaluates visibility (BR-14-26) and
 * `myAction` (BR-14-7 to BR-14-9, BR-14-23) for many requests with the same rules the decision transaction applies.
 */
export class Viewer {
  private approverCache = new Map<string, Promise<ApproverMember[]>>();
  private delegationRows: ApprovalDelegation[] | null = null;
  private oooOn: boolean | undefined;
  permissions = new Set<string>();
  roleKey: string | null = null;

  constructor(
    readonly societyId: number,
    readonly userId: number,
  ) {}

  static async load(societyId: number, userId: number): Promise<Viewer> {
    const v = new Viewer(societyId, userId);
    const a = await computeAccess(societyId, userId);
    v.permissions = new Set(a.permissions);
    v.roleKey = a.roleKey;
    return v;
  }

  has = (perm: string): boolean => this.permissions.has(perm);

  approvers(type: string): Promise<ApproverMember[]> {
    let p = this.approverCache.get(type);
    if (!p) {
      p = loadApprovers(this.societyId, type);
      this.approverCache.set(type, p);
    }
    return p;
  }

  private async delegationsFor(req: ApprovalRequest): Promise<ApprovalDelegation[]> {
    const at = now();
    this.delegationRows ??= await ApprovalDelegation.findAll({
      where: {
        societyId: this.societyId,
        delegateUserId: this.userId,
        status: 'ACTIVE',
        startsAt: { [Op.lte]: at },
        endsAt: { [Op.gt]: at },
      },
    });
    const out: ApprovalDelegation[] = [];
    for (const d of this.delegationRows) {
      if (d.types !== null && !d.types.includes(req.type)) continue;
      if (d.maxAmountPaise !== null && n(req.amountPaise) > n(d.maxAmountPaise)) continue;
      if (d.source === 'OUT_OF_OFFICE') {
        this.oooOn ??= await entitlements.isFeatureOn(this.societyId, ENT.delegation);
        if (!this.oooOn) continue;
      }
      out.push(d);
    }
    return out;
  }

  /** Evaluates every request; `rowsByRequest` are the actions of each (all rounds). */
  async evaluate(
    reqs: ApprovalRequest[],
    rowsByRequest: Map<number, ApprovalAction[]>,
  ): Promise<Map<number, Evaluated>> {
    const out = new Map<number, Evaluated>();
    for (const req of reqs) {
      const rows = rowsByRequest.get(n(req.id)) ?? [];
      const meta = typeMeta(req.type);
      const acted = rows.some(
        a =>
          (a.actorUserId !== null && n(a.actorUserId) === this.userId) ||
          (a.onBehalfOfUserId !== null && n(a.onBehalfOfUserId) === this.userId),
      );
      const my: MyAction = { canAct: false, onBehalfOf: null, options: [], reason: null };
      let member = false;
      if (req.status === 'PENDING' && req.ruleSnapshot !== null) {
        const members = await this.approvers(req.type);
        member = members.some(m => m.userId === this.userId);
        const round = roundOf(req, rows);
        const ev = evaluateStep(req, members, round);
        if (ev) {
          const self = evaluateIdentity(req, ev, round, this.userId, this.userId);
          const via: number[] = [];
          let best: Code = self.ok ? 'NOT_ELIGIBLE' : self.code;
          for (const d of await this.delegationsFor(req)) {
            const r = evaluateIdentity(req, ev, round, this.userId, n(d.delegatorUserId));
            if (r.ok) via.push(n(d.delegatorUserId));
            else if (RANK[r.code] > RANK[best]) best = r.code;
          }
          my.options = via;
          if (self.ok) my.canAct = true;
          else if (via.length) {
            my.canAct = true;
            if (via.length === 1) my.onBehalfOf = { userId: via[0]! };
          } else
            my.reason =
              best === 'MAKER'
                ? 'MAKER_CHECKER'
                : best === 'ACTED'
                  ? 'ALREADY_ACTED'
                  : member
                    ? 'NOT_IN_STEP'
                    : 'NO_PERMISSION';
        }
      }
      const visible =
        n(req.requesterUserId) === this.userId ||
        acted ||
        my.canAct ||
        member ||
        Boolean(meta && (this.has(meta.viewPermission) || this.has(meta.approvePermission)));
      out.set(n(req.id), { visible, my, step: stepInfo(req, rows) });
    }
    return out;
  }
}

/** All actions of these requests grouped by request id, oldest first. */
export async function loadActions(ids: number[]): Promise<Map<number, ApprovalAction[]>> {
  const map = new Map<number, ApprovalAction[]>();
  if (!ids.length) return map;
  const rows = await ApprovalAction.findAll({ where: { requestId: ids }, order: [['id', 'ASC']] });
  for (const a of rows) {
    const k = n(a.requestId);
    const list = map.get(k);
    if (list) list.push(a);
    else map.set(k, [a]);
  }
  return map;
}

export const isOpenStatus = (s: string): boolean => (OPEN_STATUSES as readonly string[]).includes(s);
