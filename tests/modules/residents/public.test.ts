import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Resident, Tenancy, UnitResident, closeDb, sequelize } from '../../../src/models';
import { advance, nowMs, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { createLink } from '../../../src/modules/residents/residents.links.service';
import { getHouseholdControl, residents } from '../../../src/modules/residents/residents.public';
import { systemCtx } from '../../../src/types/context';
import {
  addResident,
  mobile,
  owner,
  residentSociety,
  residentUser,
  resetResidents,
} from '../../helpers/residents';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetResidents);

async function tenancyOn(
  societyId: number,
  unitId: number,
  landlordId: number,
  o: { payer: 'OWNER' | 'TENANT'; status: string; start?: string; end?: string; endedOn?: string | null },
) {
  const tenant = await Resident.create({
    societyId,
    name: 'Neha Verma',
    mobile: mobile(),
    status: 'ACTIVE',
    source: 'TENANCY',
    version: 1,
  } as never);
  const tn = await Tenancy.create({
    societyId,
    unitId,
    tenantResidentId: tenant.id!,
    landlordResidentId: landlordId,
    status: o.status,
    agreementStart: o.start ?? '2026-10-01',
    agreementEnd: o.end ?? '2027-09-30',
    maintenancePayer: o.payer,
    policeVerificationStatus: 'NOT_SUBMITTED',
    source: 'ADMIN',
    endedOn: o.endedOn ?? null,
    moveInDate: o.start ?? '2026-10-01',
  } as never);
  await sequelize.transaction(t =>
    createLink(
      systemCtx('t'),
      societyId,
      {
        residentId: tenant.id!,
        unitId,
        relation: 'TENANT',
        tenancyId: tn.id!,
        fromDate: o.start ?? '2026-10-01',
      },
      t,
      { internal: true },
    ),
  );
  return { tenant, tn };
}

describe('billToFor (BR-09-70, T09-01)', () => {
  it('names the tenant when the payer is TENANT and the tenancy is live, else the primary owner, else the lowest co-owner, else null', async () => {
    const { society, c, unit } = await residentSociety({ flats: 4 });
    const o1 = await addResident(c, { name: 'Owner One', mobile: mobile(), link: owner(unit(1).id) });
    const o2 = await addResident(c, { name: 'Owner Two', mobile: mobile(), link: owner(unit(2).id) });
    const o3 = await addResident(c, { name: 'Owner Three', mobile: mobile(), link: owner(unit(3).id) });
    const t1 = await tenancyOn(society.id!, unit(1).id, o1.id, { payer: 'TENANT', status: 'ACTIVE' });
    await tenancyOn(society.id!, unit(2).id, o2.id, { payer: 'OWNER', status: 'ACTIVE' });
    const ended = await tenancyOn(society.id!, unit(3).id, o3.id, {
      payer: 'TENANT',
      status: 'ENDED',
      start: '2026-01-01',
      end: '2026-12-31',
      endedOn: '2026-11-20',
    });
    const bill = (u: number, d: string) => residents.billToFor(u, d);
    expect(await bill(unit(1).id, '2026-12-01')).toMatchObject({
      residentId: t1.tenant.id,
      relation: 'TENANT',
      tenancyId: t1.tn.id,
      societyId: society.id,
      name: 'Neha Verma',
    });
    expect(await bill(unit(1).id, '2026-09-30')).toMatchObject({ residentId: o1.id, relation: 'OWNER' });
    expect(await bill(unit(2).id, '2026-12-01')).toMatchObject({ residentId: o2.id, relation: 'OWNER' });
    // ENDED with endedOn >= date still bills the tenant; after that the owner
    expect(await bill(unit(3).id, '2026-11-20')).toMatchObject({ residentId: ended.tenant.id });
    expect(await bill(unit(3).id, '2026-11-21')).toMatchObject({ residentId: o3.id });
    // an unsold builder flat has no one to bill
    expect(await bill(unit(4).id, '2026-12-01')).toBeNull();
    expect(await bill(999_999, '2026-12-01')).toBeNull();
  });

  it('with several owners the primary one is billed today and the lowest co-owner id when nobody is primary', async () => {
    const { society, c, unit } = await residentSociety();
    const a = await addResident(c, { name: 'Owner One', link: owner(unit(1).id) });
    const b = await addResident(c, {
      name: 'Owner Two',
      link: { unitId: unit(1).id, relation: 'CO_OWNER', fromDate: '2024-01-01' },
    });
    expect((await residents.billToFor(unit(1).id, '2026-11-01'))!.residentId).toBe(a.id);
    // the owner link ends in the past: the co-owner is promoted by the service; before that date the owner was billed
    await UnitResident.update(
      { toDate: '2026-06-30', endReason: 'SOLD', isPrimary: false },
      { where: { residentId: a.id } },
    );
    await UnitResident.update({ relation: 'CO_OWNER', isPrimary: false }, { where: { residentId: b.id } });
    expect((await residents.billToFor(unit(1).id, '2026-11-01'))!.residentId).toBe(b.id);
    expect((await residents.billToFor(unit(1).id, '2026-06-30'))!.residentId).toBe(a.id);
    expect(society.id).toBeGreaterThan(0);
  });
});

describe('listForUnit, unitIdsForUser, getActiveUnitLinks and friends (section 8.22)', () => {
  it('lists the links active on a date, and every link overlapping a range with from and to', async () => {
    const { society, c, unit } = await residentSociety();
    const a = await addResident(c, {
      name: 'Owner One',
      mobile: '9820011121',
      link: owner(unit(1).id, { fromDate: '2020-01-01' }),
    });
    const link = (await UnitResident.findOne({ where: { residentId: a.id } }))!;
    await c('post', `/residents/links/${link.id}/end`, {
      toDate: '2026-06-30',
      endReason: 'SOLD',
      version: 1,
    });
    await addResident(c, { name: 'Owner Two', link: owner(unit(1).id, { fromDate: '2026-07-01' }) });
    const names = (l: { name: string }[]) => l.map(x => x.name);
    expect(names(await residents.listForUnit(society.id!, unit(1).id))).toEqual(['Owner Two']);
    expect(names(await residents.listForUnit(society.id!, unit(1).id, { date: '2026-01-01' }))).toEqual([
      'Owner One',
    ]);
    const range = await residents.listForUnit(society.id!, unit(1).id, {
      from: '2026-06-01',
      to: '2026-07-31',
    });
    expect(range.map(x => [x.name, x.toDate])).toEqual([
      ['Owner One', '2026-06-30'],
      ['Owner Two', null],
    ]);
    expect(range[0]).toMatchObject({
      relation: 'OWNER',
      mobile: '9820011121',
      isResiding: true,
      canLogin: true,
    });
    expect(await residents.listForUnit(society.id!, unit(1).id, { relation: 'TENANT' })).toEqual([]);
    expect(await residents.activeLinkCount(society.id!, unit(1).id)).toBe(1);
    // another society sees nothing of this one
    expect(await residents.listForUnit(society.id! + 999, unit(1).id)).toEqual([]);
  });

  it('getActiveUnitLinks keeps the strongest relation per unit, drops inactive residents and links that have not started', async () => {
    const { society, c, unit } = await residentSociety();
    const ru = await residentUser(society, unit(1).id, { relation: 'FAMILY', name: 'Both Sides' });
    await sequelize.transaction(t =>
      createLink(
        systemCtx('t'),
        society.id!,
        {
          residentId: ru.resident.id!,
          unitId: unit(2).id,
          relation: 'CARETAKER',
          householdOf: 'OWNER',
          fromDate: '2026-01-01',
        },
        t,
        { checkFeature: false },
      ),
    );
    await addResident(c, { name: 'Future Owner', link: owner(unit(3).id, { fromDate: '2026-11-20' }) });
    expect(await residents.getActiveUnitLinks(society.id!, ru.user.id)).toEqual([
      { unitId: unit(1).id, relation: 'FAMILY' },
      { unitId: unit(2).id, relation: 'FAMILY' },
    ]);
    expect(await residents.unitIdsForUser(society.id!, ru.user.id)).toEqual([unit(1).id, unit(2).id]);
    expect(await residents.getActiveUnitLinks(society.id! + 999, ru.user.id)).toEqual([]);
    await Resident.update({ status: 'INACTIVE' }, { where: { id: ru.resident.id } });
    expect(await residents.unitIdsForUser(society.id!, ru.user.id)).toEqual([]);
  });

  it('changedSince is true after any link or tenancy write, visitor approvers and audiences follow the links', async () => {
    const { society, c, unit } = await residentSociety();
    const before = new Date(nowMs() - 60_000);
    expect(await residents.changedSince(society.id!, new Date(nowMs()))).toBe(false);
    const login = await residentUser(society, unit(1).id, { name: 'Owner Login' });
    expect(await residents.changedSince(society.id!, before)).toBe(true);
    advance(60_000);
    expect(await residents.changedSince(society.id!, new Date(nowMs() + 3_600_000))).toBe(false);
    // visitors: residing links with a login, else the primary owner with a login
    expect(await residents.visitorApproverUserIds(society.id!, unit(1).id)).toEqual([login.user.id]);
    expect(await residents.visitorApproverUserIds(society.id!, unit(2).id)).toEqual([]);
    await addResident(c, { name: 'Away Owner', link: owner(unit(2).id, { isResiding: false }) });
    expect(await residents.visitorApproverUserIds(society.id!, unit(2).id)).toEqual([]);
    // audiences
    expect(await residents.audienceUserIds(society.id!, { type: 'OWNERS' })).toContain(login.user.id);
    expect(await residents.audienceUserIds(society.id!, { type: 'TENANTS' })).toEqual([]);
    expect(await residents.audienceUserIds(society.id!, { type: 'UNITS', unitIds: [unit(3).id] })).toEqual(
      [],
    );
    expect(await residents.audienceUserIds(society.id!, { type: 'ALL' })).toContain(login.user.id);
    expect(await residents.audienceUserIds(society.id!, { type: 'BUILDING', buildingId: 1 })).toEqual([]);
    expect(await residents.getSummary(society.id!, login.resident.id!)).toEqual({
      id: login.resident.id,
      name: 'Owner Login',
      userId: login.user.id,
      status: 'ACTIVE',
    });
    expect(await residents.getSummary(society.id!, 999_999)).toBeNull();
    setNow('2026-11-01T04:30:00Z');
  });
});

describe('getHouseholdControl (T09-42)', () => {
  it('returns the unit ids where the caller holds the owner household of the member, and null for a neighbour', async () => {
    const { society, unit } = await residentSociety();
    const ownerA = await residentUser(society, unit(1).id, { name: 'Owner A' });
    const fam = await residentUser(society, unit(1).id, { relation: 'FAMILY', name: 'Family Member' });
    const ownerB = await residentUser(society, unit(2).id, { name: 'Owner B' });
    const ctxOf = (u: { id: number }) => ({
      ...systemCtx('t'),
      society: { id: society.id!, name: 'x', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: 'PREMIUM' },
      user: { id: u.id, name: 'x', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
    });
    expect(await getHouseholdControl(ctxOf(ownerA.user), fam.resident.memberId!)).toEqual({
      unitIds: [unit(1).id],
    });
    expect(await getHouseholdControl(ctxOf(ownerB.user), fam.resident.memberId!)).toBeNull();
    // a tenant household member is controlled by the tenant, not by the owner
    const tenant = await tenancyOn(society.id!, unit(2).id, ownerB.resident.id!, {
      payer: 'OWNER',
      status: 'ACTIVE',
    });
    const tf = await residentUser(society, unit(2).id, {
      relation: 'FAMILY',
      name: 'Tenant Family',
      householdOf: 'TENANT',
    });
    expect(await getHouseholdControl(ctxOf(ownerB.user), tf.resident.memberId!)).toBeNull();
    await Resident.update({ userId: ownerA.user.id }, { where: { id: tenant.tenant.id } }).catch(
      () => undefined,
    );
  });
});
