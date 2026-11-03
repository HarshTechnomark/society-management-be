import { users } from '../auth/auth.public';
import { authAccess } from '../access-control/access-control.public';
import { residents } from '../residents/residents.public';
import { rule } from './committee.shared';

/** BR-10-7 and BR-10-8: who may hold a seat. Reads module 03 memberships and module 09 unit links; writes nothing. */
export interface HolderToCheck {
  seatId: string;
  userId: number | null;
  unitId: number | null;
}

export type MembershipState = 'ACTIVE' | 'NOT_ACTIVE' | 'NONE';

/** The membership of a user in the society: ACTIVE, SUSPENDED or an invitation still pending (NOT_ACTIVE), or none (ended or never). */
export async function membershipState(societyId: number, userId: number): Promise<MembershipState> {
  const mine = (await authAccess.listMemberships(userId)).filter(m => m.societyId === societyId);
  if (mine.some(m => m.status === 'ACTIVE')) return 'ACTIVE';
  return mine.length ? 'NOT_ACTIVE' : 'NONE';
}

/**
 * Throws `422 COMMITTEE_HOLDER_NOT_MEMBER`, `COMMITTEE_HOLDER_NOT_ACTIVE` or `COMMITTEE_HOLDER_INELIGIBLE` (first in that order)
 * with the seat ids in `errors[0].seatIds`. With `ownersOnly` the flat must be an `OWNER` link of the holder; otherwise any active
 * link qualifies, and a holder with no unit link is rejected either way. A seat without a flat is ineligible.
 */
export async function assertHoldersEligible(
  societyId: number,
  holders: HolderToCheck[],
  ownersOnly: boolean,
): Promise<void> {
  if (!holders.length) return;
  const state = new Map<number, MembershipState>();
  for (const h of holders)
    if (h.userId !== null && !state.has(h.userId))
      state.set(h.userId, await membershipState(societyId, h.userId));
  const stateOf = (h: HolderToCheck): MembershipState => (h.userId === null ? 'NONE' : state.get(h.userId)!);
  const ids = (pred: (h: HolderToCheck) => boolean) => holders.filter(pred).map(h => h.seatId);

  const notMember = ids(h => stateOf(h) === 'NONE');
  if (notMember.length)
    throw rule(
      'COMMITTEE_HOLDER_NOT_MEMBER',
      'These people are not members of the society yet. Residents join through the residents register first.',
      'seats',
      { seatIds: notMember },
    );
  const notActive = ids(h => stateOf(h) === 'NOT_ACTIVE');
  if (notActive.length)
    throw rule(
      'COMMITTEE_HOLDER_NOT_ACTIVE',
      'These people are suspended or have not accepted their invitation',
      'seats',
      { seatIds: notActive },
    );

  const links = new Map<number, { unitId: number; relation: string }[]>();
  for (const uid of state.keys()) links.set(uid, await residents.getActiveUnitLinks(societyId, uid));
  const ineligible = holders.filter(h => {
    const mine = links.get(h.userId!) ?? [];
    const usable = ownersOnly ? mine.filter(l => l.relation === 'OWNER') : mine;
    return h.unitId === null || !usable.some(l => l.unitId === h.unitId);
  });
  if (ineligible.length)
    throw rule(
      'COMMITTEE_HOLDER_INELIGIBLE',
      ownersOnly
        ? 'Only owners can sit on the committee, and the flat must be one the person owns'
        : 'The flat must be one the person is linked to',
      'seats',
      { seatIds: ineligible.map(h => h.seatId) },
    );
}

/** The name of a member from module 02, for the seat snapshot (BR-10-30: nothing else is copied). */
export async function nameOfUser(userId: number): Promise<string> {
  const s = await users.getUserSummary(userId).catch(() => null);
  const name = (s?.name ?? '').trim();
  return name.length >= 2 ? name : `Member ${userId}`;
}

/** BR-10-8 for a flat change on a seat: the flat must be one of the holder's links (an `OWNER` link when `ownersOnly`). */
export async function assertUnitFits(
  societyId: number,
  seatId: string,
  userId: number,
  unitId: number,
  ownersOnly: boolean,
): Promise<void> {
  const mine = await residents.getActiveUnitLinks(societyId, userId);
  const usable = ownersOnly ? mine.filter(l => l.relation === 'OWNER') : mine;
  if (!usable.some(l => l.unitId === unitId))
    throw rule('COMMITTEE_HOLDER_INELIGIBLE', 'The flat is not one the person owns', 'unitId', {
      seatIds: [seatId],
    });
}
