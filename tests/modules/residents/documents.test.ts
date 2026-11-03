import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, JoinRequest, ResidentDocument, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { residentPortCalls } from '../../../src/modules/residents/residents.ports';
import { activeGrant, enterAsSupport, platformAs } from '../../helpers/societies';
import { memberOf } from '../../helpers/society-setup';
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

async function withDoc(
  o: { docType?: string; purpose?: 'KYC_DOCUMENT' | 'RESIDENT_RECORD'; plan?: 'PREMIUM' } = {},
) {
  const w = await residentSociety();
  const admin = await memberOf(w.society, 'society_admin');
  const r = await addResident(w.c, { name: 'Ravi Shah', mobile: mobile(), link: owner(w.unit(1).id) });
  const docType = o.docType ?? 'AADHAAR';
  const fileId = docFile(w.society.id!, admin.user.id, o.purpose ?? 'KYC_DOCUMENT');
  const d = await admin.c(
    'post',
    `/residents/${r.id}/documents`,
    { fileId, docType, ...(docType === 'AADHAAR' ? { idLast4: '1234' } : {}) },
    { headers: idem() },
  );
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  return { ...w, admin, resident: r, doc: d.body.data, fileId };
}

describe('documents (BR-09-37 to BR-09-39, 8.11)', () => {
  it('uploads a KYC document with the last 4 characters only; the response is metadata, never the file or a number', async () => {
    const w = await withDoc();
    expect(w.doc).toMatchObject({
      docType: 'AADHAAR',
      idLast4: '1234',
      verificationStatus: 'PENDING',
      residentId: w.resident.id,
    });
    expect(Object.keys(w.doc)).not.toContain('fileId');
    const list = await w.c('get', `/residents/${w.resident.id}/documents`);
    expect(list.body.data).toHaveLength(1);
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'residents.document.uploaded' } }),
    ).toBe(1);
    const detail = await w.c('get', `/residents/${w.resident.id}`);
    expect(detail.body.data.kycStatus).toBe('PENDING');
    expect(detail.body.data.documents).toHaveLength(1);
  });

  it('refuses a wrong purpose or another uploader (422 FILE_NOT_LINKABLE), a long ID number, an ID number on a non-ID document and OTHER without a title', async () => {
    const w = await residentSociety();
    const r = await addResident(w.c, { name: 'Ravi Shah', link: owner(w.unit(1).id) });
    const post = (b: Record<string, unknown>) =>
      w.c('post', `/residents/${r.id}/documents`, b, { headers: idem() });
    const wrongPurpose = docFile(w.society.id!, w.user.id, 'RESIDENT_RECORD');
    const a = await post({ fileId: wrongPurpose, docType: 'PAN' });
    expect([a.status, a.body.code]).toEqual([422, 'FILE_NOT_LINKABLE']);
    const other = docFile(w.society.id!, w.user.id + 999, 'KYC_DOCUMENT');
    expect((await post({ fileId: other, docType: 'PAN' })).body.code).toBe('FILE_NOT_LINKABLE');
    const f = () => docFile(w.society.id!, w.user.id, 'KYC_DOCUMENT');
    expect((await post({ fileId: f(), docType: 'AADHAAR', idLast4: '123456789012' })).status).toBe(400);
    const rr = docFile(w.society.id!, w.user.id, 'RESIDENT_RECORD');
    const noId = await post({ fileId: rr, docType: 'RENT_AGREEMENT', idLast4: '1234' });
    expect([noId.status, noId.body.code]).toEqual([422, 'DOCUMENT_TYPE_NOT_ALLOWED']);
    const noTitle = await post({ fileId: rr, docType: 'OTHER' });
    expect([noTitle.status, noTitle.body.code]).toEqual([422, 'DOCUMENT_TYPE_NOT_ALLOWED']);
    expect((await post({ fileId: rr, docType: 'RENT_AGREEMENT' })).status).toBe(201);
    const reuse = await post({ fileId: rr, docType: 'RENT_AGREEMENT' });
    expect(reuse.status).toBeGreaterThanOrEqual(400);
  });

  it('BR-09-39 verify needs approve permission and a different person from the uploader; a rejection needs a reason and is final', async () => {
    const w = await withDoc();
    const self = await w.admin.c('post', `/resident-documents/${w.doc.id}/verify`, {
      decision: 'VERIFIED',
      version: 1,
    });
    expect([self.status, self.body.code]).toEqual([403, 'PERMISSION_DENIED']); // society_admin does not hold approve
    const noReason = await w.c('post', `/resident-documents/${w.doc.id}/verify`, {
      decision: 'REJECTED',
      version: 1,
    });
    expect(noReason.status).toBe(400);
    const stale = await w.c('post', `/resident-documents/${w.doc.id}/verify`, {
      decision: 'VERIFIED',
      version: 7,
    });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const ok = await w.c('post', `/resident-documents/${w.doc.id}/verify`, {
      decision: 'VERIFIED',
      version: 1,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.verificationStatus).toBe('VERIFIED');
    const again = await w.c('post', `/resident-documents/${w.doc.id}/verify`, {
      decision: 'VERIFIED',
      version: 2,
    });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await w.c('get', `/residents/${w.resident.id}`)).body.data.kycStatus).toBe('VERIFIED');
    expect(
      (await w.c('get', '/residents', undefined, { query: { kycStatus: 'VERIFIED' } })).body.data,
    ).toHaveLength(1);
  });

  it('BR-09-39 the uploader cannot verify their own upload (409 MAKER_CHECKER_VIOLATION); a rejection stores the reason', async () => {
    const w = await residentSociety();
    const r = await addResident(w.c, { name: 'Ravi Shah', link: owner(w.unit(1).id) });
    const up = await w.c(
      'post',
      `/residents/${r.id}/documents`,
      { fileId: docFile(w.society.id!, w.user.id), docType: 'PAN', idLast4: 'ABCD' },
      { headers: idem() },
    );
    const own = await w.c('post', `/resident-documents/${up.body.data.id}/verify`, {
      decision: 'VERIFIED',
      version: 1,
    });
    expect([own.status, own.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    const w2 = await withDoc();
    const rej = await w2.c('post', `/resident-documents/${w2.doc.id}/verify`, {
      decision: 'REJECTED',
      reason: 'The photo is blurred',
      version: 1,
    });
    expect(rej.body.data).toMatchObject({
      verificationStatus: 'REJECTED',
      rejectReason: 'The photo is blurred',
    });
    expect(await AuditLog.count({ where: { action: 'residents.document.rejected' } })).toBe(1);
  });

  it('T09-48 a committee member (people.view without contacts.view) gets 404 DOCUMENT_NOT_FOUND for a KYC download; the chairman gets a short-lived URL and an audit row', async () => {
    const w = await withDoc();
    const cm = await memberOf(w.society, 'committee_member');
    const denied = await cm.c('get', `/resident-documents/${w.doc.id}/download-url`);
    expect([denied.status, denied.body.code]).toEqual([404, 'DOCUMENT_NOT_FOUND']);
    const ok = await w.c('get', `/resident-documents/${w.doc.id}/download-url`, undefined, {
      query: { disposition: 'inline' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.url).toMatch(/\/api\/v1\/dev\/files\//);
    expect(new Date(ok.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now() - 10 * 365 * 86_400_000);
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'residents.document.downloaded' } }),
    ).toBe(1);
    expect(
      (
        await w.c('get', `/resident-documents/${w.doc.id}/download-url`, undefined, {
          query: { disposition: 'x' },
        })
      ).status,
    ).toBe(400);
    expect((await w.c('get', '/resident-documents/999999/download-url')).body.code).toBe(
      'DOCUMENT_NOT_FOUND',
    );
  });

  it('BR-09-38 a request document (RESIDENT_RECORD) is downloadable by the uploader, an owner or tenant of the unit and people.view holders; a neighbour gets 404', async () => {
    const w = await residentSociety({ flats: 3 });
    const ownerLogin = await residentUser(w.society, w.unit(1).id, { name: 'Owner Login' });
    const neighbour = await residentUser(w.society, w.unit(2).id, { name: 'Neighbour Login' });
    const file = docFile(w.society.id!, w.user.id, 'RESIDENT_RECORD');
    const up = await w.c(
      'post',
      `/residents/${ownerLogin.resident.id}/documents`,
      { fileId: file, docType: 'NOC', unitId: w.unit(1).id },
      { headers: idem() },
    );
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const url = `/resident-documents/${up.body.data.id}/download-url`;
    expect((await w.c('get', url)).status).toBe(200);
    expect((await ownerLogin.c('get', url)).status).toBe(200);
    expect((await neighbour.c('get', url)).body.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('T09-49 a support grant gets 403 SUPPORT_ROUTE_FORBIDDEN on the raw document routes', async () => {
    const w = await withDoc();
    const agent = await platformAs('platform_support');
    const rw = await enterAsSupport(
      agent.cookies,
      (await activeGrant(w.society.id!, agent.user.id, 'READ_WRITE')).id!,
    );
    for (const path of [
      `/resident-documents/${w.doc.id}/download-url`,
      '/residents/export',
      '/residents/import/imp_00000000',
    ]) {
      const r = await rw.c('get', path);
      expect([r.status, r.body.code], path).toEqual([403, 'SUPPORT_ROUTE_FORBIDDEN']);
    }
    const imp = await rw.c('post', '/residents/import', { fileId: 1, mode: 'DRY_RUN' }, { headers: idem() });
    expect(imp.body.code).toBe('SUPPORT_ROUTE_FORBIDDEN');
  });

  it('own documents: a resident uploads ID types only, sees them, downloads them; others see 404', async () => {
    const w = await residentSociety();
    const me = await residentUser(w.society, w.unit(1).id, { name: 'Owner Login' });
    const other = await residentUser(w.society, w.unit(2).id, { name: 'Other Login' });
    const post = (b: Record<string, unknown>) => me.c('post', '/me/documents', b, { headers: idem() });
    const rent = await post({
      fileId: docFile(w.society.id!, me.user.id, 'RESIDENT_RECORD'),
      docType: 'RENT_AGREEMENT',
    });
    expect(rent.status).toBe(400);
    const ok = await post({
      fileId: docFile(w.society.id!, me.user.id),
      docType: 'AADHAAR',
      idLast4: '4321',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const withUnit = await post({
      fileId: docFile(w.society.id!, me.user.id),
      docType: 'PAN',
      unitId: w.unit(2).id,
    });
    expect([withUnit.status, withUnit.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    expect((await me.c('get', '/me/documents')).body.data).toHaveLength(1);
    expect((await me.c('get', `/me/documents/${ok.body.data.id}/download-url`)).status).toBe(200);
    expect((await other.c('get', `/me/documents/${ok.body.data.id}/download-url`)).body.code).toBe(
      'DOCUMENT_NOT_FOUND',
    );
    expect((await other.c('get', '/me/documents')).body.data).toEqual([]);
  });

  it('deleting a document needs a reason, unlinks the file, and is refused while a pending request holds it (409 DOCUMENT_IN_USE)', async () => {
    const w = await withDoc();
    expect((await w.c('delete', `/resident-documents/${w.doc.id}`, { reason: 'no' })).status).toBe(400);
    await ResidentDocument.update({ refType: 'join_request', refId: 77 }, { where: { id: w.doc.id } });
    await JoinRequest.create({
      id: 77,
      societyId: w.society.id!,
      userId: w.user.id,
      unitId: w.unit(1).id,
      relation: 'FAMILY',
      familyRelation: 'SPOUSE',
      householdOf: 'OWNER',
      name: 'Pending Person',
      mobile: mobile(),
      status: 'PENDING_ADMIN',
      expiresAt: new Date('2026-11-10T00:00:00Z'),
    } as never);
    const busy = await w.c('delete', `/resident-documents/${w.doc.id}`, {
      reason: 'Uploaded twice by mistake',
    });
    expect([busy.status, busy.body.code]).toEqual([409, 'DOCUMENT_IN_USE']);
    await JoinRequest.update({ status: 'WITHDRAWN' }, { where: { id: 77 } });
    residentPortCalls.length = 0;
    const gone = await w.c('delete', `/resident-documents/${w.doc.id}`, {
      reason: 'Uploaded twice by mistake',
    });
    expect(gone.status).toBe(204);
    expect(await ResidentDocument.count({ where: { id: w.doc.id } })).toBe(0);
    await new Promise(r => setTimeout(r, 20));
    expect(residentPortCalls.filter(x => x.fn === 'files.deleteFile').map(x => x.input)).toEqual([
      { fileId: w.fileId },
    ]);
  });
});
