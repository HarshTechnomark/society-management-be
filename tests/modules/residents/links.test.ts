import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemberGrant,
  MoveRequest,
  Permission,
  Resident,
  Role,
  SocietyMember,
  Tenancy,
  UnitResident,
  closeDb,
  sequelize,
} from '../../../src/models';
import { hasOpenPeopleOrRequests } from '../../../src/modules/residents/residents.requests';
import { drainQueues } from '../../../src/lib/queue';
import { createLink } from '../../../src/modules/residents/residents.links.service';
import { syncLinksFor } from '../../../src/modules/residents/residents.jobs';
import { setNow } from '../../../src/lib/clock';
import { systemCtx } from '../../../src/types/context';
import { residentPortCalls } from '../../../src/modules/residents/residents.ports';
import { residents } from '../../../src/modules/residents/residents.public';
import { occupancyOfIn } from '../../../src/modules/residents/residents.occupancy';
import {
  accessRelationOf,
  activeOn,
  shareCents,
  strongestRelation,
} from '../../../src/modules/residents/residents.shared';
import { events } from '../../helpers/auth';
import {
  addResident,
  allLinks,
  idem,
  mobile,
  openLinks,
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

describe('pure rules', () => {
  it('T09-02 a link is active when fromDate <= D and toDate is null or >= D', () => {
    const tomorrow = { fromDate: '2026-11-02', toDate: null };
    const yesterday = { fromDate: '2026-01-01', toDate: '2026-10-31' };
    const today = { fromDate: '2026-01-01', toDate: '2026-11-01' };
    expect(activeOn(tomorrow, '2026-11-01')).toBe(false);
    expect(activeOn(yesterday, '2026-11-01')).toBe(false);
    expect(activeOn(today, '2026-11-01')).toBe(true);
    expect(activeOn({ fromDate: '2026-11-01', toDate: null }, '2026-11-01')).toBe(true);
  });

  it('T09-04 relation mapping and the strongest relation', () => {
    expect(accessRelationOf('CO_OWNER')).toBe('OWNER');
    expect(accessRelationOf('OWNER')).toBe('OWNER');
    expect(accessRelationOf('CARETAKER')).toBe('FAMILY');
    expect(strongestRelation(['FAMILY', 'TENANT'])).toBe('TENANT');
    expect(strongestRelation(['FAMILY', 'CARETAKER'])).toBe('FAMILY');
    expect(strongestRelation(['TENANT', 'CO_OWNER', 'FAMILY'])).toBe('OWNER');
  });

  it('shares are exact hundredths', () => {
    expect(shareCents('50')).toBe(5000);
    expect(shareCents('33.33')).toBe(3333);
    expect(shareCents('0.01')).toBe(1);
    expect(shareCents('99.9000')).toBe(9990);
  });
});

describe('owners, co-owners, primary contact and shares (BR-09-10 to BR-09-14, US-09-02)', () => {
  it('BR-09-11 a second OWNER is 409 OWNER_ALREADY_EXISTS and a co-owner needs an owner (422 OWNER_REQUIRED)', async () => {
    const { c, unit } = await residentSociety();
    const co = await addResident(
      c,
      { name: 'Early Co Owner', link: { unitId: unit(1).id, relation: 'CO_OWNER', fromDate: '2026-01-01' } },
      null,
    );
    expect([co.status, co.body.code]).toEqual([422, 'OWNER_REQUIRED']);
    await addResident(c, { name: 'First Owner', link: owner(unit(1).id) });
    const second = await addResident(c, { name: 'Second Owner', link: owner(unit(1).id) }, null);
    expect([second.status, second.body.code]).toEqual([409, 'OWNER_ALREADY_EXISTS']);
  });

  it('T09-08 ten parallel requests adding an OWNER to one flat give exactly one OWNER link', async () => {
    const { society, c, unit } = await residentSociety();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        addResident(
          c,
          { name: `Racer ${String.fromCharCode(65 + i)}`, mobile: mobile(), link: owner(unit(1).id) },
          null,
        ),
      ),
    );
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(results.filter(r => r.status === 409 && r.body.code === 'OWNER_ALREADY_EXISTS')).toHaveLength(9);
    expect(
      await UnitResident.count({ where: { societyId: society.id!, unitId: unit(1).id, relation: 'OWNER' } }),
    ).toBe(1);
  });

  it('T09-03 / US-09-02 two co-owners with 50 and 50 save together, one is primary; 60 and 30 is 422 and changes nothing', async () => {
    const { society, c, unit } = await residentSociety();
    const a = await addResident(c, { name: 'Owner One', link: owner(unit(1).id) });
    const b = await addResident(c, {
      name: 'Owner Two',
      link: { unitId: unit(1).id, relation: 'CO_OWNER', fromDate: '2024-01-01' },
    });
    const [l1, l2] = await openLinks(society.id!, unit(1).id);
    expect([l1!.isPrimary, l2!.isPrimary]).toEqual([true, false]);
    const bad = await c('put', `/residents/units/${unit(1).id}/ownership-shares`, {
      shares: [
        { linkId: l1!.id, sharePercent: '60' },
        { linkId: l2!.id, sharePercent: '30' },
      ],
      primaryLinkId: l1!.id,
      version: [
        { linkId: l1!.id, version: l1!.version },
        { linkId: l2!.id, version: l2!.version },
      ],
    });
    expect([bad.status, bad.body.code]).toEqual([422, 'OWNERSHIP_SHARE_INVALID']);
    expect((await openLinks(society.id!, unit(1).id)).map(l => l.sharePercent)).toEqual([null, null]);
    const good = await c('put', `/residents/units/${unit(1).id}/ownership-shares`, {
      shares: [
        { linkId: l1!.id, sharePercent: '50.00' },
        { linkId: l2!.id, sharePercent: '50' },
      ],
      primaryLinkId: l2!.id,
      version: [
        { linkId: l1!.id, version: l1!.version },
        { linkId: l2!.id, version: l2!.version },
      ],
    });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(good.body.data.map((o: any) => [o.name, o.sharePercent, o.isPrimary])).toEqual([
      ['Owner One', '50.00', false],
      ['Owner Two', '50.00', true],
    ]);
    const rows = await openLinks(society.id!, unit(1).id);
    expect(rows.filter(l => l.isPrimary)).toHaveLength(1);
    expect(a.id + b.id).toBeGreaterThan(0);
    // a stale version, a missing link and a link of another kind
    const stale = await c('put', `/residents/units/${unit(1).id}/ownership-shares`, {
      shares: [
        { linkId: l1!.id, sharePercent: '50' },
        { linkId: l2!.id, sharePercent: '50' },
      ],
      primaryLinkId: l1!.id,
      version: [
        { linkId: l1!.id, version: 1 },
        { linkId: l2!.id, version: 1 },
      ],
    });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const missing = await c('put', `/residents/units/${unit(1).id}/ownership-shares`, {
      shares: [{ linkId: l1!.id, sharePercent: '100' }],
      primaryLinkId: l1!.id,
      version: [{ linkId: l1!.id, version: 3 }],
    });
    expect([missing.status, missing.body.code]).toEqual([422, 'OWNERSHIP_SHARE_INVALID']);
  });

  it('a single owner without a stored share is shown as 100.00; one share without the others is refused', async () => {
    const { society, c, unit } = await residentSociety();
    const o = await addResident(c, { name: 'Sole Owner', link: owner(unit(1).id) });
    const link = (await openLinks(society.id!, unit(1).id))[0]!;
    expect(link.sharePercent).toBeNull();
    expect(o.links[0].sharePercent).toBe('100.00');
    const p = await c('patch', `/residents/links/${link.id}`, { sharePercent: '60', version: 1 });
    expect([p.status, p.body.code]).toEqual([422, 'OWNERSHIP_SHARE_INVALID']);
    const ok = await c('patch', `/residents/links/${link.id}`, { sharePercent: '100', version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.sharePercent).toBe('100.00');
  });

  it('BR-09-14 the first owner is primary, another can take it, and only owner links can be primary', async () => {
    const { society, c, unit } = await residentSociety();
    await addResident(c, { name: 'Owner One', link: owner(unit(1).id) });
    const co = await addResident(c, {
      name: 'Owner Two',
      link: { unitId: unit(1).id, relation: 'CO_OWNER', fromDate: '2024-01-01' },
    });
    const coLink = co.links[0];
    const moved = await c('patch', `/residents/links/${coLink.linkId}`, {
      isPrimary: true,
      version: coLink.version,
    });
    expect(moved.status).toBe(200);
    const rows = await openLinks(society.id!, unit(1).id);
    expect(rows.map(l => l.isPrimary)).toEqual([false, true]);
    const fam = await addResident(c, {
      name: 'Family Member',
      link: {
        unitId: unit(1).id,
        relation: 'FAMILY',
        familyRelation: 'SPOUSE',
        householdOf: 'OWNER',
        fromDate: '2026-01-01',
      },
    });
    const bad = await c('patch', `/residents/links/${fam.links[0].linkId}`, { isPrimary: true, version: 1 });
    expect([bad.status, bad.body.code]).toEqual([422, 'PRIMARY_MUST_BE_OWNER']);
    const badNew = await addResident(
      c,
      {
        name: 'Another Family',
        link: {
          unitId: unit(1).id,
          relation: 'FAMILY',
          familyRelation: 'CHILD',
          householdOf: 'OWNER',
          isPrimary: true,
          fromDate: '2026-01-01',
        },
      },
      null,
    );
    expect([badNew.status, badNew.body.code]).toEqual([422, 'PRIMARY_MUST_BE_OWNER']);
  });

  it('BR-09-13 the same person cannot be linked twice to a flat, and not over an earlier period', async () => {
    const { society, c, unit } = await residentSociety();
    const r = await addResident(c, { name: 'Ravi Shah', mobile: mobile(), link: owner(unit(1).id) });
    const again = await c(
      'post',
      `/residents/${r.id}/links`,
      { unitId: unit(1).id, relation: 'CO_OWNER', fromDate: '2026-01-01' },
      { headers: idem() },
    );
    expect([again.status, again.body.code]).toEqual([409, 'LINK_ALREADY_ACTIVE']);
    const link = (await openLinks(society.id!, unit(1).id))[0]!;
    await c('post', `/residents/links/${link.id}/end`, {
      toDate: '2026-10-01',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    const overlap = await c(
      'post',
      `/residents/${r.id}/links`,
      { unitId: unit(1).id, relation: 'OWNER', fromDate: '2026-09-01' },
      { headers: idem() },
    );
    expect([overlap.status, overlap.body.code]).toEqual([409, 'LINK_ALREADY_ACTIVE']);
    const after = await c(
      'post',
      `/residents/${r.id}/links`,
      { unitId: unit(1).id, relation: 'OWNER', fromDate: '2026-10-02' },
      { headers: idem() },
    );
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    expect((await Resident.findByPk(r.id))!.status).toBe('ACTIVE');
  });
});

describe('ending links (BR-09-9, BR-09-11, BR-09-14, 8.8)', () => {
  it('validates the end date: not in the future, not before the day before the start; a correction records fromDate - 1', async () => {
    const { society, c, unit } = await residentSociety();
    await addResident(c, { name: 'Ravi Shah', link: owner(unit(1).id, { fromDate: '2026-10-10' }) });
    const link = (await openLinks(society.id!, unit(1).id))[0]!;
    const end = (b: Record<string, unknown>) =>
      c('post', `/residents/links/${link.id}/end`, { version: 1, ...b });
    expect((await end({ toDate: '2026-11-02', endReason: 'MOVED_OUT' })).body.code).toBe(
      'LINK_DATES_INVALID',
    );
    expect((await end({ toDate: '2026-10-01', endReason: 'MOVED_OUT' })).body.code).toBe(
      'LINK_DATES_INVALID',
    );
    expect((await end({ toDate: '2026-10-09', endReason: 'MOVED_OUT' })).body.code).toBe(
      'LINK_DATES_INVALID',
    );
    expect((await end({ toDate: '2026-10-20', endReason: 'OTHER' })).body.code).toBe('LINK_DATES_INVALID');
    expect((await end({ toDate: '2026-10-20', endReason: 'TERMINATED' })).status).toBe(400);
    const ok = await end({ toDate: '2026-10-09', endReason: 'CORRECTION' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const row = (await UnitResident.findByPk(link.id))!;
    expect([row.toDate, row.endReason, row.isPrimary]).toEqual(['2026-10-09', 'CORRECTION', false]);
    const again = await end({ toDate: '2026-10-09', endReason: 'CORRECTION' });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('BR-09-11 ending the OWNER with co-owners needs promoteLinkId; the promoted co-owner becomes OWNER and primary', async () => {
    const { society, c, unit } = await residentSociety();
    await addResident(c, { name: 'Owner One', link: owner(unit(1).id) });
    await addResident(c, {
      name: 'Owner Two',
      link: { unitId: unit(1).id, relation: 'CO_OWNER', fromDate: '2024-01-01' },
    });
    const [o1, o2] = await openLinks(society.id!, unit(1).id);
    const noPromote = await c('post', `/residents/links/${o1!.id}/end`, {
      toDate: '2026-11-01',
      endReason: 'SOLD',
      version: 1,
    });
    expect([noPromote.status, noPromote.body.code]).toEqual([422, 'OWNER_REQUIRED']);
    const ok = await c('post', `/residents/links/${o1!.id}/end`, {
      toDate: '2026-11-01',
      endReason: 'SOLD',
      promoteLinkId: o2!.id,
      version: 1,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const open = await openLinks(society.id!, unit(1).id);
    expect(open).toHaveLength(1);
    expect([open[0]!.relation, open[0]!.isPrimary, open[0]!.sharePercent]).toEqual(['OWNER', true, null]);
  });

  it('ending a co-owner with shares gives the remaining owner the whole flat; with three owners the shares are re-scaled to 100', async () => {
    const { society, c, unit } = await residentSociety();
    await addResident(c, { name: 'Owner One', link: owner(unit(1).id) });
    for (const n of ['Two', 'Three'])
      await addResident(c, {
        name: `Owner ${n}`,
        link: { unitId: unit(1).id, relation: 'CO_OWNER', fromDate: '2024-01-01' },
      });
    const rows = await openLinks(society.id!, unit(1).id);
    await c('put', `/residents/units/${unit(1).id}/ownership-shares`, {
      shares: [
        { linkId: rows[0]!.id, sharePercent: '50' },
        { linkId: rows[1]!.id, sharePercent: '25' },
        { linkId: rows[2]!.id, sharePercent: '25' },
      ],
      primaryLinkId: rows[0]!.id,
      version: rows.map(r => ({ linkId: r.id, version: r.version })),
    });
    const end3 = await c('post', `/residents/links/${rows[2]!.id}/end`, {
      toDate: '2026-11-01',
      endReason: 'REMOVED',
      version: 2,
    });
    expect(end3.status, JSON.stringify(end3.body)).toBe(200);
    const left = await openLinks(society.id!, unit(1).id);
    expect(left.map(l => shareCents(l.sharePercent!))).toEqual([6667, 3333]);
  });

  it('BR-09-11 the last owner cannot be ended while the flat has a live tenancy (422 OWNER_REQUIRED); TENANT links are ended through the tenancy', async () => {
    const { society, c, unit } = await residentSociety();
    const o = await addResident(c, { name: 'Owner One', link: owner(unit(1).id) });
    const tenant = await Resident.create({
      societyId: society.id!,
      name: 'Neha Verma',
      mobile: mobile(),
      status: 'ACTIVE',
      source: 'TENANCY',
      version: 1,
    } as never);
    const tn = await Tenancy.create({
      societyId: society.id!,
      unitId: unit(1).id,
      tenantResidentId: tenant.id!,
      landlordResidentId: o.id,
      status: 'ACTIVE',
      agreementStart: '2026-10-01',
      agreementEnd: '2027-09-30',
      maintenancePayer: 'OWNER',
      policeVerificationStatus: 'NOT_SUBMITTED',
      source: 'ADMIN',
      moveInDate: '2026-10-01',
    } as never);
    const tl = await sequelize.transaction(t =>
      createLink(
        systemCtx('t'),
        society.id!,
        {
          residentId: tenant.id!,
          unitId: unit(1).id,
          relation: 'TENANT',
          tenancyId: tn.id!,
          fromDate: '2026-10-01',
        },
        t,
        { internal: true },
      ),
    );
    const ownerLink = (await openLinks(society.id!, unit(1).id)).find(l => l.relation === 'OWNER')!;
    const e1 = await c('post', `/residents/links/${ownerLink.id}/end`, {
      toDate: '2026-11-01',
      endReason: 'SOLD',
      version: 1,
    });
    expect([e1.status, e1.body.code]).toEqual([422, 'OWNER_REQUIRED']);
    const e2 = await c('post', `/residents/links/${tl.id}/end`, {
      toDate: '2026-11-01',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    expect([e2.status, e2.body.code]).toEqual([422, 'USE_TENANCY_FLOW']);
  });
});

async function rentedFlat() {
  const w = await residentSociety();
  const o = await addResident(w.c, { name: 'Owner One', mobile: mobile(), link: owner(w.unit(1).id) });
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
    unitId: w.unit(1).id,
    tenantResidentId: tenant.id!,
    landlordResidentId: o.id,
    status: 'ACTIVE',
    agreementStart: '2026-10-01',
    agreementEnd: '2027-09-30',
    maintenancePayer: 'TENANT',
    policeVerificationStatus: 'NOT_SUBMITTED',
    source: 'ADMIN',
    moveInDate: '2026-10-01',
  } as never);
  const tl = await sequelize.transaction(t =>
    createLink(
      systemCtx('t'),
      w.society.id!,
      {
        residentId: tenant.id!,
        unitId: w.unit(1).id,
        relation: 'TENANT',
        tenancyId: tn.id!,
        fromDate: '2026-10-01',
      },
      t,
      { internal: true },
    ),
  );
  return { ...w, owner: o, tenant, tenancy: tn, tenantLink: tl };
}

describe('occupancy and "Mark vacant" (BR-09-16, BR-09-17, 8.10)', () => {
  it('occupancy is derived: vacant, owner-occupied, rented, and vacant again when nobody is residing', async () => {
    const { society, c, unit } = await residentSociety();
    const occ = async (id: number) => (await occupancyOfIn(society.id!, [id], '2026-11-01')).get(id);
    expect(await occ(unit(1).id)).toBe('VACANT');
    await addResident(c, { name: 'Owner One', link: owner(unit(1).id) });
    expect(await occ(unit(1).id)).toBe('OWNER_OCCUPIED');
    const away = await addResident(c, { name: 'Owner Away', link: owner(unit(2).id, { isResiding: false }) });
    expect(await occ(unit(2).id)).toBe('VACANT');
    expect(away.links[0].isResiding).toBe(false);
    const w = await rentedFlat();
    expect((await occupancyOfIn(w.society.id!, [w.unit(1).id], '2026-11-01')).get(w.unit(1).id)).toBe(
      'RENTED',
    );
    const map = await residents.occupancyOf(w.society.id!, [w.unit(1).id, w.unit(2).id]);
    expect([...map.values()]).toEqual(['RENTED', 'VACANT']);
  });

  it('vacate ends the tenancy and all its links, the owner household, and sets owners to not residing; unpaid ownership stays', async () => {
    const w = await rentedFlat();
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
    const r = await w.c('post', `/residents/units/${w.unit(1).id}/vacate`, {
      reason: 'Everyone has left the flat',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ occupancy: 'VACANT', endedLinks: 2, endedTenancyId: w.tenancy.id });
    const rows = await allLinks(w.society.id!, w.unit(1).id);
    expect(rows.map(l => [l.relation, l.toDate, l.endReason])).toEqual([
      ['OWNER', null, null],
      ['TENANT', '2026-11-01', 'TERMINATED'],
      ['FAMILY', '2026-11-01', 'MOVED_OUT'],
    ]);
    expect(rows[0]!.isResiding).toBe(false);
    const tn = (await Tenancy.findByPk(w.tenancy.id!))!;
    expect([tn.status, tn.endedOn, tn.endReason]).toEqual(['ENDED', '2026-11-01', 'TERMINATED']);
    expect((await Resident.findByPk(w.tenant.id!))!.status).toBe('INACTIVE');
    const again = await w.c('post', `/residents/units/${w.unit(1).id}/vacate`, {
      reason: 'Everyone has left the flat',
    });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('vacate is refused while a move request is open (409 MOVE_REQUEST_EXISTS) and needs a reason (400)', async () => {
    const w = await rentedFlat();
    await MoveRequest.create({
      societyId: w.society.id!,
      unitId: w.unit(1).id,
      buildingId: w.buildingId,
      type: 'MOVE_OUT',
      householdOf: 'TENANT',
      tenancyId: w.tenancy.id!,
      moveDate: '2026-11-10',
      slotStart: '10:00:00',
      slotEnd: '12:00:00',
      status: 'PENDING_APPROVAL',
    } as never);
    const r = await w.c('post', `/residents/units/${w.unit(1).id}/vacate`, {
      reason: 'Everyone has left the flat',
    });
    expect([r.status, r.body.code]).toEqual([409, 'MOVE_REQUEST_EXISTS']);
    expect((await w.c('post', `/residents/units/${w.unit(1).id}/vacate`, { reason: 'no' })).status).toBe(400);
  });
});

describe('membership sync (section 6.2, BR-09-18, BR-09-78)', () => {
  it('T09-10 ending the last link of a resident with a login ends the resident membership, makes them INACTIVE and emits access.changed', async () => {
    const { society, c, unit } = await residentSociety();
    const ru = await residentUser(society, unit(1).id);
    const m = (await SocietyMember.findOne({ where: { societyId: society.id!, userId: ru.user.id } }))!;
    expect(m.status).toBe('ACTIVE');
    expect((await Resident.findByPk(ru.resident.id!))!.memberId).toBe(m.id);
    events.length = 0;
    const end = await c('post', `/residents/links/${ru.link.id}/end`, {
      toDate: '2026-10-31',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    const after = (await Resident.findByPk(ru.resident.id!))!;
    expect([after.status, after.memberId]).toEqual(['INACTIVE', null]);
    expect((await SocietyMember.findByPk(m.id!))!.status).toBe('ENDED');
    const ev = events.filter(e => e.room === `user:${ru.user.id}` && e.event === 'access.changed');
    expect(ev.map(e => (e.payload as { reason: string }).reason)).toContain('UNIT_LINKS_CHANGED');
    expect(ev.find(e => (e.payload as { reason: string }).reason === 'UNIT_LINKS_CHANGED')!.payload).toEqual({
      societyId: society.id,
      reason: 'UNIT_LINKS_CHANGED',
    });
    expect(events.some(e => e.room === `unit:${unit(1).id}` && e.event === 'household.changed')).toBe(true);
    // the same person linked again becomes ACTIVE and a member again
    const again = await c(
      'post',
      `/residents/${ru.resident.id}/links`,
      { unitId: unit(2).id, relation: 'OWNER', fromDate: '2026-11-01' },
      { headers: idem() },
    );
    expect(again.status).toBe(201);
    expect((await Resident.findByPk(ru.resident.id!))!.status).toBe('ACTIVE');
    expect((await SocietyMember.findByPk(m.id!))!.status).toBe('ACTIVE');
  });

  it('a link ended today stays active until midnight: the resident is INACTIVE at once and the daily sync-links job ends the membership', async () => {
    const { society, c, unit } = await residentSociety();
    const ru = await residentUser(society, unit(1).id);
    const end = await c('post', `/residents/links/${ru.link.id}/end`, {
      toDate: '2026-11-01',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect((await Resident.findByPk(ru.resident.id!))!.status).toBe('INACTIVE');
    expect(await residents.unitIdsForUser(society.id!, ru.user.id)).toEqual([]);
    const m = (await SocietyMember.findOne({ where: { societyId: society.id!, userId: ru.user.id } }))!;
    expect(m.status).toBe('ACTIVE');
    setNow('2026-11-02T04:30:00Z');
    expect(await syncLinksFor(society.id!)).toBe(1);
    expect((await SocietyMember.findByPk(m.id!))!.status).toBe('ENDED');
    expect((await Resident.findByPk(ru.resident.id!))!.memberId).toBeNull();
    expect(await syncLinksFor(society.id!)).toBe(0);
  });

  it('T09-11 a chairman who owns a flat keeps the role and the membership when the link ends (BR-09-78)', async () => {
    const { society, c, unit, user } = await residentSociety();
    const m = (await SocietyMember.findOne({ where: { societyId: society.id!, userId: user.id } }))!;
    const role = (await Role.findByPk(m.roleId))!;
    expect(role.key).toBe('chairman');
    const r = await addResident(c, { name: 'Chair Person', mobile: mobile(), link: owner(unit(1).id) });
    await Resident.update({ userId: user.id }, { where: { id: r.id } });
    const link = (await openLinks(society.id!, unit(1).id))[0]!;
    // sync runs on the next change: ending the link
    expect(await residents.unitIdsForUser(society.id!, user.id)).toEqual([unit(1).id]);
    const end = await c('post', `/residents/links/${link.id}/end`, {
      toDate: '2026-10-31',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    const after = (await SocietyMember.findByPk(m.id!))!;
    expect([after.status, after.roleId]).toEqual(['ACTIVE', m.roleId]);
    expect(await residents.unitIdsForUser(society.id!, user.id)).toEqual([]);
    expect((await Resident.findByPk(r.id))!.memberId).toBeNull();
  });

  it('T09-58 / T09-61 ending a link calls module 12 once (resident with a login) and module 19 for every resident, in the same transaction', async () => {
    const { society, c, unit } = await residentSociety();
    const ru = await residentUser(society, unit(1).id, { name: 'Login Owner' });
    const plain = await addResident(c, {
      name: 'Plain Family',
      link: {
        unitId: unit(1).id,
        relation: 'FAMILY',
        familyRelation: 'SPOUSE',
        householdOf: 'OWNER',
        fromDate: '2026-01-01',
      },
    });
    residentPortCalls.length = 0;
    await c('post', `/residents/links/${ru.link.id}/end`, {
      toDate: '2026-10-31',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    await c('post', `/residents/links/${plain.links[0].linkId}/end`, {
      toDate: '2026-11-01',
      endReason: 'REMOVED',
      version: 1,
    });
    const pay = residentPortCalls.filter(x => x.fn === 'payments.onUnitLinkEnded');
    const park = residentPortCalls.filter(x => x.fn === 'parking.onUnitLinkEnded');
    expect(pay.map(x => x.input)).toEqual([{ unitId: unit(1).id, userId: ru.user.id }]);
    expect(park.map(x => (x.input as { residentId: number }).residentId).sort()).toEqual(
      [ru.resident.id!, plain.id].sort(),
    );
    expect(pay.every(x => x.t !== undefined) && park.every(x => x.t !== undefined)).toBe(true);
    expect(society.id).toBeGreaterThan(0);
  });

  it('T09-60 ending a FAMILY link revokes the household grants of that unit only, and emits access.changed with UNIT_LINKS_CHANGED', async () => {
    const { society, c, unit } = await residentSociety();
    await addResident(c, { name: 'Owner One', link: owner(unit(1).id) });
    await addResident(c, { name: 'Owner Two', link: owner(unit(2).id) });
    const fam = await residentUser(society, unit(1).id, { relation: 'FAMILY', name: 'Family Login' });
    await sequelize.transaction(t =>
      createLink(
        systemCtx('t'),
        society.id!,
        {
          residentId: fam.resident.id!,
          unitId: unit(2).id,
          relation: 'FAMILY',
          familyRelation: 'SPOUSE',
          householdOf: 'OWNER',
          fromDate: '2026-01-01',
        },
        t,
        { checkFeature: false },
      ),
    );
    const grant = async (key: string, unitId: number) =>
      MemberGrant.create({
        societyId: society.id!,
        memberId: fam.resident.memberId!,
        permissionId: (await Permission.findOne({ where: { key } }))!.id!,
        effect: 'ALLOW',
        source: 'HOUSEHOLD',
        status: 'ACTIVE',
        startsAt: new Date('2026-10-01T00:00:00Z'),
        endsAt: new Date('2026-12-01T00:00:00Z'),
        reason: 'test',
        grantedBy: fam.user.id,
        expiryReminderSentAt: null,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        unitId,
        createdBy: null,
        updatedBy: null,
      } as never);
    const g1 = await grant('resident.household.view', unit(1).id);
    const g2 = await grant('resident.household.create', unit(2).id);
    events.length = 0;
    const end = await c('post', `/residents/links/${fam.link.id}/end`, {
      toDate: '2026-10-31',
      endReason: 'REMOVED',
      version: 1,
    });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    const [a, b] = [(await MemberGrant.findByPk(g1.id!))!, (await MemberGrant.findByPk(g2.id!))!];
    expect([a.status, a.revokeReason]).toEqual(['REVOKED', 'UNIT_LINK_ENDED']);
    expect(b.status).toBe('ACTIVE');
    const ev = events.find(
      e =>
        e.room === `user:${fam.user.id}` &&
        e.event === 'access.changed' &&
        (e.payload as { reason: string }).reason === 'UNIT_LINKS_CHANGED',
    );
    expect(ev).toBeDefined();
    // the member keeps the other flat, so the membership stays
    expect((await Resident.findByPk(fam.resident.id!))!.status).toBe('ACTIVE');
  });
});

describe('unit guard and onboarding check (T09-43, section 8.24)', () => {
  it('T09-43 the unit guard answers UNIT_HAS_RESIDENTS for a flat with a FAMILY link and null for an empty flat; archive is refused', async () => {
    const { society, c, unit, units } = await residentSociety();
    await addResident(c, {
      name: 'Family Only',
      link: {
        unitId: unit(1).id,
        relation: 'FAMILY',
        familyRelation: 'SPOUSE',
        householdOf: 'OWNER',
        fromDate: '2026-01-01',
      },
    });
    expect(await hasOpenPeopleOrRequests(society.id!, unit(1).id)).toBe(true);
    expect(await hasOpenPeopleOrRequests(society.id!, unit(2).id)).toBe(false);
    const arch = await c('post', `/units/${unit(1).id}/archive`, {
      version: units[0]!.version,
      reason: 'Merged flats',
    });
    expect(arch.status).toBe(409);
    expect(JSON.stringify(arch.body.errors)).toContain('UNIT_HAS_RESIDENTS');
    const ok = await c('post', `/units/${unit(2).id}/archive`, {
      version: units[1]!.version,
      reason: 'Merged flats',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe('household links and unit rules (BR-09-10, BR-09-15)', () => {
  it('BR-09-15 a tenant-household link needs a live tenancy (422 NO_LIVE_TENANCY) and then carries its tenancy id', async () => {
    const w = await residentSociety();
    await addResident(w.c, { name: 'Owner One', link: owner(w.unit(1).id) });
    const fam = (householdOf: string, name: string) =>
      addResident(
        w.c,
        {
          name,
          link: {
            unitId: w.unit(1).id,
            relation: 'FAMILY',
            familyRelation: 'CHILD',
            householdOf,
            fromDate: '2026-10-01',
          },
        },
        null,
      );
    const none = await fam('TENANT', 'Tenant Child');
    expect([none.status, none.body.code]).toEqual([422, 'NO_LIVE_TENANCY']);
    const ownerHousehold = await fam('OWNER', 'Owner Child');
    expect(ownerHousehold.status).toBe(201);
    const o = await Resident.findOne({ where: { societyId: w.society.id!, name: 'Owner One' } });
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
      unitId: w.unit(1).id,
      tenantResidentId: tenant.id!,
      landlordResidentId: o!.id!,
      status: 'APPROVED',
      agreementStart: '2026-11-01',
      agreementEnd: '2027-09-30',
      source: 'ADMIN',
    } as never);
    const ok = await fam('TENANT', 'Tenant Child');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.links[0].tenancyId).toBe(tn.id);
    expect(
      (await UnitResident.findOne({ where: { societyId: w.society.id!, tenancyId: tn.id! } }))!.relation,
    ).toBe('FAMILY');
  });

  it('BR-09-10 every write locks an active unit: an archived flat is 404 UNIT_NOT_FOUND for links, but the unit panel still reads it', async () => {
    const w = await residentSociety();
    const arch = await w.c('post', `/units/${w.unit(2).id}/archive`, {
      version: w.units[1]!.version,
      reason: 'Merged flats',
    });
    expect(arch.status, JSON.stringify(arch.body)).toBe(200);
    const r = await addResident(w.c, { name: 'Late Owner', link: owner(w.unit(2).id) }, null);
    expect([r.status, r.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    expect((await w.c('get', `/residents/units/${w.unit(2).id}`)).status).toBe(200);
  });
});
