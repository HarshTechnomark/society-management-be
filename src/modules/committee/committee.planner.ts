import {
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
