import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Invitation, Resident, Tenancy, UnitResident, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
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

const member = (unitId: number, o: Record<string, unknown> = {}) => ({
  unitId,
  name: 'Kabir Shah',
  relation: 'FAMILY',
  familyRelation: 'CHILD',
  ...o,
});

describe('GET /me/household (8.18)', () => {
  it('shows my flats, my relation, who can manage, and the people of the flat with their mobile numbers', async () => {
    const w = await residentSociety();
    const head = await residentUser(w.society, w.unit(1).id, { name: 'Ravi Shah' });
    const fam = await head.c('post', '/me/household/members', member(w.unit(1).id, { mobile: mobile() }), {
      headers: idem(),
    });
    expect(fam.status, JSON.stringify(fam.body)).toBe(201);
    const r = await head.c('get', '/me/household');
    expect(r.status).toBe(200);
    const u = r.body.data.units[0];
    expect(u).toMatchObject({
      unitId: w.unit(1).id,
      unitLabel: 'A-101',
      myRelation: 'OWNER',
      occupancy: 'OWNER_OCCUPIED',
      canManage: true,
      tenancy: null,
    });
    expect(u.people.map((p: any) => [p.name, p.relation, p.hasLogin])).toEqual([
      ['Ravi Shah', 'OWNER', true],
      ['Kabir Shah', 'FAMILY', false],
    ]);
    expect(u.people[1].mobile).toMatch(/^97\d{8}$/);
    // a family member sees the flat but cannot manage it
    const f = await residentUser(w.society, w.unit(1).id, { relation: 'FAMILY', name: 'Family Login' });
    const fh = await f.c('get', '/me/household');
    expect(fh.body.data.units[0]).toMatchObject({ myRelation: 'FAMILY', canManage: false });
    expect(
      (await f.c('post', '/me/household/members', member(w.unit(1).id), { headers: idem() })).body.code,
    ).toBe('PERMISSION_DENIED');
    // an admin has no resident permissions at all
    expect((await w.c('get', '/me/household')).status).toBe(403);
  });
});

describe('adding, editing and removing household members (8.18)', () => {
  it('creates the resident (source HOUSEHOLD) and a link from today; a minor gets no login; owners cannot add to another flat', async () => {
    const w = await residentSociety({ flats: 2 });
    const head = await residentUser(w.society, w.unit(1).id, { name: 'Ravi Shah' });
    const r = await head.c(
      'post',
      '/me/household/members',
      member(w.unit(1).id, { dateOfBirth: '2018-03-03' }),
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.link).toMatchObject({
      relation: 'FAMILY',
      familyRelation: 'CHILD',
      canLogin: false,
      fromDate: '2026-11-01',
      isResiding: true,
    });
    const row = (await Resident.findByPk(r.body.data.residentId))!;
    expect([row.source, row.name]).toEqual(['HOUSEHOLD', 'Kabir Shah']);
    const care = await head.c(
      'post',
      '/me/household/members',
      { unitId: w.unit(1).id, name: 'Sunita Bai', relation: 'CARETAKER' },
      { headers: idem() },
    );
    expect(care.body.data.link).toMatchObject({ relation: 'CARETAKER', familyRelation: null });
    expect(
      (await head.c('post', '/me/household/members', member(w.unit(2).id), { headers: idem() })).body.code,
    ).toBe('UNIT_NOT_FOUND');
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'residents.link.created' } }),
    ).toBeGreaterThanOrEqual(3);
    for (const bad of [
      { unitId: w.unit(1).id, name: 'No Relation', relation: 'FAMILY' },
      { unitId: w.unit(1).id, name: 'Bad Relation', relation: 'OWNER' },
      { unitId: w.unit(1).id, name: 'Care With Rel', relation: 'CARETAKER', familyRelation: 'CHILD' },
    ])
      expect((await head.c('post', '/me/household/members', bad, { headers: idem() })).status).toBe(400);
  });

  it('a mobile of a person in another flat is 409 RESIDENT_MOBILE_EXISTS (ASK_ADMIN), of the same flat LINK_ALREADY_ACTIVE; a person with no open link is reused', async () => {
    const w = await residentSociety({ flats: 2 });
    const head = await residentUser(w.society, w.unit(1).id, { name: 'Ravi Shah' });
    const m = mobile();
    const elsewhere = await addResident(w.c, {
      name: 'Elsewhere Owner',
      mobile: m,
      link: owner(w.unit(2).id),
    });
    const a = await head.c('post', '/me/household/members', member(w.unit(1).id, { mobile: m }), {
      headers: idem(),
    });
    expect([a.status, a.body.code, a.body.errors[0].hint]).toEqual([
      409,
      'RESIDENT_MOBILE_EXISTS',
      'ASK_ADMIN',
    ]);
    const m2 = mobile();
    await head.c('post', '/me/household/members', member(w.unit(1).id, { mobile: m2 }), { headers: idem() });
    const again = await head.c('post', '/me/household/members', member(w.unit(1).id, { mobile: m2 }), {
      headers: idem(),
    });
    expect([again.status, again.body.code]).toEqual([409, 'LINK_ALREADY_ACTIVE']);
    // end the other person's link: they have no open link and can be reused
    const link = (await UnitResident.findOne({ where: { residentId: elsewhere.id } }))!;
    await w.c('post', `/residents/links/${link.id}/end`, {
      toDate: '2026-10-31',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    const reuse = await head.c(
      'post',
      '/me/household/members',
      member(w.unit(1).id, { mobile: m, name: 'Elsewhere Owner' }),
      { headers: idem() },
    );
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(201);
    expect(reuse.body.data.residentId).toBe(elsewhere.id);
    const inv = await head.c('post', '/me/household/members', member(w.unit(1).id, { invite: true }), {
      headers: idem(),
    });
    expect([inv.status, inv.body.code]).toEqual([422, 'INVITE_NOT_POSSIBLE']);
  });

  it('edits a member without a login; a member with a login manages their own profile (422 MEMBER_HAS_LOGIN) but canLogin and isResiding can change', async () => {
    const w = await residentSociety();
    const head = await residentUser(w.society, w.unit(1).id, { name: 'Ravi Shah' });
    const kid = (await head.c('post', '/me/household/members', member(w.unit(1).id), { headers: idem() }))
      .body.data.link;
    const ok = await head.c('patch', `/me/household/members/${kid.linkId}`, {
      name: 'Kabir R Shah',
      familyRelation: 'SIBLING',
      isResiding: false,
      version: kid.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ familyRelation: 'SIBLING', isResiding: false });
    expect(await Resident.findOne({ where: { name: 'Kabir R Shah' } })).not.toBeNull();
    const stale = await head.c('patch', `/me/household/members/${kid.linkId}`, {
      canLogin: false,
      version: kid.version,
    });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const adult = await residentUser(w.society, w.unit(1).id, { relation: 'FAMILY', name: 'Adult Login' });
    const lock = await head.c('patch', `/me/household/members/${adult.link.id}`, {
      name: 'Renamed Person',
      version: adult.link.version,
    });
    expect([lock.status, lock.body.code]).toEqual([422, 'MEMBER_HAS_LOGIN']);
    const allowed = await head.c('patch', `/me/household/members/${adult.link.id}`, {
      canLogin: false,
      version: adult.link.version,
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it('removing ends the link today with REMOVED; owners cannot remove an owner, and the owner does not manage the tenant household', async () => {
    const w = await residentSociety();
    const head = await residentUser(w.society, w.unit(1).id, { name: 'Ravi Shah' });
    const kid = (await head.c('post', '/me/household/members', member(w.unit(1).id), { headers: idem() }))
      .body.data.link;
    const co = await addResident(w.c, {
      name: 'Co Owner',
      link: { unitId: w.unit(1).id, relation: 'CO_OWNER', fromDate: '2024-01-01' },
    });
    const blocked = await head.c('delete', `/me/household/members/${co.links[0].linkId}`, {});
    expect([blocked.status, blocked.body.code]).toEqual([403, 'HOUSEHOLD_CONTROL_REQUIRED']);
    const mine = await head.c('delete', `/me/household/members/${head.link.id}`, {});
    expect([mine.status, mine.body.code]).toEqual([403, 'HOUSEHOLD_CONTROL_REQUIRED']);
    const done = await head.c('delete', `/me/household/members/${kid.linkId}`, {
      reason: 'Moved to a hostel',
    });
    expect(done.status).toBe(204);
    const row = (await UnitResident.findByPk(kid.linkId))!;
    expect([row.toDate, row.endReason, row.endNote]).toEqual(['2026-11-01', 'REMOVED', 'Moved to a hostel']);
    expect((await head.c('delete', `/me/household/members/${kid.linkId}`, {})).body.code).toBe(
      'INVALID_STATE',
    );
    // a tenant household link belongs to the tenant
    const tn = await Tenancy.create({
      societyId: w.society.id!,
      unitId: w.unit(1).id,
      tenantResidentId: co.id,
      landlordResidentId: head.resident.id!,
      status: 'ACTIVE',
      agreementStart: '2026-10-01',
      agreementEnd: '2027-09-30',
      source: 'ADMIN',
    } as never);
    const tf = await residentUser(w.society, w.unit(1).id, {
      relation: 'FAMILY',
      name: 'Tenant Family',
      householdOf: 'TENANT',
      tenancyId: tn.id!,
    });
    const x = await head.c('delete', `/me/household/members/${tf.link.id}`, {});
    expect([x.status, x.body.code]).toEqual([403, 'HOUSEHOLD_CONTROL_REQUIRED']);
  });

  it('a neighbour gets 404 LINK_NOT_FOUND for the link of another flat on every member route', async () => {
    const w = await residentSociety({ flats: 2 });
    const a = await residentUser(w.society, w.unit(1).id, { name: 'Owner A' });
    const b = await residentUser(w.society, w.unit(2).id, { name: 'Owner B' });
    const kid = (await a.c('post', '/me/household/members', member(w.unit(1).id), { headers: idem() })).body
      .data.link;
    const id = kid.linkId;
    for (const [m, p, body] of [
      ['patch', `/me/household/members/${id}`, { canLogin: false, version: 1 }],
      ['delete', `/me/household/members/${id}`, {}],
      ['post', `/me/household/members/${id}/invite`, {}],
      ['put', `/me/household/members/${id}/emergency-profile`, { bloodGroup: 'A_POS', consent: true }],
    ] as const) {
      const r = await b.c(m, p, body, { headers: idem() });
      expect([r.status, r.body.code], `${m} ${p}`).toEqual([404, 'LINK_NOT_FOUND']);
    }
    expect((await UnitResident.findByPk(id))!.toDate).toBeNull();
  });

  it('invites a member with a mobile through module 03 (BR-09-20); a member without a mobile is INVITE_NOT_POSSIBLE', async () => {
    const w = await residentSociety();
    const head = await residentUser(w.society, w.unit(1).id, { name: 'Ravi Shah' });
    const withPhone = (
      await head.c(
        'post',
        '/me/household/members',
        member(w.unit(1).id, { mobile: mobile(), name: 'Adult Child', canLogin: true }),
        { headers: idem() },
      )
    ).body.data;
    const r = await head.c(
      'post',
      `/me/household/members/${withPhone.link.linkId}/invite`,
      {},
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.mode).toBe('INVITED');
    expect((await Invitation.findOne({ where: { residentId: withPhone.residentId } }))!.status).toBe(
      'PENDING',
    );
    const noPhone = (
      await head.c('post', '/me/household/members', member(w.unit(1).id, { name: 'No Phone Child' }), {
        headers: idem(),
      })
    ).body.data;
    const bad = await head.c(
      'post',
      `/me/household/members/${noPhone.link.linkId}/invite`,
      {},
      { headers: idem() },
    );
    expect(bad.body.code).toBe('INVITE_NOT_POSSIBLE');
  });
});
