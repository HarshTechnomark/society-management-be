import { randomUUID } from 'node:crypto';
import { CommitteeTerm, Society, SocietyMember, sequelize } from '../../src/models';
import { flushAcl } from '../../src/modules/access-control/access-control.cache';
import { settings } from '../../src/modules/society-setup/society-setup.public';
import { systemCtx } from '../../src/types/context';
import { setNow } from '../../src/lib/clock';
import { registerCommittee } from '../../src/modules/committee/committee.public';
import { committeePortCalls, setCommitteePorts } from '../../src/modules/committee/committee.ports';
import type { SeatJson } from '../../src/modules/committee/committee.schemas';
import { newSeat } from '../../src/modules/committee/committee.seats';
import { residentSociety, residentUser, resetResidents, type Client } from './residents';

/** Fresh state with the module 02 to 09 registrations and the module 10 ones. Call from `beforeEach`. */
export async function resetCommittee(): Promise<void> {
  await resetResidents();
  registerCommittee();
  setCommitteePorts();
  committeePortCalls.length = 0;
  setNow('2026-11-01T04:30:00Z');
}

export const idem = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

type World = Awaited<ReturnType<typeof residentSociety>>;

/** A PREMIUM society with its chairman and 8 flats. */
export const committeeWorld = (o: Parameters<typeof residentSociety>[0] = {}): Promise<World> =>
  residentSociety({ flats: 8, ...o });

/** An owner of flat `n` with a login and an active membership (resident-scope role `owner`). */
export const holder = async (w: World, n: number, name: string, relation: 'OWNER' | 'TENANT' = 'OWNER') =>
  residentUser(w.society, w.unit(n).id, { name, relation });

export type Holder = Awaited<ReturnType<typeof holder>>;

export const seat = (
  h: Holder,
  w: World,
  n: number,
  designation: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ userId: h.user.id, unitId: w.unit(n).id, designation, ...extra });

export const termBody = (seats: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  name: 'Managing Committee 2026–2031',
  startDate: '2026-11-01',
  endDate: '2031-10-31',
  strength: 5,
  seats,
  ...over,
});

/** POST /committee/terms; returns the response (or `data` when `expect` is given and matches). */
export async function postTerm(
  c: Client,
  body: Record<string, unknown>,
  expect: number | null = 201,
): Promise<any> {
  const r = await c('post', '/committee/terms', body, { headers: idem() });
  if (expect !== null && r.status !== expect)
    throw new Error(`postTerm ${r.status} ${JSON.stringify(r.body)}`);
  return expect === null ? r : r.body.data;
}

/** A term inserted straight into the table (the activation of 10.2 is not built yet). */
export async function rawTerm(
  societyId: number,
  o: Partial<CommitteeTerm> & { members?: SeatJson[] } = {},
): Promise<CommitteeTerm> {
  return CommitteeTerm.create({
    societyId,
    name: 'Managing Committee 2024–2029',
    kind: 'ELECTED',
    source: 'MANUAL',
    status: 'ACTIVE',
    startDate: '2024-04-01',
    endDate: '2029-03-31',
    actualEndDate: null,
    strength: 5,
    electionId: null,
    resultsDeclaredAt: null,
    predecessorTermId: null,
    members: [],
    handoverChecklist: [],
    handoverCompletedAt: null,
    tookChargeOn: '2024-04-01',
    resolutionRef: 'CM/2024-25/01',
    notes: null,
    lastReminderDays: null,
    lastHandoverReminderDay: null,
    activatedAt: null,
    activatedBy: null,
    expiredAt: null,
    endedAt: null,
    endedBy: null,
    endReason: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ...o,
  } as never);
}

/** A SEATED seat of a raw term. */
export const seated = (
  seatId: string,
  h: { user: { id: number }; memberId?: number },
  name: string,
  designation: SeatJson['designation'],
  extra: Partial<SeatJson> = {},
): SeatJson =>
  newSeat({
    seatId,
    userId: h.user.id,
    memberId: h.memberId ?? 1,
    name,
    designation,
    status: 'SEATED',
    fromDate: '2024-04-01',
    ...extra,
  });

export async function suspend(societyId: number): Promise<void> {
  await Society.update({ status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never, {
    where: { id: societyId },
  });
  await flushAcl();
}

export const setSetting = (societyId: number, key: string, value: unknown) =>
  sequelize.transaction(t => settings.set(systemCtx('test'), societyId, key as never, value as never, t));

/** Moves a member of the society to another status (ENDED and SUSPENDED get their time). */
export const setMemberStatus = (userId: number, status: 'ACTIVE' | 'SUSPENDED' | 'ENDED') =>
  SocietyMember.update(
    {
      status,
      ...(status === 'ENDED' ? { endedAt: new Date() } : {}),
      ...(status === 'SUSPENDED' ? { suspendedAt: new Date() } : {}),
    } as never,
    { where: { userId } },
  );
