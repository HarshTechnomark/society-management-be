import { randomUUID } from 'node:crypto';
import {
  CommitteeTerm,
  EntitlementOverride,
  Society,
  SocietyMember,
  User,
  sequelize,
} from '../../src/models';
import { flushAcl } from '../../src/modules/access-control/access-control.cache';
import { settings } from '../../src/modules/society-setup/society-setup.public';
import { systemCtx } from '../../src/types/context';
import { setNow } from '../../src/lib/clock';
import { registerCommittee } from '../../src/modules/committee/committee.public';
import { committeePortCalls, setCommitteePorts } from '../../src/modules/committee/committee.ports';
import type { SeatJson } from '../../src/modules/committee/committee.schemas';
import { newSeat } from '../../src/modules/committee/committee.seats';
import { changeRole } from '../../src/modules/access-control/access-control.members.service';
import { members } from '../../src/modules/access-control/access-control.public';
import { encryptSecret, newTotpSecret } from '../../src/modules/auth/auth.crypto';
import { as, login } from './access';
import { invalidate as invalidateEntitlements } from '../../src/modules/subscriptions/entitlements.service';
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

// ------------------------------------------------------------------ 10.2 helpers
/** The membership id of a user in a society. */
export const memberIdOf = async (societyId: number, userId: number): Promise<number> =>
  (await SocietyMember.findOne({ where: { societyId, userId } }))!.id!;

/** Gives a member a role through module 03 (the committee way, no authority checks). */
export async function setRole(societyId: number, userId: number, roleKey: string): Promise<void> {
  const memberId = await memberIdOf(societyId, userId);
  await sequelize.transaction(t =>
    changeRole(systemCtx('test'), memberId, roleKey, 'test setup', t, { via: 'committee' }),
  );
  await flushAcl();
}

/** The role key of a user in a society ('ENDED' when the membership has ended). */
export async function roleOf(societyId: number, userId: number): Promise<string> {
  const [m] = await members.listForSociety(societyId, {
    userIds: [userId],
    statuses: ['ACTIVE', 'SUSPENDED'],
  });
  return m?.roleKey ?? 'ENDED';
}

/** A SEATED seat of a raw term for a holder of the world (member id looked up). */
export async function seatedFor(
  w: World,
  h: Holder,
  seatId: string,
  designation: SeatJson['designation'],
  extra: Partial<SeatJson> = {},
): Promise<SeatJson> {
  return seated(
    seatId,
    { user: h.user, memberId: await memberIdOf(w.society.id!, h.user.id) },
    h.resident.name,
    designation,
    { unitId: h.link.unitId, ...extra },
  );
}

/** Gives the user a TOTP secret so the admin app accepts them with a committee role; returns a signed-in client. */
export async function adminClient(h: Holder): Promise<Client> {
  const secret = newTotpSecret();
  await User.update({ totpSecretEnc: encryptSecret(secret), mfaEnabledAt: new Date() } as never, {
    where: { id: h.user.id },
  });
  return as(await login({ ...h.user, totpSecret: secret, recoveryCodes: [] }));
}

/** A limit override for a society (`limit.admin_seats` and the like). */
export async function setLimit(societyId: number, key: string, value: number): Promise<void> {
  await EntitlementOverride.create({
    societyId,
    targetType: 'KEY',
    entitlementKey: key,
    moduleNo: null,
    isEnabled: null,
    limitValue: value,
    isUnlimited: false,
    source: 'SUPPORT',
    reason: 'test override',
    startsAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    expiryProcessedAt: null,
    createdBy: null,
    updatedBy: null,
    version: 1,
  } as never);
  await invalidateEntitlements(societyId);
}

/**
 * The US-10-02 starting point: Rajesh (chairman), Arjun (secretary) and Meera (treasurer) sit in the current term
 * "Managing Committee 2024-2029"; Farhan and Lata are plain owners; a draft seats Farhan (Chairman), Arjun (Secretary) and
 * Lata (Treasurer). The signed-in chairman `w.c` is not a seat holder.
 */
export async function handoverWorld(o: Parameters<typeof committeeWorld>[0] = {}) {
  const w = await committeeWorld(o);
  const rajesh = await holder(w, 1, 'Rajesh Kulkarni');
  const arjun = await holder(w, 2, 'Arjun Shah');
  const meera = await holder(w, 3, 'Meera Iyer');
  const farhan = await holder(w, 4, 'Farhan Qureshi');
  const lata = await holder(w, 5, 'Lata Menon');
  await setRole(w.society.id!, rajesh.user.id, 'chairman');
  await setRole(w.society.id!, arjun.user.id, 'secretary');
  await setRole(w.society.id!, meera.user.id, 'treasurer');
  const current = await rawTerm(w.society.id!, {
    members: [
      await seatedFor(w, rajesh, 'S1', 'CHAIRMAN'),
      await seatedFor(w, arjun, 'S2', 'SECRETARY'),
      await seatedFor(w, meera, 'S3', 'TREASURER'),
    ],
  });
  const draft = await postTerm(
    w.c,
    termBody([seat(farhan, w, 4, 'CHAIRMAN'), seat(arjun, w, 2, 'SECRETARY'), seat(lata, w, 5, 'TREASURER')]),
  );
  return { w, rajesh, arjun, meera, farhan, lata, current, draft };
}

export const previewOf = async (c: Client, id: number) => {
  const r = await c('get', `/committee/terms/${id}/activation-preview`);
  if (r.status !== 200) throw new Error(`preview ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
};
export const activateBody = (preview: { previewHash: string }, version: number, extra = {}) => ({
  version,
  previewHash: preview.previewHash,
  resolutionRef: 'CM/2026-27/01',
  reason: 'The new committee takes charge',
  ...extra,
});
