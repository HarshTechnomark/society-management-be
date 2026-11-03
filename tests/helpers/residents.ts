import { randomUUID } from 'node:crypto';
import { Resident, Society, UnitResident, sequelize } from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { drainQueues } from '../../src/lib/queue';
import { registerResidents } from '../../src/modules/residents/residents.public';
import { residentPortCalls, setResidentPorts } from '../../src/modules/residents/residents.ports';
import { createLink } from '../../src/modules/residents/residents.links.service';
import { syncMembership } from '../../src/modules/residents/residents.sync';
import { putPlaceholderFile } from '../../src/modules/society-setup/society-setup.ports';
import { systemCtx } from '../../src/types/context';
import { as, login } from './access';
import { makeUser } from './auth';
import { makeBuilding, makeUnit, memberOf, resetSetup, setupSociety } from './society-setup';
import type { SubSocietyOpts } from './subscriptions';

/** Fresh state with the module 02 to 08 ports and the module 09 registrations. Call from `beforeEach`. */
export async function resetResidents(): Promise<void> {
  await resetSetup();
  setResidentPorts();
  residentPortCalls.length = 0;
  registerResidents();
  setNow('2026-11-01T04:30:00Z');
}

export type Client = ReturnType<typeof as>;
export const idem = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

/** A society (PREMIUM unless asked), its chairman, tower A and flats `A-101`... (units made through the API). */
export async function residentSociety(o: SubSocietyOpts & { flats?: number; role?: string } = {}): Promise<{
  society: Society;
  c: Client;
  user: Awaited<ReturnType<typeof setupSociety>>['user'];
  buildingId: number;
  unit: (n: number) => { id: number; label: string };
  units: { id: number; label: string; version: number }[];
}> {
  const s = await setupSociety({ plan: 'PREMIUM', ...o });
  const b = await makeBuilding(s.c, { code: 'A', floorsAboveGround: 20 });
  const units: { id: number; label: string; version: number }[] = [];
  for (let i = 0; i < (o.flats ?? 3); i++) units.push(await makeUnit(s.c, b.id, String(101 + i), 1));
  return { ...s, buildingId: b.id, units, unit: n => units[n - 1]! };
}

/** An admin of the society with another role (the default fixtures use the chairman). */
export const adminOf = (society: Society, role: string) => memberOf(society, role);

/** POST /residents with a link; returns the body `data`. */
export async function addResident(
  c: Client,
  body: Record<string, unknown>,
  expect: number | null = 201,
): Promise<any> {
  const r = await c('post', '/residents', body, { headers: idem() });
  if (expect !== null && r.status !== expect)
    throw new Error(`addResident ${r.status} ${JSON.stringify(r.body)}`);
  return expect === null ? r : r.body.data;
}

export const owner = (unitId: number, o: Record<string, unknown> = {}) => ({
  unitId,
  relation: 'OWNER',
  fromDate: '2019-04-01',
  ...o,
});

let mobileSeq = 0;
/** A fresh valid mobile number. */
export const mobile = (): string => `97${String(10_000_000 + ++mobileSeq).padStart(8, '0')}`;

/**
 * A resident with a login who is a resident-scope member through the unit link (the path the invitation accept takes):
 * the user, the resident, the link, `userId` and `syncMembership`. Returns a signed-in client of the resident app.
 */
export async function residentUser(
  society: Society,
  unitId: number,
  o: {
    relation?: 'OWNER' | 'CO_OWNER' | 'TENANT' | 'FAMILY' | 'CARETAKER';
    name?: string;
    familyRelation?: 'SPOUSE' | 'CHILD' | 'PARENT';
    householdOf?: 'OWNER' | 'TENANT';
    tenancyId?: number;
    dateOfBirth?: string | null;
  } = {},
) {
  const m = mobile();
  const user = await makeUser({ name: o.name ?? 'Resident', mobile: m });
  const relation = o.relation ?? 'OWNER';
  const resident = await Resident.create({
    societyId: society.id!,
    userId: user.id,
    memberId: null,
    name: o.name ?? 'Resident',
    mobile: m,
    alternateMobile: null,
    email: null,
    dateOfBirth: o.dateOfBirth ?? null,
    gender: null,
    photoFileId: null,
    preferredLanguage: 'en-IN',
    isNri: false,
    overseasPhone: null,
    localRepresentativeResidentId: null,
    status: 'ACTIVE',
    source: 'ADMIN',
    directoryVisible: true,
    showMobileInDirectory: false,
    showEmailInDirectory: false,
    showPhotoInDirectory: false,
    adminNote: null,
    anonymisedAt: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
  } as never);
  const link = await sequelize.transaction(async t => {
    const l = await createLink(
      systemCtx('test'),
      society.id!,
      {
        residentId: resident.id!,
        unitId,
        relation,
        ...(relation === 'FAMILY' ? { familyRelation: o.familyRelation ?? 'SPOUSE' } : {}),
        ...(relation === 'FAMILY' || relation === 'CARETAKER'
          ? { householdOf: o.householdOf ?? 'OWNER' }
          : {}),
        ...(o.tenancyId ? { tenancyId: o.tenancyId } : {}),
        fromDate: '2026-01-01',
      },
      t,
      { internal: true, checkFeature: false },
    );
    await syncMembership(systemCtx('test'), t, resident.id!, { societyId: society.id! });
    return l;
  });
  const fresh = (await Resident.findByPk(resident.id!))!;
  const c = as(await login(user, { app: 'RESIDENT', societyId: society.id! }), 'RESIDENT');
  return { user, resident: fresh, link, c };
}

/** A file in the placeholder store for a document (purpose by type: KYC types use `KYC_DOCUMENT`). */
export function docFile(
  societyId: number,
  ownerUserId: number,
  purpose: 'KYC_DOCUMENT' | 'RESIDENT_RECORD' = 'KYC_DOCUMENT',
  name = 'doc.pdf',
): number {
  return putPlaceholderFile({
    societyId,
    ownerUserId,
    name,
    purpose,
    contentType: 'application/pdf',
    content: Buffer.from('%PDF-1.4 test'),
  });
}

export const openLinks = (societyId: number, unitId: number) =>
  UnitResident.findAll({ where: { societyId, unitId, toDate: null }, order: [['id', 'ASC']] });
export const allLinks = (societyId: number, unitId: number) =>
  UnitResident.findAll({ where: { societyId, unitId }, order: [['id', 'ASC']] });
export { drainQueues };
