import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pet, Resident, ResidentDocument, UnitResident, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { setResidentPorts } from '../../../src/modules/residents/residents.ports';
import { as, login, memberUser } from '../../helpers/access';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { app } from '../../helpers/auth';
import {
  addResident,
  docFile,
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

const routes = listRoutes(app);
const mine = (r: { path: string }) =>
  /^\/(residents|resident-documents|pets|sos|gate\/sos|me\/(household\/members|household$|portfolio|pets|emergency-profile|privacy|directory|documents))/.test(
    r.path,
  );

describe('route table of module 09 part 1', () => {
  it('registers the 45 routes with the permissions, features, step-up, idempotency and support rules of section 8', () => {
    const ours = routes.filter(mine);
    expect(ours).toHaveLength(45);
    expect(ours.every(r => r.kind === 'society')).toBe(true);
    const find = (m: string, p: string) => ours.find(r => r.method === m && r.path === p)!;
    expect(find('GET', '/residents')).toMatchObject({
      permissions: ['residents.people.view'],
      features: ['residents.person_registry'],
    });
    expect(find('POST', '/residents')).toMatchObject({
      permissions: ['residents.people.create'],
      idempotent: true,
    });
    expect(find('PATCH', '/residents/:id').permissions).toEqual(['residents.people.edit']);
    expect(find('DELETE', '/residents/:id')).toMatchObject({
      permissions: ['residents.people.delete'],
      stepUp: true,
    });
    expect(find('POST', '/residents/:id/invite')).toMatchObject({
      features: ['residents.invitation_and_self_registration'],
      idempotent: true,
    });
    expect(find('POST', '/residents/:id/links').idempotent).toBe(true);
    expect(find('PUT', '/residents/units/:unitId/ownership-shares').features).toEqual([
      'residents.joint_ownership',
    ]);
    expect(find('POST', '/residents/units/:unitId/vacate').features).toEqual(['residents.occupancy_records']);
    expect(find('GET', '/residents/units/:unitId/timeline').features).toEqual([
      'residents.resident_timeline',
    ]);
    expect(find('GET', '/residents/stats').features).toEqual(['residents.occupancy_analytics']);
    expect(find('GET', '/residents/export')).toMatchObject({
      permissions: ['residents.people.export'],
      stepUp: true,
    });
    expect(find('POST', '/residents/import')).toMatchObject({
      permissions: ['residents.people.import'],
      idempotent: true,
    });
    expect(find('POST', '/resident-documents/:docId/verify').permissions).toEqual([
      'residents.people.approve',
    ]);
    expect(find('DELETE', '/resident-documents/:docId').permissions).toEqual(['residents.people.delete']);
    expect(find('GET', '/pets').features).toEqual(['residents.pets_registry']);
    expect(find('GET', '/sos/:sosId/emergency-profiles').permissions).toEqual(['security.incidents.view']);
    expect(find('GET', '/gate/sos/:sosId/emergency-profiles').permissions).toEqual(['gate.sos.create']);
    expect(find('POST', '/me/household/members')).toMatchObject({
      permissions: ['resident.household.create'],
      idempotent: true,
    });
    expect(find('DELETE', '/me/household/members/:linkId').permissions).toEqual([
      'resident.household.delete',
    ]);
    expect(find('GET', '/me/directory')).toMatchObject({
      permissions: ['resident.community.view'],
      features: ['residents.resident_directory'],
    });
    expect(find('PUT', '/me/emergency-profile').features).toEqual(['residents.emergency_profile']);
    expect(find('POST', '/me/pets').features).toEqual(['residents.pets_registry']);
    expect(
      ours
        .filter(r => r.noSupportAccess)
        .map(r => `${r.method} ${r.path}`)
        .sort(),
    ).toEqual(
      [
        'GET /me/documents/:docId/download-url',
        'GET /residents/export',
        'GET /residents/import/:jobId',
        'GET /resident-documents/:docId/download-url',
        'POST /residents/import',
      ].sort(),
    );
    // every create route that inserts a row honours the Idempotency-Key (BR-09-75)
    expect(
      ours
        .filter(
          r =>
            r.method === 'POST' &&
            /^\/(residents|me\/(household\/members|pets|documents))(\/:id\/(links|documents|invite)|\/:linkId\/invite)?$/.test(
              r.path,
            ),
        )
        .filter(r => !r.idempotent)
        .map(r => r.path),
    ).toEqual([]);
    // BR-09-74: nothing is allow-listed for a suspended or closed society
    expect(ours.some(r => r.allowWhenSuspended || r.allowWhenClosed)).toBe(false);
  });
});

describe('T09-46 tenant isolation (part 1)', () => {
  it("an admin of society A gets 404 with the entity code on every route for society B's resident, link, flat, document and import", async () => {
    const a = await residentSociety({ name: 'A CHS' });
    const b = await residentSociety({ name: 'B CHS' });
    const bRes = await addResident(b.c, { name: 'B Owner', mobile: mobile(), link: owner(b.unit(1).id) });
    const bLink = (await UnitResident.findOne({ where: { residentId: bRes.id } }))!;
    const up = await b.c(
      'post',
      `/residents/${bRes.id}/documents`,
      { fileId: docFile(b.society.id!, b.user.id), docType: 'PAN', idLast4: 'ABCD' },
      { headers: idem() },
    );
    const bDoc = up.body.data.id as number;
    const run = async (m: string, p: string, body: unknown, code: string) => {
      const r = await a.c(m as 'get', p, body, { headers: idem() });
      expect([r.status, r.body.code], `${m} ${p}`).toEqual([404, code]);
    };
    await run('get', `/residents/${bRes.id}`, undefined, 'RESIDENT_NOT_FOUND');
    await run('patch', `/residents/${bRes.id}`, { name: 'Hacked Name', version: 2 }, 'RESIDENT_NOT_FOUND');
    await run(
      'delete',
      `/residents/${bRes.id}`,
      { reason: 'Trying to delete', version: 2 },
      'RESIDENT_NOT_FOUND',
    );
    await run('post', `/residents/${bRes.id}/invite`, {}, 'RESIDENT_NOT_FOUND');
    await run(
      'post',
      `/residents/${bRes.id}/links`,
      { unitId: a.unit(1).id, relation: 'CO_OWNER', fromDate: '2026-01-01' },
      'RESIDENT_NOT_FOUND',
    );
    await run('get', `/residents/${bRes.id}/documents`, undefined, 'RESIDENT_NOT_FOUND');
    await run(
      'post',
      `/residents/${bRes.id}/documents`,
      { fileId: docFile(a.society.id!, a.user.id), docType: 'PAN' },
      'RESIDENT_NOT_FOUND',
    );
    await run('patch', `/residents/links/${bLink.id}`, { isResiding: false, version: 1 }, 'LINK_NOT_FOUND');
    await run(
      'post',
      `/residents/links/${bLink.id}/end`,
      { toDate: '2026-10-31', endReason: 'MOVED_OUT', version: 1 },
      'LINK_NOT_FOUND',
    );
    await run('get', `/residents/units/${b.unit(1).id}`, undefined, 'UNIT_NOT_FOUND');
    await run('get', `/residents/units/${b.unit(1).id}/timeline`, undefined, 'UNIT_NOT_FOUND');
    await run(
      'post',
      `/residents/units/${b.unit(1).id}/vacate`,
      { reason: 'Trying to vacate' },
      'UNIT_NOT_FOUND',
    );
    await run(
      'put',
      `/residents/units/${b.unit(1).id}/ownership-shares`,
      {
        shares: [{ linkId: bLink.id, sharePercent: '100' }],
        primaryLinkId: bLink.id,
        version: [{ linkId: bLink.id, version: 1 }],
      },
      'UNIT_NOT_FOUND',
    );
    await run(
      'post',
      `/resident-documents/${bDoc}/verify`,
      { decision: 'VERIFIED', version: 1 },
      'DOCUMENT_NOT_FOUND',
    );
    await run('delete', `/resident-documents/${bDoc}`, { reason: 'Trying to delete' }, 'DOCUMENT_NOT_FOUND');
    await run('get', `/resident-documents/${bDoc}/download-url`, undefined, 'DOCUMENT_NOT_FOUND');
    await run('get', '/sos/9001/emergency-profiles', undefined, 'SOS_NOT_FOUND');
    await run('get', '/residents/import/imp_00000000', undefined, 'IMPORT_JOB_NOT_FOUND');
    expect((await a.c('get', '/residents')).body.data).toEqual([]);
    expect((await a.c('get', '/residents/units')).body.data.every((u: any) => u.primaryOwner === null)).toBe(
      true,
    );
    expect(await Resident.count({ where: { id: bRes.id } })).toBe(1);
    expect((await UnitResident.findByPk(bLink.id!))!.toDate).toBeNull();
    expect(await ResidentDocument.count({ where: { id: bDoc } })).toBe(1);
  });

  it('a resident of society A cannot reach the flat, link, pet or document of society B or of another flat', async () => {
    const a = await residentSociety({ name: 'A CHS' });
    const b = await residentSociety({ name: 'B CHS' });
    const me = await residentUser(a.society, a.unit(1).id, { name: 'A Owner' });
    const bOwner = await residentUser(b.society, b.unit(1).id, { name: 'B Owner' });
    const pet = await bOwner.c(
      'post',
      '/me/pets',
      { unitId: b.unit(1).id, name: 'Rex', species: 'CAT' },
      { headers: idem() },
    );
    const doc = await bOwner.c(
      'post',
      '/me/documents',
      { fileId: docFile(b.society.id!, bOwner.user.id), docType: 'PAN', idLast4: 'ABCD' },
      { headers: idem() },
    );
    for (const [m, p, body, code] of [
      ['patch', `/me/pets/${pet.body.data.id}`, { name: 'Taken', version: 1 }, 'PET_NOT_FOUND'],
      ['delete', `/me/pets/${pet.body.data.id}`, {}, 'PET_NOT_FOUND'],
      ['get', `/me/documents/${doc.body.data.id}/download-url`, undefined, 'DOCUMENT_NOT_FOUND'],
      ['patch', `/me/household/members/${bOwner.link.id}`, { canLogin: false, version: 1 }, 'LINK_NOT_FOUND'],
      ['post', '/me/pets', { unitId: b.unit(1).id, name: 'Rex', species: 'CAT' }, 'UNIT_NOT_FOUND'],
    ] as const) {
      const r = await me.c(m, p, body, { headers: idem() });
      expect([r.status, r.body.code], `${m} ${p}`).toEqual([404, code]);
    }
    expect(await Pet.count({ where: { id: pet.body.data.id } })).toBe(1);
  });

  it("the SOS card routes only ask module 17 about the caller's own society (404 SOS_NOT_FOUND for another society's SOS)", async () => {
    const a = await residentSociety({ name: 'A CHS' });
    const b = await residentSociety({ name: 'B CHS' });
    const gate = as(
      await login(await memberUser(a.society, 'guard', { name: 'Guard' }), {
        app: 'GATE',
        societyId: a.society.id!,
      }),
      'GATE',
    );
    setResidentPorts({
      sos: {
        getActive: async (societyId, id) =>
          societyId === b.society.id ? { id, unitId: b.unit(1).id, status: 'ACTIVE' } : null,
      },
    });
    for (const p of ['/gate/sos/9001/emergency-profiles', '/sos/9001/emergency-profiles']) {
      const r = await (p.startsWith('/gate') ? gate : a.c)('get', p);
      expect([r.status, r.body.code], p).toEqual([404, 'SOS_NOT_FOUND']);
    }
  });

  it('T09-48 a resident cannot use the admin routes', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Owner Login' });
    for (const [m, p] of [
      ['get', '/residents'],
      ['get', '/residents/units'],
      ['get', '/pets'],
      ['get', '/residents/stats'],
    ] as const)
      expect((await me.c(m, p)).body.code, p).toBe('PERMISSION_DENIED');
    expect((await me.c('get', '/me/household')).status).toBe(200);
  });
});
