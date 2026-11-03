import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  EmergencyProfile,
  Pet,
  Resident,
  Tenancy,
  UnitResident,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { runPetReminders } from '../../../src/modules/residents/residents.pets.service';
import { setResidentPorts } from '../../../src/modules/residents/residents.ports';
import { settings } from '../../../src/modules/society-setup/society-setup.public';
import { systemCtx } from '../../../src/types/context';
import { memberOf } from '../../helpers/society-setup';
import { idem, mobile, residentSociety, residentUser, resetResidents } from '../../helpers/residents';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetResidents);

const setSetting = (societyId: number, key: string, value: unknown) =>
  sequelize.transaction(t => settings.setMany(systemCtx('t'), societyId, [{ key, value }], t));

describe('directory and privacy (BR-09-73, US-09-11, T09-38, T09-50)', () => {
  it('T09-38 lists active adult residents with an active link; contacts only when the person chose to show them; tenants can be hidden', async () => {
    const w = await residentSociety({ flats: 3 });
    const priya = await residentUser(w.society, w.unit(1).id, { name: 'Priya Nair' });
    const rahul = await residentUser(w.society, w.unit(2).id, { name: 'Rahul Mehta' });
    const asker = await residentUser(w.society, w.unit(3).id, { name: 'Asha Kulkarni' });
    await Resident.update({ email: 'priya@mail.in' }, { where: { id: priya.resident.id } });
    const list = async (q: Record<string, string> = {}) =>
      (await asker.c('get', '/me/directory', undefined, { query: q })).body;
    let r = await list();
    expect(r.data.map((x: any) => [x.name, x.unitLabel, x.relation])).toEqual([
      ['Priya Nair', 'A-101', 'OWNER'],
      ['Rahul Mehta', 'A-102', 'OWNER'],
      ['Asha Kulkarni', 'A-103', 'OWNER'],
    ]);
    expect(r.data.every((x: any) => x.mobile === undefined && x.email === undefined)).toBe(true);
    // Priya shows her mobile; Rahul hides himself
    const ver = async (who: typeof priya) => (await who.c('get', '/me/privacy')).body.data.version as number;
    const p = await priya.c('patch', '/me/privacy', {
      showMobileInDirectory: true,
      version: await ver(priya),
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data).toMatchObject({ showMobileInDirectory: true, directoryVisible: true });
    const h = await rahul.c('patch', '/me/privacy', { directoryVisible: false, version: await ver(rahul) });
    expect(h.status).toBe(200);
    r = await list();
    expect(r.data.map((x: any) => x.name)).toEqual(['Priya Nair', 'Asha Kulkarni']);
    expect(r.data[0]).toMatchObject({ mobile: priya.resident.mobile });
    expect(r.data[0].email).toBeUndefined();
    expect(r.pagination.total).toBe(2);
    expect((await list({ q: 'asha' })).data).toHaveLength(1);
    expect((await list({ sortBy: 'name' })).data[0].name).toBe('Asha Kulkarni');
    const stale = await priya.c('patch', '/me/privacy', { showMobileInDirectory: false, version: 1 });
    expect(await ver(priya)).toBeGreaterThan(1);
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    expect((await priya.c('get', '/me/privacy')).body.data.showMobileInDirectory).toBe(true);
    expect(await AuditLog.count({ where: { action: 'residents.privacy.updated' } })).toBe(2);
  });

  it('minors are never listed, tenants vanish when the society hides them, and the directory can be turned off (403 DIRECTORY_DISABLED)', async () => {
    const w = await residentSociety({ flats: 3 });
    const a = await residentUser(w.society, w.unit(1).id, { name: 'Adult Owner' });
    await residentUser(w.society, w.unit(1).id, {
      relation: 'FAMILY',
      name: 'Child Login',
      dateOfBirth: '2015-04-04',
    });
    const names = async () => (await a.c('get', '/me/directory')).body.data.map((x: any) => x.name);
    expect(await names()).toEqual(['Adult Owner']);
    // a tenant row through the unit link (relation TENANT needs a tenancy; the directory only reads links)
    const t = await Resident.create({
      societyId: w.society.id!,
      name: 'Tenant Person',
      mobile: mobile(),
      status: 'ACTIVE',
      source: 'TENANCY',
      version: 1,
    } as never);
    const tn = await Tenancy.create({
      societyId: w.society.id!,
      unitId: w.unit(2).id,
      tenantResidentId: t.id!,
      landlordResidentId: a.resident.id!,
      status: 'ACTIVE',
      agreementStart: '2026-10-01',
      agreementEnd: '2027-09-30',
      source: 'ADMIN',
    } as never);
    await UnitResident.create({
      societyId: w.society.id!,
      unitId: w.unit(2).id,
      residentId: t.id!,
      relation: 'TENANT',
      tenancyId: tn.id!,
      fromDate: '2026-10-01',
      source: 'TENANCY',
    } as never);
    expect(await names()).toEqual(['Adult Owner', 'Tenant Person']);
    await setSetting(w.society.id!, 'residents.directoryShowTenants', false);
    expect(await names()).toEqual(['Adult Owner']);
    await setSetting(w.society.id!, 'residents.directoryEnabled', false);
    const off = await a.c('get', '/me/directory');
    expect([off.status, off.body.code]).toEqual([403, 'DIRECTORY_DISABLED']);
    // privacy fields stay editable
    const v = (await a.c('get', '/me/privacy')).body.data.version;
    expect((await a.c('patch', '/me/privacy', { showPhotoInDirectory: true, version: v })).status).toBe(200);
  });

  it('T09-50 a Starter society gets 402 FEATURE_NOT_IN_PLAN on the directory and on pets', async () => {
    const w = await residentSociety({ plan: 'STARTER', name: 'Starter CHS' });
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Starter Owner' });
    for (const [m, p, b] of [
      ['get', '/me/directory', undefined],
      ['get', '/me/pets', undefined],
      ['post', '/me/pets', { unitId: w.unit(1).id, name: 'Rex', species: 'CAT' }],
      ['get', '/me/emergency-profile', undefined],
    ] as const) {
      const r = await me.c(m, p, b, { headers: idem() });
      expect([r.status, r.body.code], p).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    }
    expect((await me.c('get', '/me/privacy')).status).toBe(200);
    expect((await me.c('get', '/me/household')).status).toBe(200);
  });
});

describe('pets (BR-09-69, US-09-12)', () => {
  it('registers a pet; a dog needs a valid vaccination when the society requires it (422 PET_VACCINATION_REQUIRED)', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Dog Owner' });
    const post = (b: Record<string, unknown>) =>
      me.c('post', '/me/pets', { unitId: w.unit(1).id, ...b }, { headers: idem() });
    const noVacc = await post({ name: 'Bruno', species: 'DOG' });
    expect([noVacc.status, noVacc.body.code]).toEqual([422, 'PET_VACCINATION_REQUIRED']);
    const expired = await post({ name: 'Bruno', species: 'DOG', vaccinationValidUntil: '2026-10-01' });
    expect(expired.body.code).toBe('PET_VACCINATION_REQUIRED');
    const ok = await post({
      name: 'Bruno',
      species: 'DOG',
      lastVaccineName: 'Anti-rabies',
      lastVaccinatedOn: '2026-01-10',
      vaccinationValidUntil: '2027-01-10',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data).toMatchObject({ name: 'Bruno', species: 'DOG', status: 'ACTIVE', version: 1 });
    expect((await post({ name: 'Mishti', species: 'CAT' })).status).toBe(201);
    await setSetting(w.society.id!, 'residents.dogVaccinationRequired', false);
    expect((await post({ name: 'Tommy', species: 'DOG' })).status).toBe(201);
    const bad = await post({
      name: 'Old',
      species: 'CAT',
      lastVaccinatedOn: '2026-05-01',
      vaccinationValidUntil: '2026-04-01',
    });
    expect(bad.status).toBe(422);
    const mine = await me.c('get', '/me/pets');
    expect(mine.body.data.map((p: any) => p.name)).toEqual(['Bruno', 'Mishti', 'Tommy']);
    // a flat of someone else is a 404
    const other = await residentUser(w.society, w.unit(2).id, { name: 'Other Owner' });
    const x = await other.c(
      'post',
      '/me/pets',
      { unitId: w.unit(1).id, name: 'Rex', species: 'CAT' },
      { headers: idem() },
    );
    expect([x.status, x.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
  });

  it('edits with a version, deactivates with a reason, deletes softly; another flat sees 404 PET_NOT_FOUND', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Pet Owner' });
    const other = await residentUser(w.society, w.unit(2).id, { name: 'Other Owner' });
    const p = (
      await me.c(
        'post',
        '/me/pets',
        { unitId: w.unit(1).id, name: 'Mishti', species: 'CAT' },
        { headers: idem() },
      )
    ).body.data;
    expect((await other.c('patch', `/me/pets/${p.id}`, { name: 'Stolen', version: 1 })).body.code).toBe(
      'PET_NOT_FOUND',
    );
    expect((await other.c('delete', `/me/pets/${p.id}`)).body.code).toBe('PET_NOT_FOUND');
    const e = await me.c('patch', `/me/pets/${p.id}`, { colour: 'White', licenceNo: 'MC-221', version: 1 });
    expect(e.body.data).toMatchObject({ colour: 'White', licenceNo: 'MC-221', version: 2 });
    expect((await me.c('patch', `/me/pets/${p.id}`, { colour: 'Black', version: 1 })).body.code).toBe(
      'STALE_VERSION',
    );
    expect((await me.c('patch', `/me/pets/${p.id}`, { status: 'INACTIVE', version: 2 })).status).toBe(422);
    const off = await me.c('patch', `/me/pets/${p.id}`, {
      status: 'INACTIVE',
      inactiveReason: 'REHOMED',
      version: 2,
    });
    expect(off.body.data).toMatchObject({ status: 'INACTIVE', inactiveReason: 'REHOMED' });
    expect((await me.c('delete', `/me/pets/${p.id}`)).status).toBe(204);
    expect(await Pet.count({ where: { id: p.id } })).toBe(0);
    expect(await Pet.count({ where: { id: p.id }, paranoid: false })).toBe(1);
  });

  it('the admin register filters by vaccination state and flat; ending the owner links sets the pet INACTIVE', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Pet Owner' });
    const mk = (n: string, until: string | null) =>
      me.c(
        'post',
        '/me/pets',
        { unitId: w.unit(1).id, name: n, species: 'CAT', ...(until ? { vaccinationValidUntil: until } : {}) },
        { headers: idem() },
      );
    await mk('Expired', '2026-10-01');
    await mk('Soon', '2026-11-20');
    await mk('Fine', '2027-06-01');
    await mk('None', null);
    const names = async (q: Record<string, string>) =>
      (await w.c('get', '/pets', undefined, { query: q })).body.data.map((x: any) => x.name);
    expect(await names({ vaccination: 'EXPIRED' })).toEqual(['Expired']);
    expect(await names({ vaccination: 'EXPIRING_30' })).toEqual(['Soon']);
    expect(await names({ vaccination: 'VALID' })).toEqual(['Fine']);
    expect(await names({ vaccination: 'NONE' })).toEqual(['None']);
    expect(await names({ unitId: String(w.unit(2).id) })).toEqual([]);
    const row = (await w.c('get', '/pets')).body.data[0];
    expect(row).toMatchObject({ unitLabel: 'A-101', ownerName: 'Pet Owner' });
    const end = await w.c('post', `/residents/links/${me.link.id}/end`, {
      toDate: '2026-10-31',
      endReason: 'MOVED_OUT',
      version: 1,
    });
    expect(end.status).toBe(200);
    expect(await names({ status: 'INACTIVE' })).toHaveLength(4);
    const stats = (await w.c('get', '/residents/stats')).body.data;
    expect(stats.petsVaccinationExpired).toBe(0);
  });

  it('the reminder job notifies the owner once per expiry date, 30 days before (US-09-12)', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Pet Owner' });
    await me.c(
      'post',
      '/me/pets',
      { unitId: w.unit(1).id, name: 'Bruno', species: 'DOG', vaccinationValidUntil: '2027-01-10' },
      { headers: idem() },
    );
    setNow('2026-12-10T04:30:00Z');
    expect(await runPetReminders(w.society.id!)).toBe(0);
    setNow('2026-12-11T04:30:00Z');
    expect(await runPetReminders(w.society.id!)).toBe(1);
    expect(await runPetReminders(w.society.id!)).toBe(0);
    const pet = (await Pet.findOne({ where: { societyId: w.society.id! } }))!;
    expect(pet.vaccinationReminderFor).toBe('2027-01-10');
    // a new expiry date clears the marker and is reminded again
    setNow('2026-11-01T04:30:00Z');
    await me.c('patch', `/me/pets/${pet.id}`, { vaccinationValidUntil: '2027-01-12', version: 1 });
    expect((await Pet.findByPk(pet.id!))!.vaccinationReminderFor).toBeNull();
    setNow('2026-12-13T04:30:00Z');
    expect(await runPetReminders(w.society.id!)).toBe(1);
  });
});

describe('emergency profiles (BR-09-71, BR-09-72, T09-36, T09-37)', () => {
  it('T09-37 health details need consent (422 CONSENT_REQUIRED); the column never holds the plaintext; the resident reads it back', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Suman Rao' });
    const noConsent = await me.c('put', '/me/emergency-profile', {
      bloodGroup: 'B_POS',
      medicalNotes: 'Diabetic, insulin in fridge',
    });
    expect([noConsent.status, noConsent.body.code]).toEqual([422, 'CONSENT_REQUIRED']);
    expect(await EmergencyProfile.count()).toBe(0);
    const ok = await me.c('put', '/me/emergency-profile', {
      bloodGroup: 'B_POS',
      medicalNotes: 'Diabetic, insulin in fridge',
      isSeniorCitizen: true,
      mobilityNote: 'Uses a walker',
      preferredHospital: 'Ruby Hall Clinic',
      contacts: [{ name: 'Arvind Rao', relation: 'Son', mobile: '9822012345' }],
      consent: true,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      bloodGroup: 'B_POS',
      medicalNotes: 'Diabetic, insulin in fridge',
      isSeniorCitizen: true,
      consent: { given: true, textVersion: 'v1' },
      version: 1,
    });
    const row = (await EmergencyProfile.findOne({ where: { residentId: me.resident.id! } }))!;
    expect(Buffer.from(row.medicalNotesEnc!).toString('utf8')).not.toContain('Diabetic');
    expect(Buffer.from(row.medicalNotesEnc!).length).toBeGreaterThan(28);
    // no plaintext anywhere in the database, audit rows included
    const [rows] = (await sequelize.query(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE CAST(`after` AS CHAR) LIKE '%insulin%' OR CAST(`before` AS CHAR) LIKE '%insulin%'",
    )) as unknown as [{ n: number }[]];
    expect(Number(rows[0]!.n)).toBe(0);
    const audit = await AuditLog.findOne({ where: { action: 'residents.emergency_profile.updated' } });
    expect(JSON.stringify(audit!.after)).toContain('medicalNotes');
    expect(JSON.stringify(audit!.after)).not.toContain('Diabetic');
    const get = await me.c('get', '/me/emergency-profile');
    expect(get.body.data.medicalNotes).toBe('Diabetic, insulin in fridge');
    // the admin detail shows only that a profile exists
    expect((await w.c('get', `/residents/${me.resident.id}`)).body.data.emergencyProfile).toEqual({
      exists: true,
      hasCareFlags: true,
    });
  });

  it('a stale or missing version, duplicate or own contact numbers, and withdrawing consent', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Suman Rao' });
    const base = { bloodGroup: 'O_POS', medicalNotes: 'Asthma', consent: true };
    expect((await me.c('put', '/me/emergency-profile', base)).status).toBe(200);
    const missing = await me.c('put', '/me/emergency-profile', { preferredHospital: 'City' });
    expect(missing.status).toBe(400);
    const stale = await me.c('put', '/me/emergency-profile', { preferredHospital: 'City', version: 5 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const dup = await me.c('put', '/me/emergency-profile', {
      contacts: [
        { name: 'Contact One', relation: 'Son', mobile: '9822012345' },
        { name: 'Contact Two', relation: 'Wife', mobile: '9822012345' },
      ],
      version: 1,
    });
    expect(dup.status).toBe(400);
    const own = await me.c('put', '/me/emergency-profile', {
      contacts: [{ name: 'Myself Again', relation: 'Self', mobile: me.resident.mobile }],
      version: 1,
    });
    expect(own.status).toBe(400);
    expect(
      (
        await me.c('put', '/me/emergency-profile', {
          contacts: [{ name: 'Contact One', relation: 'Son', mobile: '9822012345' }],
          version: 1,
        })
      ).status,
    ).toBe(200);
    const withdrawn = await me.c('put', '/me/emergency-profile', {
      withdrawConsent: true,
      keepContacts: true,
      version: 2,
    });
    expect(withdrawn.body.data).toMatchObject({
      bloodGroup: null,
      medicalNotes: null,
      isSeniorCitizen: false,
      consent: { given: false },
    });
    expect(withdrawn.body.data.contacts).toHaveLength(1);
    expect(await AuditLog.count({ where: { action: 'residents.emergency_profile.consent_withdrawn' } })).toBe(
      1,
    );
    const gone = await me.c('put', '/me/emergency-profile', {
      withdrawConsent: true,
      keepContacts: false,
      version: 3,
    });
    expect(gone.body.data.contacts).toEqual([]);
  });

  it('care flags are a Premium field: 402 on Standard when sent true', async () => {
    const w = await residentSociety({ plan: 'STANDARD', name: 'Std CHS' });
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Std Owner' });
    const r = await me.c('put', '/me/emergency-profile', { isSeniorCitizen: true, consent: true });
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    expect((await me.c('put', '/me/emergency-profile', { bloodGroup: 'A_NEG', consent: true })).status).toBe(
      200,
    );
  });

  it('T09-36 a guard reads the profiles of the SOS flat while the SOS is active, audited; once resolved the same call is 403 EMERGENCY_PROFILE_LOCKED', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Suman Rao', dateOfBirth: '1954-03-03' });
    const other = await residentUser(w.society, w.unit(2).id, { name: 'Other Flat' });
    await me.c('put', '/me/emergency-profile', {
      bloodGroup: 'B_POS',
      medicalNotes: 'Diabetic, insulin in fridge',
      isDifferentlyAbled: true,
      mobilityNote: 'Uses a walker',
      preferredHospital: 'Ruby Hall Clinic',
      contacts: [{ name: 'Arvind Rao', relation: 'Son', mobile: '9822012345' }],
      consent: true,
    });
    await other.c('put', '/me/emergency-profile', { bloodGroup: 'A_POS', consent: true });
    const guard = await memberOf(w.society, 'security_supervisor');
    let status: 'ACTIVE' | 'RESOLVED' = 'ACTIVE';
    setResidentPorts({
      sos: {
        getActive: async (societyId, id) =>
          societyId === w.society.id && id === 9001 ? { id, unitId: w.unit(1).id, status } : null,
      },
    });
    const r = await guard.c('get', '/sos/9001/emergency-profiles');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ sosId: 9001, unitLabel: 'A-101' });
    expect(r.body.data.people).toEqual([
      {
        name: 'Suman Rao',
        age: 72,
        bloodGroup: 'B_POS',
        isSeniorCitizen: false,
        isDifferentlyAbled: true,
        mobilityNote: 'Uses a walker',
        medicalNotes: 'Diabetic, insulin in fridge',
        preferredHospital: 'Ruby Hall Clinic',
        contacts: [{ name: 'Arvind Rao', relation: 'Son', mobile: '9822012345' }],
      },
    ]);
    const audit = await AuditLog.findOne({ where: { action: 'residents.emergency_profile.viewed' } });
    expect(audit).toMatchObject({ entityId: '9001', societyId: w.society.id });
    expect(JSON.stringify(audit!.after)).not.toContain('insulin');
    const gate = await guard.c('get', '/gate/sos/9001/emergency-profiles');
    expect([gate.status, gate.body.code]).toEqual([403, 'PERMISSION_DENIED']); // the security supervisor has no gate.sos.create
    status = 'RESOLVED';
    const locked = await guard.c('get', '/sos/9001/emergency-profiles');
    expect([locked.status, locked.body.code]).toEqual([403, 'EMERGENCY_PROFILE_LOCKED']);
    expect((await guard.c('get', '/sos/777/emergency-profiles')).body.code).toBe('SOS_NOT_FOUND');
    // the port default: no SOS module yet means nothing is ever active
    setResidentPorts();
    expect((await guard.c('get', '/sos/9001/emergency-profiles')).body.code).toBe('SOS_NOT_FOUND');
  });

  it('a household head saves the profile of a member without a login; a member with a login manages their own', async () => {
    const w = await residentSociety();
    const head = await residentUser(w.society, w.unit(1).id, { name: 'Head Owner' });
    const kid = await head.c(
      'post',
      '/me/household/members',
      {
        unitId: w.unit(1).id,
        name: 'Kabir Shah',
        relation: 'FAMILY',
        familyRelation: 'CHILD',
        dateOfBirth: '2018-03-03',
      },
      { headers: idem() },
    );
    expect(kid.status, JSON.stringify(kid.body)).toBe(201);
    const put = await head.c('put', `/me/household/members/${kid.body.data.link.linkId}/emergency-profile`, {
      bloodGroup: 'O_POS',
      contacts: [{ name: 'Head Owner', relation: 'Father', mobile: '9822012345' }],
      consent: true,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const kidRow = (await EmergencyProfile.findOne({ where: { residentId: kid.body.data.residentId } }))!;
    expect(kidRow.consentByUserId).toBe(head.user.id);
    const withLogin = await residentUser(w.society, w.unit(1).id, {
      relation: 'FAMILY',
      name: 'Adult Member',
    });
    const link = withLogin.link.id;
    const r = await head.c('put', `/me/household/members/${link}/emergency-profile`, {
      bloodGroup: 'A_POS',
      consent: true,
    });
    expect([r.status, r.body.code]).toEqual([422, 'MEMBER_HAS_LOGIN']);
  });
});
