import { createHash } from 'node:crypto';
import type { SlotType } from './approvals.constants';
import type {
  ApproverMember,
  MatchableRule,
  RuleSnapshot,
  RuleStep,
  SlotMatch,
  StepOverride,
} from './approvals.types';

/**
 * Pure functions of module 14 (no database): rule matching (BR-14-3), canonical hash (BR-14-16), step slots and capacity
 * (BR-14-11, 6.4), slot matching (6.2) and `assessRule` (BR-14-32). The engine feeds them rows and members.
 */

// ------------------------------------------------------------------ BR-14-3 rule matching
export interface MatchQuery {
  amountPaise: number;
  categoryKey?: string | null;
  requesterRoleKey?: string | null;
}

/** First active rule (priority, then id) whose conditions all hold, or null. */
export function matchRule<R extends MatchableRule>(rules: R[], q: MatchQuery): R | null {
  const sorted = rules.filter(r => r.isActive).sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const r of sorted) {
    if (r.minAmountPaise > q.amountPaise) continue;
    if (r.maxAmountPaise !== null && q.amountPaise > r.maxAmountPaise) continue;
    if (r.categoryKeys !== null && !(q.categoryKey && r.categoryKeys.includes(q.categoryKey))) continue;
    if (
      r.requesterRoleKeys !== null &&
      !(q.requesterRoleKey && r.requesterRoleKeys.includes(q.requesterRoleKey))
    )
      continue;
    return r;
  }
  return null;
}

// ------------------------------------------------------------------ BR-14-16 hash
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map(k => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v === undefined ? null : v;
}
export const canonicalJson = (v: unknown): string => JSON.stringify(canonical(v));
export function payloadHash(i: {
  title: string;
  summary: string | null;
  amountPaise: number;
  categoryKey: string | null;
  payload: Record<string, unknown>;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        title: i.title,
        summary: i.summary,
        amountPaise: i.amountPaise,
        categoryKey: i.categoryKey,
        payload: i.payload,
      }),
    )
    .digest('hex');
}

// ------------------------------------------------------------------ slots
export interface Slot {
  type: Extract<SlotType, 'ROLE' | 'USER'>;
  ref: string;
}
/** Slots of a step in matching order: named members first, then roles; reassign overrides replace or join (BR-14-21). */
export function slotsOf(step: RuleStep, overrides: StepOverride[] = [], round = 1): Slot[] {
  const slots: Slot[] = [
    ...step.userIds.map(id => ({ type: 'USER' as const, ref: String(id) })),
    ...step.roleKeys.map(k => ({ type: 'ROLE' as const, ref: k })),
  ];
  for (const o of overrides) {
    if (o.stepNo !== step.stepNo || o.round !== round) continue;
    const s: Slot = { type: 'USER', ref: String(o.userId) };
    if (step.mode === 'ALL_OF' && o.slotIndex !== null && o.slotIndex >= 0 && o.slotIndex < slots.length)
      slots[o.slotIndex] = s;
    else slots.push(s);
  }
  return slots;
}
const slotMatches = (s: Slot, m: ApproverMember): boolean =>
  s.type === 'USER' ? s.ref === String(m.userId) : s.ref === m.roleKey;

export interface StepState {
  slots: Slot[];
  /** ALL_OF: slot refs already covered by an approval of this step and round. */
  coveredRefs: Set<string>;
  /** The step widened to the fallback roles (BR-14-11). */
  widened: boolean;
  fallbackRoleKeys: string[];
  /** ALL_OF: refs of uncovered slots that nobody else can cover (a FALLBACK person may take them). */
  vacantRefs: string[];
  escalationOpen: boolean;
  escalationRoleKeys: string[];
}

/** Section 6.2 `openSlotFor`: USER, ROLE, FALLBACK (widened step), ESCALATION (escalated and allowed). */
export function openSlotFor(m: ApproverMember, step: RuleStep, st: StepState): SlotMatch | null {
  const open = step.mode === 'ALL_OF' ? st.slots.filter(s => !st.coveredRefs.has(s.ref)) : st.slots;
  const user = open.find(s => s.type === 'USER' && slotMatches(s, m));
  if (user) return { slotType: 'USER', slotRef: user.ref };
  const role = open.find(s => s.type === 'ROLE' && slotMatches(s, m));
  if (role) return { slotType: 'ROLE', slotRef: role.ref };
  if (st.widened && st.fallbackRoleKeys.includes(m.roleKey)) {
    if (step.mode !== 'ALL_OF') return { slotType: 'FALLBACK', slotRef: m.roleKey };
    const ref = st.vacantRefs[0];
    if (ref !== undefined) return { slotType: 'FALLBACK', slotRef: ref };
  }
  if (st.escalationOpen && st.escalationRoleKeys.includes(m.roleKey)) {
    if (step.mode !== 'ALL_OF') return { slotType: 'ESCALATION', slotRef: m.roleKey };
    const ref = open[0]?.ref;
    if (ref !== undefined) return { slotType: 'ESCALATION', slotRef: ref };
  }
  return null;
}

// ------------------------------------------------------------------ 6.4 capacity
export interface Capacity {
  need: number;
  ok: boolean;
  widened: boolean;
  vacantRefs: string[];
}
/** `need` of a step: 1 for ANY_OF, `requiredCount` for N_OF, one per uncovered slot for ALL_OF. */
export function needOf(step: RuleStep, slots: Slot[], covered: Set<string> = new Set()): number {
  if (step.mode === 'ANY_OF') return 1;
  if (step.mode === 'N_OF') return step.requiredCount ?? 1;
  return slots.filter(s => !covered.has(s.ref)).length;
}

/**
 * Can the step still be completed? `members` are ACTIVE members holding the approve permission; `excluded` are the requester
 * and earlier approvers of the round; `extraUnavailable` is the worst case for later steps at creation. Widening adds the
 * fallback roles and never lowers `need` (BR-14-11).
 */
export function stepCapacity(
  step: RuleStep,
  slots: Slot[],
  members: ApproverMember[],
  excluded: Set<number>,
  fallbackRoleKeys: string[],
  covered: Set<string> = new Set(),
  extraUnavailable = 0,
): Capacity {
  const need = needOf(step, slots, covered);
  const avail = members.filter(m => !excluded.has(m.userId));
  if (step.mode !== 'ALL_OF') {
    const pool = new Set(avail.filter(m => slots.some(s => slotMatches(s, m))).map(m => m.userId));
    if (pool.size - extraUnavailable >= need) return { need, ok: true, widened: false, vacantRefs: [] };
    for (const m of avail) if (fallbackRoleKeys.includes(m.roleKey)) pool.add(m.userId);
    return { need, ok: pool.size - extraUnavailable >= need, widened: true, vacantRefs: [] };
  }
  // ALL_OF: every uncovered slot needs its own person
  const open = slots.filter(s => !covered.has(s.ref));
  const used = new Set<number>();
  const vacant: string[] = [];
  for (const s of open) {
    const p = avail.find(m => !used.has(m.userId) && slotMatches(s, m));
    if (p) used.add(p.userId);
    else vacant.push(s.ref);
  }
  const spare = new Set(avail.map(m => m.userId)).size - used.size;
  if (!vacant.length && spare + used.size - extraUnavailable >= need)
    return { need, ok: true, widened: false, vacantRefs: [] };
  const fb = avail.filter(m => !used.has(m.userId) && fallbackRoleKeys.includes(m.roleKey));
  const remaining = vacant.slice();
  for (const m of fb) {
    if (!remaining.length) break;
    used.add(m.userId);
    remaining.shift();
  }
  return {
    need,
    ok: !remaining.length && used.size - extraUnavailable >= 0,
    widened: true,
    vacantRefs: vacant,
  };
}

/** Capacity of every step of a snapshot at creation (BR-14-11 a): later steps assume the earlier steps' people are gone. */
export function creationCapacity(
  snap: Pick<RuleSnapshot, 'steps' | 'fallbackRoleKeys'>,
  members: ApproverMember[],
  requesterUserId: number | null,
): { ok: boolean; widenedSteps: number[]; blockedStep: number | null } {
  const excluded = new Set<number>(requesterUserId === null ? [] : [requesterUserId]);
  let extra = 0;
  const widenedSteps: number[] = [];
  for (const step of snap.steps) {
    const slots = slotsOf(step);
    const c = stepCapacity(step, slots, members, excluded, snap.fallbackRoleKeys, new Set(), extra);
    if (c.widened) widenedSteps.push(step.stepNo);
    if (!c.ok) return { ok: false, widenedSteps, blockedStep: step.stepNo };
    extra += c.need;
  }
  return { ok: true, widenedSteps, blockedStep: null };
}

/**
 * BR-14-32: for every possible requester (each member's role, plus `null` for an outside requester) apply the worst case of
 * BR-14-11 a. Returns the requester role keys (`null` = outside requester) for which a step cannot be satisfied.
 */
export function assessRule(
  rule: Pick<RuleSnapshot, 'steps' | 'fallbackRoleKeys'>,
  members: ApproverMember[],
  requesters: { userId: number; roleKey: string }[],
): (string | null)[] {
  if (!rule.steps.length) return [];
  const bad = new Set<string | null>();
  if (!creationCapacity(rule, members, null).ok) bad.add(null);
  for (const r of requesters) if (!creationCapacity(rule, members, r.userId).ok) bad.add(r.roleKey);
  return [...bad];
}
