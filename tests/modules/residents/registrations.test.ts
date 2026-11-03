import { QueryTypes } from 'sequelize';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EmergencyProfile,
  Invitation,
  Pet,
  Resident,
  ResidentDocument,
  Society,
  SocietyMember,
  Tenancy,
  UnitResident,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues, tickScheduler } from '../../../src/lib/queue';
import { setNow } from '../../../src/lib/clock';
import { exportProviders } from '../../../src/modules/societies/societies.exports';
import { purgeHandlerList } from '../../../src/modules/societies/societies.purge';
import { runCheck } from '../../../src/modules/society-setup/society-setup.onboarding.service';
import { decryptNotes, encryptNotes } from '../../../src/modules/residents/residents.crypto';
import { purgeResidents } from '../../../src/modules/residents/residents.purge';
import { residentStats } from '../../../src/modules/residents/residents.units.service';
import { syncLinksFor } from '../../../src/modules/residents/residents.jobs';
import { queueRegistry } from '../../../src/lib/queue';
import { seedResidents } from '../../../seeders/residents';
import { seedSocietySetup } from '../../../seeders/society-setup';
import { memberUser } from '../../helpers/access';
import { subSociety } from '../../helpers/subscriptions';
import {
  addResident,
  mobile,
  owner,
  residentSociety,
  residentUser,
  resetResidents,
  docFile,
} from '../../helpers/residents';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetResidents);

describe('encryption (BR-09-71, section 13)', () => {
  it('AES-256-GCM round trip with a fresh IV; tampering is detected; the stored bytes do not hold the text', () => {
    const a = encryptNotes('Diabetic, insulin in fridge');
    const b = encryptNotes('Diabetic, insulin in fridge');
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(12 + 16 + Buffer.byteLength('Diabetic, insulin in fridge'));
    expect(a.toString('utf8')).not.toContain('Diabetic');
    expect(decryptNotes(a)).toBe('Diabetic, insulin in fridge');
    const bad = Buffer.from(a);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    expect(() => decryptNotes(bad)).toThrow();
    expect(decryptNotes(encryptNotes('Hindi: मधुमेह'))).toBe('Hindi: मधुमेह');
  });

  it('the schema holds no plaintext medical notes and enforces the consent check (ck_ep_consent)', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Suman Rao' });
    await expect(
      EmergencyProfile.create({
        societyId: w.society.id!,
        residentId: me.resident.id!,
        bloodGroup: 'A_POS',
        isSeniorCitizen: false,
      } as never),
    ).rejects.toThrow(/ck_ep_consent|Check constraint/i);
  });
});

describe('schema constraints (section 7)', () => {
  it('uniqueness of mobile and login per society, one open link per person and flat, one open OWNER, one primary', async () => {
    const w = await residentSociety();
    const a = await Resident.create({
      societyId: w.society.id!,
      name: 'Person One',
      mobile: '9820011121',
      status: 'ACTIVE',
      source: 'ADMIN',
      version: 1,
    } as never);
    await expect(
      Resident.create({
        societyId: w.society.id!,
        name: 'Person Two',
        mobile: '9820011121',
        status: 'ACTIVE',
        source: 'ADMIN',
        version: 1,
      } as never),
    ).rejects.toThrow();
    await a.destroy();
    await Resident.create({
      societyId: w.society.id!,
      name: 'Person Three',
      mobile: '9820011121',
      status: 'ACTIVE',
      source: 'ADMIN',
      version: 1,
    } as never);
    const [p, q] = [
      await Resident.create({
        societyId: w.society.id!,
        name: 'Owner One',
        status: 'ACTIVE',
        source: 'ADMIN',
        version: 1,
      } as never),
      await Resident.create({
        societyId: w.society.id!,
        name: 'Owner Two',
        status: 'ACTIVE',
        source: 'ADMIN',
        version: 1,
      } as never),
    ];
    const link = (residentId: number, o: Record<string, unknown>) =>
      UnitResident.create({
        societyId: w.society.id!,
        unitId: w.unit(1).id,
        residentId,
        relation: 'OWNER',
        fromDate: '2026-01-01',
        ...o,
      } as never);
    await link(p.id!, { isPrimary: true });
    await expect(link(q.id!, { isPrimary: false })).rejects.toThrow(); // second open OWNER
    await expect(link(p.id!, { relation: 'CO_OWNER' })).rejects.toThrow(); // second open link of the person
    await expect(link(q.id!, { relation: 'CO_OWNER', isPrimary: true })).rejects.toThrow(); // second primary
    await expect(
      link(q.id!, { relation: 'FAMILY', isPrimary: true, familyRelation: 'CHILD' }),
    ).rejects.toThrow(); // ck_ur_primary
    await expect(link(q.id!, { relation: 'FAMILY' })).rejects.toThrow(); // ck_ur_family
    await expect(
      link(q.id!, { relation: 'CO_OWNER', toDate: '2025-01-01', endReason: 'SOLD' }),
    ).rejects.toThrow(); // ck_ur_dates
    await expect(link(q.id!, { relation: 'CO_OWNER', toDate: '2026-02-01' })).rejects.toThrow(); // ck_ur_end
    await expect(link(q.id!, { relation: 'CO_OWNER', sharePercent: '0.001' })).rejects.toThrow();
    expect(
      (
        await sequelize.query<{ c: string }>(
          "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unit_residents' AND EXTRA LIKE '%STORED GENERATED%' ORDER BY 1",
          { type: QueryTypes.SELECT },
        )
      ).map(r => r.c),
    ).toEqual(['openSlot', 'ownerSlot', 'primarySlot']);
    expect(await Invitation.count()).toBe(0);
  });

  it('the foreign key of invitations.residentId exists and is SET NULL', async () => {
    const rows = await sequelize.query<{ DELETE_RULE: string }>(
      "SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_invitations_resident'",
      { type: QueryTypes.SELECT },
    );
    expect(rows).toEqual([{ DELETE_RULE: 'SET NULL' }]);
  });
});

describe('module 05 registrations (section 13)', () => {
  it('the export provider lists the ten tables, streams only the society rows, includes deleted rows and decrypts the notes', async () => {
    const w = await residentSociety();
    const other = await residentSociety({ name: 'Other CHS' });
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Suman Rao' });
    await me.c('put', '/me/emergency-profile', {
      bloodGroup: 'B_POS',
      medicalNotes: 'Asthma, inhaler in bag',
      consent: true,
    });
    await residentUser(other.society, other.unit(1).id, { name: 'Other Resident' });
    const gone = await addResident(w.c, { name: 'Soft Deleted', mobile: mobile() });
    await w.c('delete', `/residents/${gone.id}`, { reason: 'Added by mistake', version: 1 });
    const p = exportProviders().find(x => x.module === 'residents')!;
    expect(p.tables.map(t => t.name)).toEqual([
      'residents',
      'unit_residents',
      'tenancies',
      'resident_documents',
      'join_requests',
      'move_requests',
      'renovation_permits',
      'ownership_transfers',
      'pets',
      'emergency_profiles',
    ]);
    const rows = async (name: string) => {
      const out: Record<string, unknown>[] = [];
      for await (const r of p.tables.find(t => t.name === name)!.stream(w.society.id!)) out.push(r);
      return out;
    };
    const res = await rows('residents');
    expect(res.map(r => r.name).sort()).toEqual(['Soft Deleted', 'Suman Rao']);
    expect(res.every(r => r.societyId === w.society.id)).toBe(true);
    const ep = await rows('emergency_profiles');
    expect(ep).toHaveLength(1);
    expect(ep[0]).toMatchObject({ medicalNotes: 'Asthma, inhaler in bag', bloodGroup: 'B_POS' });
    expect(Object.keys(ep[0]!)).not.toContain('medicalNotesEnc');
    expect(await rows('tenancies')).toEqual([]);
    expect(await rows('unit_residents')).toHaveLength(1);
  });

  it('the purge handler (order 9) deletes the society rows in dependency order, keeps other societies, and frees invitations', async () => {
    const w = await residentSociety();
    const other = await residentSociety({ name: 'Other CHS' });
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Suman Rao' });
    await me.c(
      'post',
      '/me/pets',
      { unitId: w.unit(1).id, name: 'Mishti', species: 'CAT' },
      { headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' } },
    );
    await me.c('put', '/me/emergency-profile', { bloodGroup: 'B_POS', consent: true });
    await ResidentDocument.create({
      societyId: w.society.id!,
      residentId: me.resident.id!,
      docType: 'PAN',
      fileId: docFile(w.society.id!, me.user.id),
      uploadedByUserId: me.user.id,
    } as never);
    const inv = await addResident(w.c, {
      name: 'Invitee',
      mobile: mobile(),
      link: owner(w.unit(2).id),
      invite: true,
    });
    await residentUser(other.society, other.unit(1).id, { name: 'Other Resident' });
    const h = purgeHandlerList().find(x => x.module === 'residents')!;
    expect(h.order).toBe(9);
    expect(h.tables).toEqual([
      'emergency_profiles',
      'pets',
      'resident_documents',
      'move_requests',
      'renovation_permits',
      'join_requests',
      'unit_residents',
      'ownership_transfers',
      'tenancies',
      'residents',
    ]);
    const r = await purgeResidents(w.society.id!);
    expect(r.anonymised).toBe(0);
    expect(r.deleted).toBeGreaterThanOrEqual(7);
    const where = { societyId: w.society.id! };
    expect([
      await Resident.count({ where, paranoid: false }),
      await UnitResident.count({ where }),
      await Pet.count({ where, paranoid: false }),
      await EmergencyProfile.count({ where }),
      await Tenancy.count({ where }),
      await ResidentDocument.count({ where, paranoid: false }),
    ]).toEqual([0, 0, 0, 0, 0, 0]);
    expect((await Invitation.findOne({ where: { societyId: w.society.id! } }))!.residentId).toBeNull();
    expect(await Resident.count({ where: { societyId: other.society.id! } })).toBe(1);
    expect(await UnitResident.count({ where: { societyId: other.society.id! } })).toBe(1);
    expect(inv.id).toBeGreaterThan(0);
    expect(await SocietyMember.count({ where: { societyId: other.society.id! } })).toBeGreaterThan(0);
  });
});

describe('module 08 registrations (section 8.24)', () => {
  it('the RESIDENTS onboarding check passes once an ACTIVE unit has an active owner and says how many flats have one', async () => {
    const w = await residentSociety({ flats: 3 });
    expect(await runCheck(w.society.id!, 'RESIDENTS')).toEqual({
      state: 'FAIL',
      summary: 'No owners linked yet',
    });
    await addResident(w.c, { name: 'Owner One', link: owner(w.unit(1).id) });
    expect(await runCheck(w.society.id!, 'RESIDENTS')).toEqual({
      state: 'PASS',
      summary: '1 of 3 flats have an owner',
    });
    await addResident(w.c, { name: 'Future Owner', link: owner(w.unit(2).id, { fromDate: '2026-11-20' }) });
    expect((await runCheck(w.society.id!, 'RESIDENTS')).summary).toBe('1 of 3 flats have an owner');
  });
});

describe('jobs (section 9.1)', () => {
  it('registers the residents queue and its repeatable jobs; the daily sync-links runs for active societies only', async () => {
    expect(queueRegistry.has('residents')).toBe(true);
    const w = await residentSociety();
    const ru = await residentUser(w.society, w.unit(1).id, { name: 'Owner Login' });
    // the link is ended today by hand in the table: the member must go on the next day's run of the job
    await UnitResident.update(
      { toDate: '2026-11-01', endReason: 'MOVED_OUT', isPrimary: false },
      { where: { id: ru.link.id } },
    );
    setNow('2026-11-02T18:45:00Z'); // 00:15 IST on 2026-11-03, the minute of the daily job
    expect((await tickScheduler()).filter(j => j === 'residents:sync-links')).toEqual([
      'residents:sync-links',
    ]);
    await drainQueues();
    expect(
      (await SocietyMember.findOne({ where: { societyId: w.society.id!, userId: ru.user.id } }))!.status,
    ).toBe('ENDED');
    expect((await Resident.findByPk(ru.resident.id!))!.status).toBe('INACTIVE');
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.society.id! } },
    );
    expect(await syncLinksFor(w.society.id!)).toBe(0);
    setNow('2026-11-01T04:30:00Z');
  });
});

describe('demo seed (spec 16 step 9)', () => {
  it('Sky Heights gets 60 owners, 2 co-owner flats, family, 14 tenancies and pets, Green Park 24 owners and 3 tenancies; unit counts stay 72 and 30; idempotent', async () => {
    const sky = (await subSociety({ plan: 'PREMIUM', flats: 72, name: 'Sky Heights CHS' })).society;
    const green = (await subSociety({ plan: 'STARTER', flats: 30, name: 'Green Park CHS' })).society;
    await Society.update({ slug: 'sky-heights' }, { where: { id: sky.id! } });
    await Society.update({ slug: 'green-park' }, { where: { id: green.id! } });
    const chair = await memberUser(sky, 'chairman', { name: 'Rajesh Kulkarni', mobile: '9820011111' });
    await memberUser(sky, 'treasurer', { name: 'Meera Iyer', mobile: '9820022222' });
    await seedSocietySetup();
    const r = await seedResidents();
    expect(r).toMatchObject({
      societies: ['sky-heights', 'green-park'],
      skipped: [],
      tenancies: 17,
      pets: 3,
    });
    const count = (societyId: number, where: Record<string, unknown> = {}) =>
      UnitResident.count({ where: { societyId, toDate: null, ...where } as never });
    expect(await count(sky.id!, { relation: 'OWNER' })).toBe(60);
    expect(await count(sky.id!, { relation: 'CO_OWNER' })).toBe(2);
    expect(await count(sky.id!, { relation: 'TENANT' })).toBe(14);
    expect(await count(sky.id!, { relation: 'FAMILY' })).toBe(15);
    expect(await count(green.id!, { relation: 'OWNER' })).toBe(24);
    expect(await count(green.id!, { relation: 'TENANT' })).toBe(3);
    const stats = await residentStats(sky.id!);
    expect(stats).toMatchObject({
      units: 72,
      ownerOccupied: 46,
      rented: 14,
      vacant: 12,
      tenanciesExpiringIn30: 2,
      overstaying: 1,
      policeVerification: { active: 14, verified: 10, pending: 4 },
      residents: 91,
      residentsWithLogin: 2,
    });
    expect((await residentStats(green.id!)).units).toBe(30);
    // the chairman owns A-501 and keeps the chairman role
    const row = (await Resident.findOne({ where: { societyId: sky.id!, userId: chair.id } }))!;
    expect(row.memberId).toBe(chair.memberId);
    expect(await UnitResident.findOne({ where: { residentId: row.id! } })).toMatchObject({
      relation: 'OWNER',
      isResiding: true,
    });
    // one resident of the seed has an emergency profile with encrypted notes
    const ep = (await EmergencyProfile.findOne({ where: { societyId: sky.id! } }))!;
    expect(decryptNotes(Buffer.from(ep.medicalNotesEnc!))).toContain('Diabetic');
    const again = await seedResidents();
    expect(again).toMatchObject({ societies: [], skipped: ['sky-heights', 'green-park'], residents: 0 });
  });
});
