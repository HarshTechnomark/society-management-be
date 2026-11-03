import { Resident, SocietyMember, Society, sequelize } from '../../src/models';
import { placeholderFiles, nextPlaceholderFileId } from '../../src/modules/societies/societies.ports';
import {
  approvalStub,
  depositStub,
  registerResidents,
  setPart2Ports,
  setResidentPorts,
} from '../../src/modules/residents/residents.public';
import { settings } from '../../src/modules/society-setup/society-setup.public';
import { systemCtx } from '../../src/types/context';
import { residentPortCalls } from '../../src/modules/residents/residents.ports';
import { as, login, memberUser } from './access';
import { idemKey, makeBuilding, makeUnit, memberOf, resetSetup, setupSociety } from './society-setup';

/** Module 09 part 2 test setup: module 02 to 08 registrations, module 09 registrations and fresh placeholder ports. */
export async function resetResidentsP2(): Promise<void> {
  await resetSetup();
  registerResidents();
  setResidentPorts();
  setPart2Ports();
  approvalStub.reset();
  depositStub.reset();
  residentPortCalls.length = 0;
  placeholderFiles.clear();
}

export async function residentsSociety(o: { plan?: 'STANDARD' | 'PREMIUM' | 'STARTER' } = {}) {
  const base = await setupSociety({ plan: o.plan ?? 'STANDARD' });
  const secretary = await memberOf(base.society, 'secretary');
  const b = await makeBuilding(base.c, { code: 'A' });
  const unit = await makeUnit(base.c, b.id, '1203', 2);
  return { ...base, secretary, building: b, unit };
}

export async function makeFile(
  societyId: number,
  ownerUserId: number,
  purpose: 'KYC_DOCUMENT' | 'RESIDENT_RECORD',
): Promise<number> {
  const fileId = nextPlaceholderFileId();
  placeholderFiles.set(fileId, {
    fileId,
    societyId,
    purpose,
    name: 'doc.pdf',
    contentType: 'application/pdf',
    content: Buffer.from('x'),
    ownerUserId,
    status: 'CLEAN',
  } as never);
  return fileId;
}

/** Document item for a request body: a clean file of the right purpose owned by `userId`. */
export async function docItem(societyId: number, userId: number, docType: string) {
  const kyc = ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID', 'OTHER_ID'].includes(docType);
  return { fileId: await makeFile(societyId, userId, kyc ? 'KYC_DOCUMENT' : 'RESIDENT_RECORD'), docType };
}

/**
 * A resident with a login: user, member (role `owner` or `tenant`), resident row with `userId` and `memberId`, and, with
 * `link`, the unit link (added by the admin client through the part 1 route).
 */
export async function residentWithLogin(
  s: Awaited<ReturnType<typeof residentsSociety>>,
  o: {
    name: string;
    mobile: string;
    role?: 'owner' | 'tenant';
    link?: {
      relation: 'OWNER' | 'CO_OWNER' | 'FAMILY';
      householdOf?: 'OWNER' | 'TENANT';
      familyRelation?: string;
    };
  },
) {
  const user = await memberUser(s.society, o.role ?? 'owner', { name: o.name, mobile: o.mobile });
  const created = await s.c(
    'post',
    '/residents',
    {
      name: o.name,
      mobile: o.mobile,
      ...(o.link ? { link: { unitId: s.unit.id, fromDate: '2026-11-01', ...o.link } } : {}),
    },
    { headers: idemKey() },
  );
  if (created.status !== 201) throw new Error(`resident ${created.status} ${JSON.stringify(created.body)}`);
  const residentId = created.body.data.id as number;
  await Resident.update({ userId: user.id, memberId: user.memberId }, { where: { id: residentId } });
  return { user, residentId, c: as(await login(user, { app: 'RESIDENT' }), 'RESIDENT') };
}

export const ownerOf = (s: Awaited<ReturnType<typeof residentsSociety>>, mobile = '9820000001') =>
  residentWithLogin(s, { name: 'Ravi Shah', mobile, link: { relation: 'OWNER' } });

/** Active tenancy created and approved through the admin routes (secretary approves what the chairman created). */
export async function activeTenancy(
  s: Awaited<ReturnType<typeof residentsSociety>>,
  o: { start?: string; end?: string; payer?: 'OWNER' | 'TENANT'; household?: unknown[] } = {},
) {
  const chair = s.user;
  const created = await s.c(
    'post',
    '/tenancies',
    {
      unitId: s.unit.id,
      tenant: { name: 'Neha Verma', mobile: '9820000002' },
      agreementStart: o.start ?? '2026-11-01',
      agreementEnd: o.end ?? '2027-09-30',
      maintenancePayer: o.payer ?? 'OWNER',
      inviteTenant: false,
      ...(o.household ? { household: o.household } : {}),
      fileIds: [await docItem(s.society.id!, chair.id, 'RENT_AGREEMENT')],
    },
    { headers: idemKey() },
  );
  if (created.status !== 201) throw new Error(`tenancy ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.data.id as number;
  const sub = await s.c('post', `/tenancies/${id}/submit`, { version: 1 });
  if (sub.status !== 200) throw new Error(`submit ${JSON.stringify(sub.body)}`);
  const ap = await s.secretary.c('post', `/tenancies/${id}/approve`, { version: sub.body.data.version });
  if (ap.status !== 200) throw new Error(`approve ${JSON.stringify(ap.body)}`);
  return { id, version: ap.body.data.version as number };
}

/** Writes a society setting (module 08) in its own transaction. */
export async function setSetting(societyId: number, key: string, value: unknown): Promise<void> {
  await sequelize.transaction(t =>
    settings.set(systemCtx('test'), societyId, key as never, value as never, t),
  );
}

export { idemKey, SocietyMember, Society, sequelize };

/** Gives the tenant resident created by `activeTenancy` a login (role `tenant`) and signs in. */
export async function loginTenant(s: Awaited<ReturnType<typeof residentsSociety>>, mobile = '9820000002') {
  const user = await memberUser(s.society, 'tenant', { name: 'Neha Verma', mobile });
  const resident = (await Resident.findOne({ where: { societyId: s.society.id!, mobile } }))!;
  await resident.update({ userId: user.id, memberId: user.memberId });
  return { user, residentId: resident.id!, c: as(await login(user, { app: 'RESIDENT' }), 'RESIDENT') };
}

export async function guardOf(s: Awaited<ReturnType<typeof residentsSociety>>) {
  const user = await memberUser(s.society, 'guard', { name: 'Guard One' });
  return { user, c: as(await login(user, { app: 'GATE' }), 'GATE') };
}
