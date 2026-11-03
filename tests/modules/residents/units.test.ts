import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  MoveRequest,
  OwnershipTransfer,
  Pet,
  Resident,
  Tenancy,
  UnitResident,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { setResidentPorts } from '../../../src/modules/residents/residents.ports';
import { createLink } from '../../../src/modules/residents/residents.links.service';
import { systemCtx } from '../../../src/types/context';
import { makeBuilding, rawUnits } from '../../helpers/society-setup';
import { memberOf } from '../../helpers/society-setup';
import {
  addResident,
  idem,
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

async function rent(
  w: Awaited<ReturnType<typeof residentSociety>>,
  unitIdx: number,
  landlordId: number,
  status = 'ACTIVE',
  end = '2027-09-30',
) {
  const tenant = await Resident.create({
    societyId: w.society.id!,
    name: 'Neha Verma',
    mobile: mobile(),
    status: 'ACTIVE',
    source: 'TENANCY',
    version: 1,
  } as never);
  const tn = await Tenancy.create({
    societyId: w.society.id!,
    unitId: w.unit(unitIdx).id,
    tenantResidentId: tenant.id!,
    landlordResidentId: landlordId,
    status,
    agreementStart: '2026-10-01',
    agreementEnd: end,
    maintenancePayer: 'TENANT',
    policeVerificationStatus: 'VERIFIED',
    source: 'ADMIN',
    moveInDate: '2026-10-01',
    decidedAt: new Date('2026-09-25T00:00:00Z'),
  } as never);
  await sequelize.transaction(t =>
    createLink(
      systemCtx('t'),
      w.society.id!,
      {
        residentId: tenant.id!,
        unitId: w.unit(unitIdx).id,
        relation: 'TENANT',
        tenancyId: tn.id!,
        fromDate: '2026-10-01',
      },
      t,
      { internal: true },
    ),
  );
  return { tenant, tn };
}

describe('flats with people (8.3)', () => {
  it('lists flats with occupancy, owner, tenant, resident count and dues; filters and sorts', async () => {
    const w = await residentSociety({ flats: 4 });
    setResidentPorts({
      unitLedger: {
        balance: async (_s, unitId) =>
          unitId === w.unit(1).id ? 482500 : unitId === w.unit(2).id ? -1000 : 0,
      },
    });
    const o1 = await addResident(w.c, { name: 'Ravi Shah', mobile: '9820011121', link: owner(w.unit(1).id) });
    const o2 = await addResident(w.c, { name: 'Meera Iyer', mobile: mobile(), link: owner(w.unit(2).id) });
    await addResident(w.c, {
      name: 'Away Owner',
      mobile: mobile(),
      link: owner(w.unit(3).id, { isResiding: false }),
    });
    const t = await rent(w, 1, o1.id);
    await UnitResident.update({ isResiding: false }, { where: { residentId: o1.id } });
    expect(o2.id).toBeGreaterThan(0);
    const r = await w.c('get', '/residents/units');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.map((u: any) => [u.unitLabel, u.occupancy, u.duesPaise])).toEqual([
      ['A-101', 'RENTED', 482500],
      ['A-102', 'OWNER_OCCUPIED', -1000],
      ['A-103', 'VACANT', 0],
      ['A-104', 'VACANT', 0],
    ]);
    expect(r.body.data[0]).toMatchObject({
      primaryOwner: { residentId: o1.id, name: 'Ravi Shah', mobile: '9820011121' },
      tenant: { residentId: t.tenant.id, name: 'Neha Verma', tenancyId: t.tn.id, agreementEnd: '2027-09-30' },
      residentCount: 2,
      unitType: 'FLAT',
    });
    expect(r.body.data[1].tenant).toBeNull();
    const q = async (query: Record<string, string>) =>
      (await w.c('get', '/residents/units', undefined, { query })).body.data.map((u: any) => u.unitLabel);
    expect(await q({ occupancy: 'VACANT' })).toEqual(['A-103', 'A-104']);
    expect(await q({ hasDues: 'true' })).toEqual(['A-101']);
    expect(await q({ q: 'meera' })).toEqual(['A-102']);
    expect(await q({ q: 'A-104' })).toEqual(['A-104']);
    expect(await q({ sortBy: 'duesPaise' })).toEqual(['A-101', 'A-103', 'A-104', 'A-102']);
    expect(await q({ sortOrder: 'desc' })).toEqual(['A-104', 'A-103', 'A-102', 'A-101']);
    const p = await w.c('get', '/residents/units', undefined, { query: { limit: '3', page: '2' } });
    expect(p.body.pagination).toMatchObject({ total: 4, totalPages: 2 });
    // the committee member without contacts.view sees masked numbers
    const cm = await memberOf(w.society, 'committee_member');
    expect((await cm.c('get', '/residents/units')).body.data[0].primaryOwner.mobile).toBe('98XXXXX121');
  });

  it('a dues filter or sort on more than 3,000 units without a building is 422 FILTER_TOO_BROAD; with a building it works', async () => {
    const w = await residentSociety({ flats: 2 });
    const b = await makeBuilding(w.c, { code: 'B', floorsAboveGround: 50 });
    await rawUnits(w.society.id!, b.id, 'B', 3001);
    const wide = await w.c('get', '/residents/units', undefined, { query: { hasDues: 'true' } });
    expect([wide.status, wide.body.code]).toEqual([422, 'FILTER_TOO_BROAD']);
    expect(
      (await w.c('get', '/residents/units', undefined, { query: { sortBy: 'duesPaise' } })).body.code,
    ).toBe('FILTER_TOO_BROAD');
    const narrow = await w.c('get', '/residents/units', undefined, {
      query: { hasDues: 'true', buildingId: String(w.buildingId) },
    });
    expect(narrow.status).toBe(200);
    expect(
      (await w.c('get', '/residents/units', undefined, { query: { limit: '5' } })).body.pagination.total,
    ).toBe(3003);
  });
});

describe('unit panel, timeline and statistics (8.3, 8.4)', () => {
  it('the unit panel shows owners, tenancy, household, pets, open requests, dues and the bill recipient; reveal needs contacts.view and is audited', async () => {
    const w = await residentSociety({ flats: 2 });
    setResidentPorts({ unitLedger: { balance: async () => 5000 } });
    const o = await addResident(w.c, { name: 'Ravi Shah', mobile: '9820011121', link: owner(w.unit(1).id) });
    const t = await rent(w, 1, o.id);
    await addResident(w.c, {
      name: 'Owner Family',
      link: {
        unitId: w.unit(1).id,
        relation: 'FAMILY',
        familyRelation: 'SPOUSE',
        householdOf: 'OWNER',
        fromDate: '2026-01-01',
      },
    });
    await Pet.create({
      societyId: w.society.id!,
      unitId: w.unit(1).id,
      ownerResidentId: o.id,
      name: 'Bruno',
      species: 'DOG',
      gender: 'UNKNOWN',
      status: 'ACTIVE',
      version: 1,
    } as never);
    await MoveRequest.create({
      societyId: w.society.id!,
      unitId: w.unit(1).id,
      buildingId: w.buildingId,
      type: 'MOVE_OUT',
      householdOf: 'TENANT',
      tenancyId: t.tn.id!,
      moveDate: '2026-11-10',
      slotStart: '10:00:00',
      slotEnd: '12:00:00',
      status: 'BLOCKED_DUES',
    } as never);
    const r = await w.c('get', `/residents/units/${w.unit(1).id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d.unit).toMatchObject({ label: 'A-101', unitType: 'FLAT' });
    expect(d.occupancy).toBe('RENTED');
    expect(d.owners[0]).toMatchObject({
      name: 'Ravi Shah',
      mobile: '98XXXXX121',
      relation: 'OWNER',
      sharePercent: '100.00',
      isPrimary: true,
    });
    expect(d.tenancy).toMatchObject({
      id: t.tn.id,
      status: 'ACTIVE',
      maintenancePayer: 'TENANT',
      policeVerificationStatus: 'VERIFIED',
    });
    expect(d.household.map((h: any) => [h.name, h.householdOf])).toEqual([['Owner Family', 'OWNER']]);
    expect(d.pets).toEqual([{ id: expect.any(Number), name: 'Bruno', species: 'DOG' }]);
    expect(d.openRequests).toEqual([{ kind: 'MOVE_OUT', id: expect.any(Number), status: 'BLOCKED_DUES' }]);
    expect(d.duesPaise).toBe(5000);
    expect(d.billTo).toMatchObject({ residentId: t.tenant.id, relation: 'TENANT' });
    const rev = await w.c('get', `/residents/units/${w.unit(1).id}`, undefined, {
      query: { reveal: 'contacts' },
    });
    expect(rev.body.data.owners[0].mobile).toBe('9820011121');
    expect(
      await AuditLog.count({
        where: { societyId: w.society.id!, action: 'residents.resident.contacts_revealed' },
      }),
    ).toBe(1);
    const cm = await memberOf(w.society, 'committee_member');
    expect(
      (await cm.c('get', `/residents/units/${w.unit(1).id}`, undefined, { query: { reveal: 'contacts' } }))
        .body.code,
    ).toBe('PERMISSION_DENIED');
    expect((await w.c('get', '/residents/units/999999')).body.code).toBe('UNIT_NOT_FOUND');
  });

  it('the timeline merges links, tenancies, moves, permits and transfers, newest first', async () => {
    const w = await residentSociety();
    const o = await addResident(w.c, {
      name: 'Ravi Shah',
      link: owner(w.unit(1).id, { fromDate: '2019-04-01' }),
    });
    const t = await rent(w, 1, o.id);
    await MoveRequest.create({
      societyId: w.society.id!,
      unitId: w.unit(1).id,
      buildingId: w.buildingId,
      type: 'MOVE_IN',
      householdOf: 'TENANT',
      tenancyId: t.tn.id!,
      moveDate: '2026-10-01',
      slotStart: '10:00:00',
      slotEnd: '12:00:00',
      status: 'COMPLETED',
      completedAt: new Date('2026-10-01T09:00:00Z'),
    } as never);
    await OwnershipTransfer.create({
      societyId: w.society.id!,
      unitId: w.unit(1).id,
      transferType: 'SALE',
      status: 'COMPLETED',
      effectiveDate: '2026-10-15',
      buyersJson: [{ residentId: o.id, sharePercent: '100.00', isPrimary: true, isResiding: true }],
    } as never);
    const r = await w.c('get', `/residents/units/${w.unit(1).id}/timeline`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const kinds = r.body.data.map((e: any) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'LINK_STARTED',
        'TENANCY_CREATED',
        'TENANCY_APPROVED',
        'TENANCY_ACTIVATED',
        'MOVE_COMPLETED',
        'OWNERSHIP_TRANSFERRED',
      ]),
    );
    const ats = r.body.data.map((e: any) => e.at);
    expect(ats).toEqual([...ats].sort().reverse());
    expect(r.body.data.find((e: any) => e.kind === 'OWNERSHIP_TRANSFERRED').label).toBe(
      'A-101 transferred to Ravi Shah (SALE)',
    );
    expect(r.body.data[r.body.data.length - 1]).toMatchObject({
      at: '2019-04-01',
      kind: 'LINK_STARTED',
      refType: 'unit_resident',
    });
    expect((await w.c('get', '/residents/units/999999/timeline')).body.code).toBe('UNIT_NOT_FOUND');
  });

  it('statistics: units = owner-occupied + rented + vacant, expiring tenancies, police verification, open requests and counts', async () => {
    const w = await residentSociety({ flats: 4 });
    const o1 = await addResident(w.c, { name: 'Owner One', mobile: mobile(), link: owner(w.unit(1).id) });
    const o2 = await addResident(w.c, { name: 'Owner Two', mobile: mobile(), link: owner(w.unit(2).id) });
    await addResident(w.c, { name: 'Owner Three', mobile: mobile(), link: owner(w.unit(3).id) });
    await rent(w, 1, o1.id, 'ACTIVE', '2026-11-20');
    await rent(w, 2, o2.id, 'EXPIRED_OVERSTAY', '2026-10-25');
    await residentUser(w.society, w.unit(4).id, { name: 'Login Owner' });
    await MoveRequest.create({
      societyId: w.society.id!,
      unitId: w.unit(3).id,
      buildingId: w.buildingId,
      type: 'MOVE_IN',
      householdOf: 'OWNER',
      moveDate: '2026-11-10',
      slotStart: '10:00:00',
      slotEnd: '12:00:00',
      status: 'PENDING_APPROVAL',
    } as never);
    await UnitResident.update({ isResiding: false }, { where: { residentId: [o1.id, o2.id] } });
    const r = await w.c('get', '/residents/stats');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      units: 4,
      ownerOccupied: 2,
      rented: 2,
      vacant: 0,
      tenanciesExpiringIn30: 1,
      tenanciesExpiringIn60: 1,
      tenanciesExpiringIn90: 1,
      overstaying: 1,
      policeVerification: { active: 2, verified: 2, pending: 0 },
      openRequests: { join: 0, moveIn: 1, moveOut: 0, renovation: 0, transfer: 0 },
      residentsWithLogin: 1,
      residents: 6,
      petsVaccinationExpired: 0,
    });
    const s = r.body.data;
    expect(s.units).toBe(s.ownerOccupied + s.rented + s.vacant);
  });
});

describe('owner portfolio (8.18)', () => {
  it('lists the flats a resident owns with dues, tenancy and open requests; a tenant or a family member sees none', async () => {
    const w = await residentSociety({ flats: 3 });
    setResidentPorts({ unitLedger: { balance: async () => 4000 } });
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Portfolio Owner' });
    await sequelize.transaction(t =>
      createLink(
        systemCtx('t'),
        w.society.id!,
        { residentId: me.resident.id!, unitId: w.unit(2).id, relation: 'OWNER', fromDate: '2026-01-01' },
        t,
        { checkFeature: false },
      ),
    );
    await rent(w, 2, me.resident.id!);
    const r = await me.c('get', '/me/portfolio');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(
      r.body.data.units.map((u: any) => [u.unitLabel, u.occupancy, u.duesPaise, u.tenancy?.status ?? null]),
    ).toEqual([
      ['A-101', 'OWNER_OCCUPIED', 4000, null],
      ['A-102', 'RENTED', 4000, 'ACTIVE'],
    ]);
    expect(r.body.data.units[1].tenancy).toMatchObject({
      agreementEnd: '2027-09-30',
      policeVerificationStatus: 'VERIFIED',
    });
    const fam = await residentUser(w.society, w.unit(3).id, { relation: 'FAMILY', name: 'Family Only' });
    expect((await fam.c('get', '/me/portfolio')).body.data.units).toEqual([]);
    void idem;
  });
});
