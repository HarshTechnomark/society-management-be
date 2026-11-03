import { createHash } from 'node:crypto';
import {
  COMMITTEE_ROLE_KEYS,
  DESIGNATION_ROLE,
  DESIGNATIONS,
  MIN_TERM_DAYS,
  REQUIRED_OFFICE_BEARERS,
  TERM_ENDING_BANNER_DAYS,
  UNIQUE_DESIGNATIONS,
  type Designation,
} from './committee.constants';
import type { SeatJson } from './committee.schemas';

/**
 * Pure functions of module 10: date arithmetic on business dates, the term rules of BR-10-2 to BR-10-4, seat helpers and the
 * banner of 8.1. No database access. Sub-modules 10.2 and 10.3 add the activation planner (`revertRole`, action ordering,
 * staff seat effect, preview hash) and the reminder thresholds to this file.
 */
const MS_DAY = 86_400_000;
const utc = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
export const addDaysYmd = (d: string, n: number): string =>
  new Date(utc(d).getTime() + n * MS_DAY).toISOString().slice(0, 10);
/** Whole days from `a` to `b` (positive when `b` is later). */
export const daysBetween = (a: string, b: string): number =>
  Math.round((utc(b).getTime() - utc(a).getTime()) / MS_DAY);
/** `d` plus `n` calendar years (29 Feb rolls to 1 Mar). */
export function addYearsYmd(d: string, n: number): string {
  const x = utc(d);
  x.setUTCFullYear(x.getUTCFullYear() + n);
  return x.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ dates (BR-10-2)
export interface TermRange {
  startDate: string;
  endDate: string;
}
/** The length rules of BR-10-2: `endDate` > `startDate`, at least 30 days, at most `maxTermYears` years minus one day. */
export function termLengthProblem(r: TermRange, maxTermYears: number): string | null {
  if (r.endDate <= r.startDate) return 'The end date must be after the start date';
  if (r.endDate < addDaysYmd(r.startDate, MIN_TERM_DAYS))
    return `A term lasts at least ${MIN_TERM_DAYS} days`;
  if (r.endDate > addDaysYmd(addYearsYmd(r.startDate, maxTermYears), -1))
    return `A term lasts at most ${maxTermYears} year${maxTermYears === 1 ? '' : 's'}`;
  return null;
}
export const rangesOverlap = (a: TermRange, b: TermRange): boolean =>
  a.startDate <= b.endDate && b.startDate <= a.endDate;

// ------------------------------------------------------------------ strength (BR-10-3)
export const holds = (s: Pick<SeatJson, 'status'>): boolean =>
  s.status === 'PLANNED' || s.status === 'SEATED';
export const holdingSeats = (seats: SeatJson[]): SeatJson[] => seats.filter(holds);
export const seatedSeats = (seats: SeatJson[]): SeatJson[] => seats.filter(s => s.status === 'SEATED');

// ------------------------------------------------------------------ seats (BR-10-4, BR-10-32)
/** `S<max + 1>` over every seat ever stored in the term; ids are never reused. */
export function nextSeatId(seats: Pick<SeatJson, 'seatId'>[]): string {
  const max = seats.reduce((m, s) => Math.max(m, Number(s.seatId.slice(1))), 0);
  return `S${max + 1}`;
}
export interface DuplicateProblem {
  code: 'COMMITTEE_DESIGNATION_DUPLICATE' | 'COMMITTEE_HOLDER_DUPLICATE';
  seatIds: string[];
  message: string;
}
/** BR-10-4 among PLANNED and SEATED seats: unique office designations, one seat per user. The designation check comes first. */
export function duplicateProblem(seats: SeatJson[]): DuplicateProblem | null {
  const live = holdingSeats(seats);
  for (const d of UNIQUE_DESIGNATIONS) {
    const hit = live.filter(s => s.designation === d);
    if (hit.length > 1)
      return {
        code: 'COMMITTEE_DESIGNATION_DUPLICATE',
        seatIds: hit.map(s => s.seatId),
        message: `There can be only one ${d.replace('_', ' ').toLowerCase()}`,
      };
  }
  const byUser = new Map<number, string[]>();
  for (const s of live)
    if (s.userId !== null) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s.seatId]);
  for (const ids of byUser.values())
    if (ids.length > 1)
      return { code: 'COMMITTEE_HOLDER_DUPLICATE', seatIds: ids, message: 'A person can hold only one seat' };
  return null;
}

/** BR-10-5 (activation, used by 10.2): which of Chairman, Secretary, Treasurer have no live seat. */
export const missingOfficeBearers = (seats: SeatJson[]): Designation[] =>
  REQUIRED_OFFICE_BEARERS.filter(d => !holdingSeats(seats).some(s => s.designation === d));

/** Section 7.2 invariants checked on every write (beyond the schema). Returns the first problem or null. */
export function seatInvariantProblem(seats: SeatJson[], termStatus: string): string | null {
  for (const s of seats) {
    if ((s.status === 'LEFT') !== (s.toDate !== null) || (s.status === 'LEFT') !== (s.exitReason !== null))
      return `${s.seatId}: a LEFT seat needs toDate and exitReason, and only a LEFT seat has them`;
    if (s.status === 'SEATED' && (s.fromDate === null || s.userId === null || s.memberId === null))
      return `${s.seatId}: a SEATED seat needs fromDate, userId and memberId`;
    if (s.status === 'PLANNED' && termStatus !== 'DRAFT') return `${s.seatId}: PLANNED only in a DRAFT term`;
    if (s.fromDate !== null && s.toDate !== null && s.toDate < s.fromDate)
      return `${s.seatId}: toDate is before fromDate`;
  }
  return null;
}

// ------------------------------------------------------------------ read model (8.1, 8.2)
export const isCurrentStatus = (status: string): boolean => status === 'ACTIVE' || status === 'EXPIRED';
/** `endDate - today`; null for a draft or an ended term. Negative when overdue. */
export const daysLeftOf = (t: { status: string; endDate: string }, today: string): number | null =>
  isCurrentStatus(t.status) ? daysBetween(today, t.endDate) : null;
export const isOverdueOf = (t: { status: string; endDate: string }, today: string): boolean =>
  isCurrentStatus(t.status) && t.endDate < today;

/** Chairman, Secretary and Treasurer without a SEATED holder (shown as vacancies). */
export const vacantDesignations = (seats: SeatJson[]): Designation[] =>
  REQUIRED_OFFICE_BEARERS.filter(d => !seatedSeats(seats).some(s => s.designation === d));

/** Holders at the end of an ended term are the seats closed with `TERM_ENDED`. */
export const occupying = (status: string, seats: SeatJson[]): SeatJson[] =>
  status === 'DRAFT'
    ? []
    : status === 'ENDED'
      ? seats.filter(s => s.exitReason === 'TERM_ENDED')
      : seatedSeats(seats);

export function designationRank(d: Designation): number {
  return DESIGNATIONS.indexOf(d);
}

export type Banner =
  | null
  | { code: 'TERM_ENDING'; daysLeft: number }
  | { code: 'CARETAKER'; endedOn: string }
  | { code: 'DRAFT_FROM_ELECTION'; draftId: number; electionId: number }
  | { code: 'NO_COMMITTEE' };

/** 8.1: caretaker first, then a draft from an election, then the 90-day warning, then "no committee". */
export function bannerFor(
  current: { status: string; endDate: string } | null,
  draft: { id: number; source: string; electionId: number | null } | null,
  today: string,
): Banner {
  if (current && (current.status === 'EXPIRED' || isOverdueOf(current, today)))
    return { code: 'CARETAKER', endedOn: current.endDate };
  if (draft && draft.source === 'ELECTION' && draft.electionId !== null)
    return { code: 'DRAFT_FROM_ELECTION', draftId: draft.id, electionId: draft.electionId };
  if (!current) return { code: 'NO_COMMITTEE' };
  const left = daysBetween(today, current.endDate);
  if (left <= TERM_ENDING_BANNER_DAYS) return { code: 'TERM_ENDING', daysLeft: left };
  return null;
}

// ------------------------------------------------------------------ activation planner (10.2: BR-10-9 to BR-10-13, BR-10-17, BR-10-18)
export type Step = 'A' | 'B' | 'C' | 'D';
export type ActivationAction =
  | {
      kind: 'CHANGE_ROLE';
      step: Step;
      userId: number;
      memberId: number;
      name: string;
      fromRoleKey: string;
      toRoleKey: string;
      seatDelta: -1 | 0 | 1;
      reason: 'INCOMING' | 'OUTGOING' | 'CONTINUING';
    }
  | {
      kind: 'END_MEMBERSHIP';
      step: 'A' | 'C';
      userId: number;
      memberId: number;
      name: string;
      fromRoleKey: string;
      seatDelta: 0;
    }
  | {
      kind: 'NONE';
      userId: number;
      memberId: number;
      name: string;
      roleKey: string;
      reason: 'INCOMING' | 'CONTINUING';
    };

export interface PlanBlocker {
  code: string;
  message: string;
  seatIds?: string[];
  userIds?: number[];
  permissionKeys?: string[];
}
export interface PlanWarning {
  code: string;
  message: string;
  userIds?: number[];
}

/** BR-10-10: the role a person gets back on leaving a seat. `relations` are the active unit relations (`OWNER`, `TENANT`, `FAMILY`). */
export type RevertTarget = { kind: 'ROLE'; roleKey: string } | { kind: 'END' };
const RELATION_ROLE: [string, string][] = [
  ['OWNER', 'owner'],
  ['TENANT', 'tenant'],
  ['FAMILY', 'family_member'],
];
export function revertRole(roleBeforeKey: string | null, relations: string[]): RevertTarget {
  if (roleBeforeKey) return { kind: 'ROLE', roleKey: roleBeforeKey };
  for (const [relation, roleKey] of RELATION_ROLE)
    if (relations.includes(relation)) return { kind: 'ROLE', roleKey };
  return { kind: 'END' };
}

export interface MemberFact {
  userId: number;
  memberId: number;
  roleKey: string;
  status: string;
  consumesSeat: boolean;
}
export interface RoleFact {
  key: string;
  scope: string;
  isSystem: boolean;
  consumesSeat: boolean;
}
export interface PlanFacts {
  members: Map<number, MemberFact>;
  roles: Map<string, RoleFact>;
  relations: Map<number, string[]>;
}
export interface OutgoingHolder {
  userId: number;
  name: string;
  /** The seat being left (null for a member who holds a committee role without a seat, first committee). */
  seat: SeatJson | null;
}
export interface IncomingHolder {
  userId: number;
  name: string;
  designation: SeatJson['designation'];
  seatId: string;
  replaceExistingRole: boolean;
  /** Seat the holder leaves in the same plan (REDESIGNATE, or a holder who continues into the new term). */
  continuing: SeatJson | null;
}

const STEP_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
export const isCommitteeRole = (k: string): boolean => (COMMITTEE_ROLE_KEYS as readonly string[]).includes(k);
/** BR-10-9: a system role of scope society, gate or work is restored on leaving; a custom role is not. */
const restorable = (r: RoleFact | undefined): boolean =>
  !!r && r.isSystem && ['society', 'gate', 'work'].includes(r.scope);

export interface BuiltPlan {
  actions: ActivationAction[];
  warnings: PlanWarning[];
  blockers: PlanBlocker[];
  /** `roleBeforeKey` the seat of an incoming holder must store. */
  roleBefore: Map<number, string | null>;
  memberIds: Map<number, number>;
}

/**
 * Builds the role plan (section 6.3): one action per person, in the BR-10-11 order. A: outgoing holders whose current role is not
 * `chairman`; B: the incoming chairman; C: outgoing holders whose current role is `chairman`; D: every other incoming change.
 * Inside a step: `seatDelta` ascending (releases first), then `userId`; `NONE` actions come last. The result is stable, so the
 * hash is too. A holder who is neither a member nor reachable is skipped here; the eligibility blockers report it.
 */
export function buildActions(outs: OutgoingHolder[], ins: IncomingHolder[], f: PlanFacts): BuiltPlan {
  const changing: ActivationAction[] = [];
  const none: ActivationAction[] = [];
  const warnings: PlanWarning[] = [];
  const blockers: PlanBlocker[] = [];
  const roleBefore = new Map<number, string | null>();
  const memberIds = new Map<number, number>();
  const conflict: IncomingHolder[] = [];
  const customRole: number[] = [];
  const willEnd: number[] = [];
  const suspended: number[] = [];

  for (const i of ins) {
    const m = f.members.get(i.userId);
    if (!m) continue;
    memberIds.set(i.userId, m.memberId);
    const target = DESIGNATION_ROLE[i.designation];
    const carried = i.continuing?.roleBeforeKey ?? null;
    if (m.roleKey === target) {
      roleBefore.set(i.userId, carried);
      none.push({
        kind: 'NONE',
        userId: i.userId,
        memberId: m.memberId,
        name: i.name,
        roleKey: target,
        reason: i.continuing ? 'CONTINUING' : 'INCOMING',
      });
      continue;
    }
    const current = f.roles.get(m.roleKey);
    const clash = !isCommitteeRole(m.roleKey) && current?.scope !== 'resident';
    if (clash && !i.replaceExistingRole) conflict.push(i);
    let before = carried;
    if (clash && i.replaceExistingRole && before === null) {
      if (restorable(current)) before = m.roleKey;
      else customRole.push(i.userId);
    }
    roleBefore.set(i.userId, before);
    changing.push({
      kind: 'CHANGE_ROLE',
      step: target === 'chairman' ? 'B' : 'D',
      userId: i.userId,
      memberId: m.memberId,
      name: i.name,
      fromRoleKey: m.roleKey,
      toRoleKey: target,
      seatDelta: m.consumesSeat ? -1 : 0,
      reason: i.continuing ? 'CONTINUING' : 'INCOMING',
    });
  }

  for (const o of outs) {
    const m = f.members.get(o.userId);
    if (!m || !isCommitteeRole(m.roleKey)) continue;
    const step = m.roleKey === 'chairman' ? 'C' : 'A';
    if (m.status === 'SUSPENDED') suspended.push(o.userId);
    const rb = o.seat?.roleBeforeKey ?? null;
    const back = revertRole(rb && restorable(f.roles.get(rb)) ? rb : null, f.relations.get(o.userId) ?? []);
    if (back.kind === 'END') {
      willEnd.push(o.userId);
      changing.push({
        kind: 'END_MEMBERSHIP',
        step,
        userId: o.userId,
        memberId: m.memberId,
        name: o.name,
        fromRoleKey: m.roleKey,
        seatDelta: 0,
      });
    } else
      changing.push({
        kind: 'CHANGE_ROLE',
        step,
        userId: o.userId,
        memberId: m.memberId,
        name: o.name,
        fromRoleKey: m.roleKey,
        toRoleKey: back.roleKey,
        seatDelta: f.roles.get(back.roleKey)?.consumesSeat ? 1 : 0,
        reason: 'OUTGOING',
      });
  }

  if (conflict.length)
    blockers.push({
      code: 'ROLE_CONFLICT',
      message:
        'These people hold a staff or custom role; tick "replace existing role" on their seat to continue',
      seatIds: conflict.map(c => c.seatId),
      userIds: conflict.map(c => c.userId),
    });
  if (customRole.length)
    warnings.push({
      code: 'CUSTOM_ROLE_NOT_RESTORED',
      message: 'A custom role is not restored when the person leaves the committee',
      userIds: customRole,
    });
  if (willEnd.length)
    warnings.push({
      code: 'MEMBERSHIP_WILL_END',
      message:
        'These people have no flat linked any more; their membership ends when they leave the committee',
      userIds: willEnd,
    });
  if (suspended.length)
    warnings.push({
      code: 'HOLDER_SUSPENDED_OUTGOING',
      message: 'These outgoing holders are suspended',
      userIds: suspended,
    });

  const stepOf = (a: ActivationAction) => (a.kind === 'NONE' ? 9 : STEP_ORDER[a.step]!);
  const delta = (a: ActivationAction) => (a.kind === 'NONE' ? 0 : a.seatDelta);
  const sorted = [...changing].sort(
    (a, b) => stepOf(a) - stepOf(b) || delta(a) - delta(b) || a.userId - b.userId,
  );
  none.sort((a, b) => a.userId - b.userId);
  return { actions: [...sorted, ...none], warnings, blockers, roleBefore, memberIds };
}

/** BR-10-17: the staff seat effect of a plan and the `NO_FREE_SEAT` blocker (`limit` null means unlimited). */
export function staffSeatEffect(
  actions: ActivationAction[],
  usage: { limit: number | null; used: number },
): { staffSeats: { limit: number | null; used: number; delta: number }; blockers: PlanBlocker[] } {
  const delta = actions.reduce((n, a) => n + (a.kind === 'NONE' ? 0 : a.seatDelta), 0);
  const blockers: PlanBlocker[] = [];
  if (usage.limit !== null && usage.used + delta > usage.limit)
    blockers.push({
      code: 'NO_FREE_SEAT',
      message: `Restoring a staff role needs a free staff seat (${usage.used} of ${usage.limit} used). Free a seat or upgrade the plan.`,
      userIds: actions.filter(a => a.kind !== 'NONE' && a.seatDelta === 1).map(a => a.userId),
    });
  return { staffSeats: { limit: usage.limit, used: usage.used, delta }, blockers };
}

/** Canonical JSON: keys sorted at every level (the same text for the same data, whatever the key order). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
/** BR-10-13: sha256 (hex) of the canonical JSON of the term versions and the actions. */
export function previewHash(i: {
  termId: number;
  termVersion: number;
  currentTermId: number | null;
  currentTermVersion: number | null;
  actions: ActivationAction[];
}): string {
  return createHash('sha256').update(canonicalJson(i)).digest('hex');
}

export interface HandoverPair {
  designation: Designation;
  fromUserId: number;
  fromName: string;
  toUserId: number;
  toName: string;
}
const OFFICE_BEARERS: Designation[] = [
  'CHAIRMAN',
  'VICE_CHAIRMAN',
  'SECRETARY',
  'JOINT_SECRETARY',
  'TREASURER',
];
/** BR-10-18: for each office-bearer designation whose holder changes (A leaves it, B takes it, A is not B). */
export function handoverPairs(
  before: Pick<SeatJson, 'designation' | 'userId' | 'name'>[],
  after: Pick<SeatJson, 'designation' | 'userId' | 'name'>[],
): HandoverPair[] {
  const out: HandoverPair[] = [];
  for (const d of OFFICE_BEARERS) {
    const a = before.find(s => s.designation === d && s.userId !== null);
    const b = after.find(s => s.designation === d && s.userId !== null);
    if (a && b && a.userId !== b.userId)
      out.push({
        designation: d,
        fromUserId: a.userId!,
        fromName: a.name,
        toUserId: b.userId!,
        toName: b.name,
      });
  }
  return out;
}
