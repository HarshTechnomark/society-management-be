import { randomUUID } from 'node:crypto';
import { Resident, UnitResident, sequelize } from '../../src/models';
import { systemCtx } from '../../src/types/context';
import { flushAcl } from '../../src/modules/access-control/access-control.cache';
import { putPlaceholderFile } from '../../src/modules/society-setup/society-setup.ports';
import { registerResidents, setResidentPorts } from '../../src/modules/residents/residents.public';
import { createResident } from '../../src/modules/residents/residents.service';
import { resetPart3Placeholders } from '../../src/modules/residents/residents.part3.ports';
import { as, login, memberUser } from './access';
import { makeBuilding, makeUnit, resetSetup, setupSociety } from './society-setup';
import { settings } from '../../src/modules/society-setup/society-setup.public';

export { idemKey } from './society-setup';

/** Fresh state for the part 3 tests: module 02 to 08 ports, module 09 registrations and the part 3 placeholders. */
export async function resetPart3(): Promise<void> {
  await resetSetup();
  registerResidents();
  setResidentPorts();
  resetPart3Placeholders();
}

export async function p3Society() {
  const s = await setupSociety();
  const b = await makeBuilding(s.c, { code: 'A' });
  return { ...s, building: b };
}

let seq = 0;
const nextMobile = (): string =>
  `98${String(76_000_000 + ++seq + Math.floor(Math.random() * 1000) * 10000).slice(-8)}`;

/** A resident with an OWNER (or other) link; with `login` the resident also has a signed-in resident-app user. */
export async function addPerson(
  society: { id?: number },
  unitId: number,
  o: {
    name: string;
    relation?: 'OWNER' | 'CO_OWNER' | 'FAMILY';
    login?: boolean;
    sharePercent?: string;
    isPrimary?: boolean;
    fromDate?: string;
  },
) {
  const societyId = society.id!;
  const fromDate = o.fromDate ?? '2026-01-01';
  const created = await createResident(
    systemCtx('test'),
    societyId,
    {
      name: o.name,
      mobile: nextMobile(),
      link: {
        unitId,
        relation: o.relation ?? 'OWNER',
        familyRelation: o.relation === 'FAMILY' ? 'CHILD' : undefined,
        householdOf: o.relation === 'FAMILY' ? 'OWNER' : undefined,
        sharePercent: o.sharePercent,
        isPrimary: o.isPrimary,
        fromDate,
      },
    },
    {},
  );
  let call: ReturnType<typeof as> | null = null;
  let userId: number | null = null;
  if (o.login) {
    const u = await memberUser(society as never, 'owner', { name: o.name });
    await Resident.update({ userId: u.id, memberId: u.memberId }, { where: { id: created.id } });
    await flushAcl();
    call = as(await login(u, { app: 'RESIDENT' }), 'RESIDENT');
    userId = u.id;
  }
  return { residentId: created.id, c: call, userId, linkId: created.links[0]!.linkId };
}

export async function admin(society: { id?: number }, role = 'secretary') {
  const u = await memberUser(society as never, role, { name: role });
  return Object.assign(as(await login(u)), { userId: u.id });
}

export const fileFor = (societyId: number, userId: number, purpose = 'RESIDENT_RECORD'): number =>
  putPlaceholderFile({
    societyId,
    ownerUserId: userId,
    name: 'doc.pdf',
    content: Buffer.from('x'),
    purpose,
    contentType: 'application/pdf',
  });

export const key = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

export const setSetting = (societyId: number, k: string, v: unknown) =>
  sequelize.transaction(t => settings.set(systemCtx('test'), societyId, k as never, v as never, t));

export const openLinks = (unitId: number) => UnitResident.findAll({ where: { unitId, toDate: null } });
