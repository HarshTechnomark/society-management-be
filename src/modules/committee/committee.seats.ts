import { ValidationError } from '../../utils/errors';
import { PORTFOLIOS, type Designation, MAX_SEATS_STORED } from './committee.constants';
import { assertHoldersEligible, nameOfUser, type HolderToCheck } from './committee.holders';
import { duplicateProblem, holdingSeats, nextSeatId, seatInvariantProblem } from './committee.planner';
import type { SeatJson } from './committee.schemas';
import { assertFeatureFor, rule, seatNotFound, type CommitteeSettings } from './committee.shared';
import { FEATURE } from './committee.constants';

/** Seat input of 8.3 and 8.4, after Zod. */
export interface SeatInput {
  seatId?: string;
  userId?: number | null;
  name?: string;
  designation: Designation;
  joinMode?: 'ELECTED' | 'NOMINATED' | 'APPOINTED';
  unitId?: number | null;
  portfolios?: (typeof PORTFOLIOS)[number][];
  publicEmail?: string | null;
  showOnResidentPage?: boolean;
  replaceExistingRole?: boolean;
}

/** The three rules that look at one seat only. */
function assertSeatShape(designation: Designation, show: boolean, seatId: string): void {
  if (!show && designation !== 'MEMBER')
    throw rule('COMMITTEE_CHANGE_INVALID', 'An office bearer must be shown on the resident page', 'seats', {
      seatIds: [seatId],
    });
}

export const newSeat = (
  o: Partial<SeatJson> & Pick<SeatJson, 'seatId' | 'name' | 'designation'>,
): SeatJson => ({
  userId: null,
  memberId: null,
  unitId: null,
  joinMode: 'ELECTED',
  portfolios: [],
  publicEmail: null,
  showOnResidentPage: true,
  status: 'PLANNED',
  fromDate: null,
  toDate: null,
  roleBeforeKey: null,
  replaceExistingRole: false,
  exitReason: null,
  exitNote: null,
  resolutionRef: null,
  flags: [],
  ...o,
});

export function assertStored(seats: SeatJson[], termStatus: string): void {
  if (seats.length > MAX_SEATS_STORED)
    throw rule('COMMITTEE_SEAT_LIMIT', `A term holds at most ${MAX_SEATS_STORED} seat entries`);
  const p = seatInvariantProblem(seats, termStatus);
  if (p) throw new Error(`committee seat invariant: ${p}`);
}

export interface BuildArgs {
  societyId: number;
  strength: number;
  cfg: CommitteeSettings;
  /** Seats stored on the term now (empty for a new term); a seat with a `seatId` keeps the stored one. */
  existing: SeatJson[];
  input: SeatInput[];
  /** Run BR-10-7 and BR-10-8 for these seats (a function of the stored seat and the new one). */
  needsEligibility: (stored: SeatJson | null, next: SeatJson) => boolean;
}

/**
 * Draft seats from input (8.3, 8.4): full replacement. Applies office-bearer entitlement, seat shape, BR-10-4, BR-10-3 (seats
 * against strength), BR-10-7 and BR-10-8 in that order. Seat ids are `max + 1` over every id the term ever held.
 */
export async function buildDraftSeats(a: BuildArgs): Promise<SeatJson[]> {
  if (a.input.some(s => s.designation !== 'MEMBER'))
    await assertFeatureFor(a.societyId, FEATURE.officeBearers);
  const stored = new Map(a.existing.map(s => [s.seatId, s]));
  const used = new Set<string>();
  const ever: Pick<SeatJson, 'seatId'>[] = [...a.existing];
  const out: SeatJson[] = [];
  const checks: HolderToCheck[] = [];
  for (const [i, inp] of a.input.entries()) {
    const prev = inp.seatId ? stored.get(inp.seatId) : undefined;
    if (inp.seatId) {
      if (!prev) throw seatNotFound();
      if (used.has(inp.seatId))
        throw rule('COMMITTEE_CHANGE_INVALID', 'A seat appears twice', `seats[${i}].seatId`, {
          seatIds: [inp.seatId],
        });
      used.add(inp.seatId);
    }
    const userId = inp.userId !== undefined ? inp.userId : (prev?.userId ?? null);
    if (userId === null)
      throw new ValidationError([{ field: `seats[${i}].userId`, message: 'The seat holder is required' }]);
    const seatId = prev?.seatId ?? nextSeatId(ever);
    if (!prev) ever.push({ seatId });
    const holderChanged = !prev || prev.userId !== userId;
    const seat: SeatJson = newSeat({
      ...(prev ?? {}),
      seatId,
      userId,
      name: holderChanged ? await nameOfUser(userId) : prev!.name,
      designation: inp.designation,
      joinMode: inp.joinMode ?? prev?.joinMode ?? 'ELECTED',
      unitId: inp.unitId !== undefined ? inp.unitId : (prev?.unitId ?? null),
      portfolios: inp.portfolios ?? prev?.portfolios ?? [],
      publicEmail: inp.publicEmail !== undefined ? inp.publicEmail : (prev?.publicEmail ?? null),
      showOnResidentPage: inp.showOnResidentPage ?? prev?.showOnResidentPage ?? true,
      replaceExistingRole: inp.replaceExistingRole ?? prev?.replaceExistingRole ?? false,
    });
    assertSeatShape(seat.designation, seat.showOnResidentPage, seat.seatId);
    if (a.needsEligibility(prev ?? null, seat)) checks.push({ seatId, userId, unitId: seat.unitId });
    out.push(seat);
  }
  const dup = duplicateProblem(out);
  if (dup) throw rule(dup.code, dup.message, 'seats', { seatIds: dup.seatIds });
  if (holdingSeats(out).length > a.strength)
    throw rule(
      'COMMITTEE_STRENGTH_INVALID',
      `The committee has ${a.strength} seats; ${out.length} are planned`,
      'seats',
    );
  await assertHoldersEligible(a.societyId, checks, a.cfg.ownersOnly);
  assertStored(out, 'DRAFT');
  return out;
}

/** Historical seats (F13): saved `LEFT` for the whole term; no membership or unit checks and no module 03 call. */
export async function buildHistoricalSeats(
  input: SeatInput[],
  term: { startDate: string; endDate: string },
): Promise<SeatJson[]> {
  const out = input.map((inp, i) => {
    if (!inp.name?.trim())
      throw new ValidationError([
        { field: `seats[${i}].name`, message: 'The name is required for a past committee' },
      ]);
    const show = inp.showOnResidentPage ?? true;
    assertSeatShape(inp.designation, show, `S${i + 1}`);
    return newSeat({
      seatId: `S${i + 1}`,
      userId: inp.userId ?? null,
      unitId: inp.unitId ?? null,
      name: inp.name.trim(),
      designation: inp.designation,
      joinMode: inp.joinMode ?? 'ELECTED',
      portfolios: inp.portfolios ?? [],
      publicEmail: inp.publicEmail ?? null,
      showOnResidentPage: show,
      status: 'LEFT',
      fromDate: term.startDate,
      toDate: term.endDate,
      exitReason: 'TERM_ENDED',
    });
  });
  assertStored(out, 'ENDED');
  return out;
}
