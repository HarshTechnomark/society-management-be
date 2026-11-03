import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  EmergencyProfile,
  Invitation,
  JoinRequest,
  Resident,
  ResidentDocument,
  Role,
  SocietyMember,
  UnitResident,
  User,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { setNow } from '../../../src/lib/clock';
import { residentsHooks, residents } from '../../../src/modules/residents/residents.public';
import { residentPortCalls } from '../../../src/modules/residents/residents.ports';
import { setupPorts } from '../../../src/modules/society-setup/society-setup.ports';
import { systemCtx } from '../../../src/types/context';
import { as, login, makeSociety, memberUser } from '../../helpers/access';
import { inboxFor, makeUser } from '../../helpers/auth';
import {
  addResident,
  docFile,
  idem,
  mobile,
  owner,
  residentSociety,
  resetResidents,
} from '../../helpers/residents';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetResidents);

const tokenFor = async (m: string): Promise<string> => {
  const msg = (await inboxFor(m)).find(x => x.channel === 'SMS')!;
  const t = msg.body.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
  if (!t) throw new Error(`no token in ${msg.body}`);
  return t;
};

describe('invite (BR-09-20, 8.7)', () => {
  it('INVITE_NOT_POSSIBLE without a mobile or without a link that allows login', async () => {
    const { c, unit } = await residentSociety();
    const noMobile = await addResident(c, { name: 'No Phone', link: owner(unit(1).id) });
    const a = await c('post', `/residents/${noMobile.id}/invite`, {}, { headers: idem() });
    expect([a.status, a.body.code]).toEqual([422, 'INVITE_NOT_POSSIBLE']);
    const noLink = await addResident(c, { name: 'No Link', mobile: mobile() });
    const b = await c('post', `/residents/${noLink.id}/invite`, {}, { headers: idem() });
    expect([b.status, b.body.code]).toEqual([422, 'INVITE_NOT_POSSIBLE']);
    const minor = await addResident(c, {
      name: 'Minor Child',
      mobile: mobile(),
      dateOfBirth: '2016-02-02',
      link: {
        unitId: unit(1).id,
        relation: 'FAMILY',
        familyRelation: 'CHILD',
        householdOf: 'OWNER',
        fromDate: '2026-01-01',
      },
    });
    const m = await c('post', `/residents/${minor.id}/invite`, {}, { headers: idem() });
    expect([m.status, m.body.code]).toEqual([422, 'INVITE_NOT_POSSIBLE']);
    // the head sets canLogin and the minor can be invited
    expect(
      (await c('patch', `/residents/links/${minor.links[0].linkId}`, { canLogin: true, version: 1 })).status,
    ).toBe(200);
    expect((await c('post', `/residents/${minor.id}/invite`, {}, { headers: idem() })).body.data.mode).toBe(
      'INVITED',
    );
    const bare = await c('post', '/residents/1/invite', { surprise: true }, { headers: idem() });
    expect(bare.status).toBe(400);
  });

  it('invites with the role of the strongest relation, once; a second invite is 409 INVITATION_ALREADY_PENDING', async () => {
    const { society, c, unit } = await residentSociety();
    const o = await addResident(c, { name: 'Owner One', mobile: mobile(), link: owner(unit(1).id) });
    const r = await c('post', `/residents/${o.id}/invite`, { message: 'Welcome home' }, { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.mode).toBe('INVITED');
    const inv = (await Invitation.findByPk(r.body.data.invitation.id))!;
    expect(inv).toMatchObject({
      societyId: society.id,
      unitId: unit(1).id,
      residentId: o.id,
      status: 'PENDING',
    });
    expect((await Role.findByPk(inv.roleId))!.key).toBe('owner');
    const again = await c('post', `/residents/${o.id}/invite`, {}, { headers: idem() });
    expect([again.status, again.body.code]).toEqual([409, 'INVITATION_ALREADY_PENDING']);
    expect(
      await AuditLog.count({ where: { societyId: society.id!, action: 'residents.resident.invited' } }),
    ).toBe(1);
  });

  it('a person who is already an active member is linked directly (mode LINKED) and a second invite is 409 ALREADY_LINKED', async () => {
    const { society, c, unit } = await residentSociety();
    const treasurer = await memberUser(society, 'treasurer', { name: 'Meera Iyer' });
    const o = await addResident(c, { name: 'Meera Iyer', mobile: treasurer.mobile, link: owner(unit(1).id) });
    const r = await c('post', `/residents/${o.id}/invite`, {}, { headers: idem() });
    expect(r.body.data).toEqual({ mode: 'LINKED', memberId: treasurer.memberId });
    const row = (await Resident.findByPk(o.id))!;
    expect([row.userId, row.memberId]).toEqual([treasurer.id, treasurer.memberId]);
    expect(await Invitation.count({ where: { residentId: o.id } })).toBe(0);
    // the committee role stays (BR-09-78)
    expect((await Role.findByPk((await SocietyMember.findByPk(treasurer.memberId))!.roleId))!.key).toBe(
      'treasurer',
    );
    const again = await c('post', `/residents/${o.id}/invite`, {}, { headers: idem() });
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_LINKED']);
  });
});

describe('accepting an invitation (BR-09-21, T09-41)', () => {
  it('T09-41 the accept sets userId and memberId, runs the sync and gives the member the owner role', async () => {
    const { society, c, unit } = await residentSociety();
    const user = await makeUser({ name: 'Ravi Shah' });
    const o = await addResident(c, {
      name: 'Ravi Shah',
      mobile: user.mobile,
      link: owner(unit(1).id),
      invite: true,
    });
    const token = await tokenFor(user.mobile);
    const cookies = await login(user, { app: 'RESIDENT' });
    const r = await as(cookies, 'RESIDENT')('post', `/invitations/${token}/accept`, {}, { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await Resident.findByPk(o.id))!;
    const m = (await SocietyMember.findOne({ where: { societyId: society.id!, userId: user.id } }))!;
    expect([row.userId, row.memberId]).toEqual([user.id, m.id]);
    expect((await Role.findByPk(m.roleId))!.key).toBe('owner');
    expect(
      await AuditLog.count({ where: { societyId: society.id!, action: 'residents.resident.user_linked' } }),
    ).toBe(1);
    expect(await residents.unitIdsForUser(society.id!, user.id)).toEqual([unit(1).id]);
  });

  it('a login that already belongs to another resident of the society rolls the accept back with 409 ALREADY_LINKED', async () => {
    const { society, c, unit } = await residentSociety();
    const user = await makeUser({ name: 'Ravi Shah' });
    await addResident(c, { name: 'Ravi Shah', mobile: user.mobile, link: owner(unit(1).id), invite: true });
    const token = await tokenFor(user.mobile);
    await Resident.create({
      societyId: society.id!,
      userId: user.id,
      name: 'Same Login Other Row',
      mobile: mobile(),
      status: 'ACTIVE',
      source: 'ADMIN',
      version: 1,
    } as never);
    const r = await as(await login(user, { app: 'RESIDENT' }), 'RESIDENT')(
      'post',
      `/invitations/${token}/accept`,
      {},
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([409, 'ALREADY_LINKED']);
    expect(await SocietyMember.count({ where: { societyId: society.id!, userId: user.id } })).toBe(0);
    expect((await Invitation.findOne({ where: { societyId: society.id! } }))!.status).toBe('PENDING');
  });
});

describe('welcome invites (BR-09-79, T09-44)', () => {
  it('T09-44 invites every eligible resident once; a second run invites nobody; module 08 calls the real function', async () => {
    const { society, c, unit } = await residentSociety({ flats: 5 });
    for (let i = 1; i <= 3; i++)
      await addResident(c, { name: `Owner ${'ABC'[i - 1]}`, mobile: mobile(), link: owner(unit(i).id) });
    await addResident(c, { name: 'No Phone Owner', link: owner(unit(4).id) });
    await addResident(c, {
      name: 'Minor Child',
      mobile: mobile(),
      dateOfBirth: '2016-02-02',
      link: {
        unitId: unit(1).id,
        relation: 'FAMILY',
        familyRelation: 'CHILD',
        householdOf: 'OWNER',
        fromDate: '2026-01-01',
      },
    });
    await addResident(c, { name: 'No Link Person', mobile: mobile() });
    const first = await residents.sendWelcomeInvites(systemCtx('t'), society.id!);
    expect(first).toEqual({ invited: 3, linked: 0, skipped: 0 });
    expect(await Invitation.count({ where: { societyId: society.id!, status: 'PENDING' } })).toBe(3);
    expect(await residents.sendWelcomeInvites(systemCtx('t'), society.id!)).toEqual({
      invited: 0,
      linked: 0,
      skipped: 0,
    });
    // the go-live port of module 08 is now the real function
    await addResident(c, { name: 'Late Owner', mobile: mobile(), link: owner(unit(5).id) });
    await setupPorts().residents.sendWelcomeInvites(systemCtx('t'), society.id!);
    expect(await Invitation.count({ where: { societyId: society.id!, status: 'PENDING' } })).toBe(4);
    const summary = await AuditLog.count({
      where: { societyId: society.id!, action: 'residents.welcome_invites.sent' },
    });
    expect(summary).toBe(3);
  });

  it('an existing member is linked instead of invited', async () => {
    const { society, c, unit } = await residentSociety();
    const t = await memberUser(society, 'treasurer', { name: 'Meera Iyer' });
    await addResident(c, { name: 'Meera Iyer', mobile: t.mobile, link: owner(unit(1).id) });
    expect(await residents.sendWelcomeInvites(systemCtx('t'), society.id!)).toEqual({
      invited: 0,
      linked: 1,
      skipped: 0,
    });
  });
});

describe('module 02 hooks (BR-09-76, BR-09-77)', () => {
  it('T09-39 a mobile change updates the resident of every society, keeps the old number where another resident has the new one, and never throws', async () => {
    const one = await residentSociety({ name: 'One CHS' });
    const two = await residentSociety({ name: 'Two CHS' });
    const user = await makeUser({ name: 'Traveller' });
    const old = user.mobile;
    const make = (societyId: number, m: string) =>
      Resident.create({
        societyId,
        userId: user.id,
        name: 'Traveller',
        mobile: m,
        status: 'ACTIVE',
        source: 'ADMIN',
        version: 1,
      } as never);
    const r1 = await make(one.society.id!, old);
    const r2 = await make(two.society.id!, old);
    const newMobile = mobile();
    await Resident.create({
      societyId: two.society.id!,
      name: 'Holds New Number',
      mobile: newMobile,
      status: 'ACTIVE',
      source: 'ADMIN',
      version: 1,
    } as never);
    await sequelize.transaction(t => residentsHooks.onUserMobileChanged(user.id, old, newMobile, t));
    expect((await Resident.findByPk(r1.id!))!.mobile).toBe(newMobile);
    expect((await Resident.findByPk(r2.id!))!.mobile).toBe(old);
    expect(
      await AuditLog.count({
        where: { action: 'residents.resident.mobile_synced', societyId: one.society.id! },
      }),
    ).toBe(1);
    expect(
      await AuditLog.count({
        where: { action: 'residents.resident.mobile_synced', societyId: two.society.id! },
      }),
    ).toBe(0);
    const mail = await inboxFor((await User.findByPk(two.user.id))!.email ?? '');
    expect(mail.some(m => /could not be updated/.test(m.subject ?? ''))).toBe(true);
    expect(
      JSON.stringify(await AuditLog.findAll({ where: { action: 'residents.resident.mobile_synced' } })),
    ).not.toContain(newMobile);
  });

  it('T09-40 an anonymised user: a resident without open links is anonymised, one with open links keeps name and history', async () => {
    const { society, c, unit } = await residentSociety();
    const user = await makeUser({ name: 'Leaving User' });
    const kept = await Resident.create({
      societyId: society.id!,
      userId: user.id,
      name: 'Keeps History',
      mobile: mobile(),
      email: 'k@mail.in',
      dateOfBirth: '1980-01-01',
      status: 'ACTIVE',
      source: 'ADMIN',
      version: 1,
    } as never);
    const open = await addResident(c, { name: 'Open Link', link: owner(unit(1).id) });
    await UnitResident.update({ residentId: kept.id! }, { where: { residentId: open.id } });
    const second = await residentSociety({ name: 'Second CHS' });
    const gone = await Resident.create({
      societyId: second.society.id!,
      userId: user.id,
      name: 'Full Anonymise',
      mobile: mobile(),
      email: 'g@mail.in',
      dateOfBirth: '1980-01-01',
      status: 'INACTIVE',
      source: 'ADMIN',
      version: 1,
    } as never);
    await EmergencyProfile.create({
      societyId: second.society.id!,
      residentId: gone.id!,
      bloodGroup: null,
      contact1Name: 'Someone',
      contact1Mobile: mobile(),
    } as never);
    const file = docFile(second.society.id!, second.user.id);
    await ResidentDocument.create({
      societyId: second.society.id!,
      residentId: gone.id!,
      docType: 'AADHAAR',
      fileId: file,
      idLast4: '1234',
      uploadedByUserId: second.user.id,
    } as never);
    await JoinRequest.create({
      societyId: second.society.id!,
      userId: user.id,
      unitId: second.unit(1).id,
      relation: 'FAMILY',
      familyRelation: 'SPOUSE',
      householdOf: 'OWNER',
      name: 'Leaving User',
      mobile: mobile(),
      status: 'PENDING_ADMIN',
      expiresAt: new Date('2026-11-10T00:00:00Z'),
    } as never);
    residentPortCalls.length = 0;
    await sequelize.transaction(t => residentsHooks.onUserAnonymised(user.id, t));
    const a = (await Resident.findByPk(kept.id!))!;
    expect([a.name, a.userId, a.memberId, a.mobile, a.email, a.dateOfBirth, a.anonymisedAt]).toEqual([
      'Keeps History',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(await UnitResident.count({ where: { residentId: kept.id!, toDate: null } })).toBe(1);
    const b = (await Resident.findByPk(gone.id!))!;
    expect([b.name, b.userId, b.mobile, b.email, b.dateOfBirth]).toEqual([
      'Former resident',
      null,
      null,
      null,
      null,
    ]);
    expect(b.anonymisedAt).not.toBeNull();
    expect(await EmergencyProfile.count({ where: { residentId: gone.id! } })).toBe(0);
    expect(await ResidentDocument.count({ where: { residentId: gone.id! } })).toBe(0);
    expect(residentPortCalls.filter(x => x.fn === 'files.deleteFile').map(x => x.input)).toEqual([
      { fileId: file },
    ]);
    expect((await JoinRequest.findOne({ where: { userId: user.id } }))!.status).toBe('WITHDRAWN');
    expect(await AuditLog.count({ where: { action: 'residents.resident.anonymised' } })).toBe(2);
    setNow('2026-11-01T04:30:00Z');
    void makeSociety;
  });
});
