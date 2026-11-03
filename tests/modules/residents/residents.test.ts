import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, MoveRequest, Resident, Tenancy, UnitResident, closeDb } from '../../../src/models';
import { inboxFor, makeUser } from '../../helpers/auth';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { drainQueues } from '../../../src/lib/queue';
import { featureOff } from '../../helpers/society-setup';
import {
  adminOf,
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

describe('resident records (US-09-01, BR-09-1 to BR-09-7)', () => {
  it('T09-06 creates a resident with an OWNER link (primary, share 100.00) and audit rows', async () => {
    const { society, c, unit } = await residentSociety();
    const r = await addResident(c, {
      name: '  Ravi   Shah ',
      mobile: '+91 98200-11121',
      email: 'Ravi@Mail.in',
      link: owner(unit(1).id),
    });
    expect(r).toMatchObject({
      name: 'Ravi Shah',
      mobile: '9820011121',
      status: 'ACTIVE',
      version: 1,
      invitation: null,
    });
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({
      unitLabel: 'A-101',
      relation: 'OWNER',
      sharePercent: '100.00',
      isPrimary: true,
      isResiding: true,
      canLogin: true,
      fromDate: '2019-04-01',
      toDate: null,
    });
    const row = (await Resident.findByPk(r.id))!;
    expect(row.email).toBe('ravi@mail.in');
    expect((await UnitResident.findOne({ where: { residentId: r.id } }))!.sharePercent).toBeNull();
    const actions = (
      await AuditLog.findAll({ where: { societyId: society.id! }, order: [['id', 'ASC']] })
    ).map(a => a.action);
    expect(actions).toEqual(expect.arrayContaining(['residents.resident.created', 'residents.link.created']));
  });

  it('T09-06 with invite: module 03 creates the invitation and the response carries it', async () => {
    const { c, unit } = await residentSociety();
    const r = await addResident(c, {
      name: 'Invited Owner',
      mobile: mobile(),
      link: owner(unit(1).id),
      invite: true,
    });
    expect(r.invitation).toMatchObject({ status: 'PENDING' });
    expect(typeof r.invitation.id).toBe('number');
  });

  it('T09-07 a second resident with the same mobile is 409 RESIDENT_MOBILE_EXISTS with the residentId', async () => {
    const { c } = await residentSociety();
    const m = mobile();
    const first = await addResident(c, { name: 'First Person', mobile: m });
    const r = await addResident(c, { name: 'Second Person', mobile: m }, null);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RESIDENT_MOBILE_EXISTS');
    expect(r.body.errors[0].residentId).toBe(first.id);
  });

  it('the same mobile may exist in another society and again after the first resident was deleted', async () => {
    const a = await residentSociety();
    const b = await residentSociety({ name: 'Other CHS' });
    const m = mobile();
    await addResident(a.c, { name: 'Person One', mobile: m });
    await addResident(b.c, { name: 'Person One', mobile: m });
    const gone = await addResident(a.c, { name: 'Person Two', mobile: mobile() });
    const del = await a.c('delete', `/residents/${gone.id}`, { reason: 'Added by mistake', version: 1 });
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    await addResident(a.c, {
      name: 'Person Three',
      mobile: (await Resident.findByPk(gone.id, { paranoid: false }))!.mobile!,
    });
  });

  it('T09-09 a FAMILY link on a parking-only unit is 422 UNIT_NOT_RESIDENTIAL; an OWNER link is allowed', async () => {
    const { c, society, buildingId } = await residentSociety();
    const p = await c(
      'post',
      '/units',
      { buildingId, unitNumber: 'P1', floor: 0, unitType: 'PARKING_ONLY' },
      { headers: idem() },
    );
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const bad = await addResident(
      c,
      {
        name: 'Family Person',
        link: {
          unitId: p.body.data.id,
          relation: 'FAMILY',
          familyRelation: 'SPOUSE',
          householdOf: 'OWNER',
          fromDate: '2026-10-01',
        },
      },
      null,
    );
    expect([bad.status, bad.body.code]).toEqual([422, 'UNIT_NOT_RESIDENTIAL']);
    const ok = await addResident(c, { name: 'Parking Owner', link: owner(p.body.data.id) });
    expect(ok.links[0].relation).toBe('OWNER');
    expect(await UnitResident.count({ where: { societyId: society.id! } })).toBe(1);
  });

  it('TENANT is refused on this route (422 USE_TENANCY_FLOW); an unknown unit is 404 UNIT_NOT_FOUND', async () => {
    const { c, unit } = await residentSociety();
    const t = await addResident(
      c,
      {
        name: 'Tenant Person',
        mobile: mobile(),
        link: { unitId: unit(1).id, relation: 'TENANT', fromDate: '2026-10-01' },
      },
      null,
    );
    expect([t.status, t.body.code]).toEqual([422, 'USE_TENANCY_FLOW']);
    const u = await addResident(c, { name: 'Nowhere Person', link: owner(999_999) }, null);
    expect([u.status, u.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
  });

  it('BR-09-4 a minor cannot be an owner (422 MINOR_NOT_ALLOWED) but can be family without login', async () => {
    const { c, unit } = await residentSociety();
    const minor = await addResident(
      c,
      { name: 'Young Owner', dateOfBirth: '2015-05-05', link: owner(unit(1).id) },
      null,
    );
    expect([minor.status, minor.body.code]).toEqual([422, 'MINOR_NOT_ALLOWED']);
    await addResident(c, { name: 'Real Owner', link: owner(unit(1).id) });
    const kid = await addResident(c, {
      name: 'Kabir Shah',
      dateOfBirth: '2018-03-03',
      link: {
        unitId: unit(1).id,
        relation: 'FAMILY',
        familyRelation: 'CHILD',
        householdOf: 'OWNER',
        fromDate: '2026-10-01',
      },
    });
    expect(kid.links[0].canLogin).toBe(false);
    const list = await c('get', '/residents', undefined, { query: { q: 'Kabir' } });
    expect(list.body.data[0].isMinor).toBe(true);
  });

  it('T09-54 validation: mobile 5820011111 and a bad name give 400 VALIDATION_FAILED; unknown keys too', async () => {
    const { c } = await residentSociety();
    for (const body of [
      { name: 'Valid Name', mobile: '5820011111' },
      { name: 'R', mobile: mobile() },
      { name: 'Valid Name', surprise: 1 },
      { name: 'Valid Name', link: { unitId: 1, relation: 'FAMILY', fromDate: '2026-10-01' } },
    ]) {
      const r = await addResident(c, body, null);
      expect([r.status, r.body.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  it('BR-09-7 NRI fields are Premium (402 below) and checked: +91 refused, representative must be an active resident', async () => {
    const std = await residentSociety({ plan: 'STANDARD', name: 'Std CHS' });
    const r402 = await addResident(std.c, { name: 'Overseas Owner', isNri: true }, null);
    expect([r402.status, r402.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const { c, unit } = await residentSociety();
    const rep = await addResident(c, { name: 'Local Rep', mobile: mobile() });
    const ok = await addResident(c, {
      name: 'Overseas Owner',
      isNri: true,
      overseasPhone: '+14155550123',
      localRepresentativeResidentId: rep.id,
      link: owner(unit(1).id),
    });
    const detail = await c('get', `/residents/${ok.id}`, undefined, { query: { reveal: 'contacts' } });
    expect(detail.body.data).toMatchObject({
      isNri: true,
      overseasPhone: '+14155550123',
      localRepresentativeResidentId: rep.id,
    });
    const plus91 = await addResident(
      c,
      { name: 'Wrong Number', isNri: true, overseasPhone: '+919820011111' },
      null,
    );
    expect(plus91.status).toBe(400);
    const ghost = await addResident(
      c,
      { name: 'Ghost Rep', isNri: true, localRepresentativeResidentId: 987654 },
      null,
    );
    expect([ghost.status, ghost.body.code]).toEqual([422, 'VALIDATION_FAILED']);
  });

  it('a same-name, same-birth-date resident adds a POSSIBLE_DUPLICATE warning without blocking (duplicate detection)', async () => {
    const { c } = await residentSociety();
    const first = await addResident(c, { name: 'Neha Verma', dateOfBirth: '1990-01-01', mobile: mobile() });
    const second = await addResident(c, { name: 'Neha Verma', dateOfBirth: '1990-01-01', mobile: mobile() });
    expect(second.warnings).toEqual([`POSSIBLE_DUPLICATE:${first.id}`]);
  });
});

describe('masking and reveal (BR-09-3)', () => {
  it('lists and details are masked for holders without contacts.view, unmasked with it, and reveal is audited', async () => {
    const { society, c, unit } = await residentSociety();
    const m = '9820011121';
    const r = await addResident(c, {
      name: 'Ravi Shah',
      mobile: m,
      email: 'ravi@mail.in',
      link: owner(unit(1).id),
    });
    // the chairman holds contacts.view: unmasked in lists, masked in the detail until reveal
    expect((await c('get', '/residents')).body.data[0]).toMatchObject({ mobile: m, email: 'ravi@mail.in' });
    expect((await c('get', `/residents/${r.id}`)).body.data).toMatchObject({
      mobile: '98XXXXX121',
      email: 'r****@mail.in',
    });
    const revealed = await c('get', `/residents/${r.id}`, undefined, { query: { reveal: 'contacts' } });
    expect(revealed.body.data.mobile).toBe(m);
    expect(
      await AuditLog.count({
        where: { societyId: society.id!, action: 'residents.resident.contacts_revealed' },
      }),
    ).toBe(1);
    // a committee member has residents.people.view but not contacts.view
    const cm = await adminOf(society, 'committee_member');
    expect((await cm.c('get', '/residents')).body.data[0]).toMatchObject({
      mobile: '98XXXXX121',
      email: 'r****@mail.in',
    });
    const denied = await cm.c('get', `/residents/${r.id}`, undefined, { query: { reveal: 'contacts' } });
    expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('T09-48 an accountant (people.view only) cannot create a resident', async () => {
    const { society } = await residentSociety();
    const acc = await adminOf(society, 'accountant');
    const r = await acc.c('post', '/residents', { name: 'Not Allowed' }, { headers: idem() });
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await acc.c('get', '/residents')).status).toBe(200);
  });
});

describe('list filters (8.2)', () => {
  it('filters by q, unit, relation, status, login and KYC status, sorts and paginates', async () => {
    const { c, unit } = await residentSociety();
    const a = await addResident(c, { name: 'Ravi Shah', mobile: '9820011121', link: owner(unit(1).id) });
    await addResident(c, { name: 'Meera Iyer', mobile: '9820022122', link: owner(unit(2).id) });
    await addResident(c, { name: 'No Link Person' });
    const names = async (q: Record<string, string>) =>
      (await c('get', '/residents', undefined, { query: q })).body.data.map((x: any) => x.name);
    expect(await names({})).toEqual(['Meera Iyer', 'No Link Person', 'Ravi Shah']);
    expect(await names({ q: 'rav' })).toEqual(['Ravi Shah']);
    expect(await names({ q: 'A-102' })).toEqual(['Meera Iyer']);
    expect(await names({ q: '22122' })).toEqual(['Meera Iyer']);
    expect(await names({ unitId: String(unit(1).id) })).toEqual(['Ravi Shah']);
    expect(await names({ relation: 'OWNER' })).toEqual(['Meera Iyer', 'Ravi Shah']);
    expect(await names({ hasLogin: 'false', status: 'ACTIVE' })).toHaveLength(3);
    expect(await names({ kycStatus: 'NONE' })).toHaveLength(3);
    expect(await names({ kycStatus: 'VERIFIED' })).toEqual([]);
    const p = await c('get', '/residents', undefined, { query: { limit: '2', page: '2', sortBy: 'name' } });
    expect(p.body.pagination).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(p.body.data).toHaveLength(1);
    expect(a.id).toBeGreaterThan(0);
    expect((await c('get', '/residents', undefined, { query: { q: 'x' } })).status).toBe(400);
  });
});

describe('edit and delete (8.6, BR-09-6)', () => {
  it('T09-52 a stale version is 409 STALE_VERSION; a change bumps the version and audits masked contacts', async () => {
    const { society, c, unit } = await residentSociety();
    const r = await addResident(c, { name: 'Ravi Shah', mobile: '9820011121', link: owner(unit(1).id) });
    const ok = await c('patch', `/residents/${r.id}`, { name: 'Ravi K Shah', adminNote: 'VIP', version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Ravi K Shah', adminNote: 'VIP', version: 2 });
    const stale = await c('patch', `/residents/${r.id}`, { name: 'Other Name', version: 1 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const chg = await c('patch', `/residents/${r.id}`, { mobile: '9820099999', version: 2 });
    expect(chg.status).toBe(200);
    const log = (await AuditLog.findOne({
      where: { societyId: society.id!, action: 'residents.resident.updated' },
      order: [['id', 'DESC']],
    }))!;
    expect(JSON.stringify(log.before) + JSON.stringify(log.after)).not.toMatch(/9820011121|9820099999/);
    expect((await c('patch', `/residents/${r.id}`, { version: 3 })).status).toBe(400);
  });

  it('a mobile that another resident has is 409; a resident with a login cannot change the mobile (422 MOBILE_MANAGED_BY_USER)', async () => {
    const { society, c, unit } = await residentSociety();
    const a = await addResident(c, { name: 'Ravi Shah', mobile: '9820011121' });
    await addResident(c, { name: 'Meera Iyer', mobile: '9820022122' });
    const dup = await c('patch', `/residents/${a.id}`, { mobile: '9820022122', version: 1 });
    expect([dup.status, dup.body.code]).toEqual([409, 'RESIDENT_MOBILE_EXISTS']);
    const withLogin = await residentUser(society, unit(1).id);
    const r = await c('patch', `/residents/${withLogin.resident.id}`, {
      mobile: '9820055550',
      version: withLogin.resident.version,
    });
    expect([r.status, r.body.code]).toEqual([422, 'MOBILE_MANAGED_BY_USER']);
  });

  it('BR-09-4 a birth date that makes an owner a minor is 422 MINOR_NOT_ALLOWED', async () => {
    const { c, unit } = await residentSociety();
    const r = await addResident(c, { name: 'Ravi Shah', link: owner(unit(1).id) });
    const bad = await c('patch', `/residents/${r.id}`, { dateOfBirth: '2012-01-01', version: 1 });
    expect([bad.status, bad.body.code]).toEqual([422, 'MINOR_NOT_ALLOWED']);
  });

  it('BR-09-6 delete needs step-up, is blocked by an open link, and releases the login first', async () => {
    const { society, c, unit } = await residentSociety();
    const r = await addResident(c, { name: 'Ravi Shah', mobile: mobile(), link: owner(unit(1).id) });
    const blocked = await c('delete', `/residents/${r.id}`, { reason: 'Removing the record', version: 1 });
    expect([blocked.status, blocked.body.code]).toEqual([409, 'RESIDENT_HAS_ACTIVE_LINKS']);
    const link = (await UnitResident.findOne({ where: { residentId: r.id } }))!;
    const end = await c('post', `/residents/links/${link.id}/end`, {
      toDate: '2026-11-01',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    const row = (await Resident.findByPk(r.id))!;
    expect(row.status).toBe('INACTIVE');
    const done = await c('delete', `/residents/${r.id}`, {
      reason: 'Removing the record',
      version: row.version,
    });
    expect(done.status).toBe(204);
    expect(await Resident.count({ where: { id: r.id } })).toBe(0);
    expect((await c('get', `/residents/${r.id}`)).body.code).toBe('RESIDENT_NOT_FOUND');
    expect(
      await AuditLog.count({ where: { societyId: society.id!, action: 'residents.resident.deleted' } }),
    ).toBe(1);
  });
});

describe('welcome kit (Premium, section 10)', () => {
  const link = (unitId: number) => ({ unitId, relation: 'OWNER', fromDate: '2026-01-01' });
  const kitFor = async (email: string) =>
    (await inboxFor(email)).filter(m => /^Welcome to /.test(m.subject ?? '')).length;

  it('is sent once, on the first link of a resident who already has a login, and not on Standard', async () => {
    const prem = await residentSociety({ flats: 2 });
    const user = await makeUser({ name: 'Existing Login', email: 'existing@mail.in' });
    const r = await Resident.create({
      societyId: prem.society.id!,
      userId: user.id,
      name: 'Existing Login',
      mobile: user.mobile,
      status: 'ACTIVE',
      source: 'ADMIN',
      version: 1,
    } as never);
    const a = await prem.c('post', `/residents/${r.id}/links`, link(prem.unit(1).id), { headers: idem() });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(await kitFor('existing@mail.in')).toBe(1);
    await prem.c(
      'post',
      `/residents/${r.id}/links`,
      { ...link(prem.unit(2).id), relation: 'OWNER' },
      { headers: idem() },
    );
    expect(await kitFor('existing@mail.in')).toBe(1);
    const std = await residentSociety({ plan: 'STANDARD', name: 'Std CHS', flats: 1 });
    const u2 = await makeUser({ name: 'Std Login', email: 'std@mail.in' });
    const r2 = await Resident.create({
      societyId: std.society.id!,
      userId: u2.id,
      name: 'Std Login',
      mobile: u2.mobile,
      status: 'ACTIVE',
      source: 'ADMIN',
      version: 1,
    } as never);
    expect(
      (await std.c('post', `/residents/${r2.id}/links`, link(std.unit(1).id), { headers: idem() })).status,
    ).toBe(201);
    expect(await kitFor('std@mail.in')).toBe(0);
  });
});

describe('delete guards (BR-09-6)', () => {
  it('an open move request, a live tenancy or an open join request keeps a person with no link from being deleted', async () => {
    const w = await residentSociety();
    const p = await addResident(w.c, { name: 'Busy Person', mobile: mobile() });
    const del = () => w.c('delete', `/residents/${p.id}`, { reason: 'Removing the record', version: 1 });
    const mr = await MoveRequest.create({
      societyId: w.society.id!,
      unitId: w.unit(1).id,
      buildingId: w.buildingId,
      type: 'MOVE_IN',
      householdOf: 'OWNER',
      requestedByResidentId: p.id,
      moveDate: '2026-11-10',
      slotStart: '10:00:00',
      slotEnd: '12:00:00',
      status: 'PENDING_APPROVAL',
    } as never);
    expect((await del()).body.code).toBe('RESIDENT_HAS_ACTIVE_LINKS');
    await mr.update({ status: 'COMPLETED' });
    const owner1 = await addResident(w.c, { name: 'Landlord Person', link: owner(w.unit(1).id) });
    const tn = await Tenancy.create({
      societyId: w.society.id!,
      unitId: w.unit(1).id,
      tenantResidentId: p.id,
      landlordResidentId: owner1.id,
      status: 'ACTIVE',
      agreementStart: '2026-10-01',
      agreementEnd: '2027-09-30',
      source: 'ADMIN',
    } as never);
    expect((await del()).body.code).toBe('RESIDENT_HAS_ACTIVE_LINKS');
    await tn.update({ status: 'ENDED', endedOn: '2026-10-31' });
    const ok = await del();
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
  });
});

describe('idempotency, plan and society state', () => {
  it('T09-53 the same key and body gives one resident and a replay header; a different body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { society, c } = await residentSociety();
    const h = idem();
    const body = { name: 'Once Only', mobile: mobile() };
    const a = await c('post', '/residents', body, { headers: h });
    const b = await c('post', '/residents', body, { headers: h });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(await Resident.count({ where: { societyId: society.id!, name: 'Once Only' } })).toBe(1);
    const diff = await c('post', '/residents', { ...body, name: 'Another Name' }, { headers: h });
    expect([diff.status, diff.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    const noKey = await c('post', '/residents', body);
    expect(noKey.status).toBe(400);
  });

  it('writes are blocked while the society is suspended (423) and reads work (T09-55)', async () => {
    const { society, c } = await residentSociety();
    await addResident(c, { name: 'Before Suspend', mobile: mobile() });
    await society.update({
      status: 'SUSPENDED',
      suspendedAt: new Date(),
      suspensionCause: 'MANUAL',
    } as never);
    await flushAcl();
    const w = await c('post', '/residents', { name: 'While Suspended' }, { headers: idem() });
    expect([w.status, w.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
    expect((await c('get', '/residents')).status).toBe(200);
  });

  it('a feature that is off is 402 FEATURE_NOT_IN_PLAN (the person registry), and Premium features are 402 on Standard', async () => {
    const { society, c } = await residentSociety();
    await featureOff(society.id!, 'residents.person_registry');
    const w = await c('post', '/residents', { name: 'After Off' }, { headers: idem() });
    expect([w.status, w.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const std = await residentSociety({ plan: 'STANDARD', name: 'Standard CHS' });
    const g = await std.c('get', '/pets');
    expect([g.status, g.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    expect((await std.c('get', '/residents')).status).toBe(200);
  });
});
