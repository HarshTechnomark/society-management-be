import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Invitation, Resident, Tenancy, UnitResident, closeDb } from '../../../src/models';
import { kv } from '../../../src/lib/kv';
import { drainQueues } from '../../../src/lib/queue';
import { setNow } from '../../../src/lib/clock';
import { placeholderFiles } from '../../../src/modules/societies/societies.ports';
import { putPlaceholderFile } from '../../../src/modules/society-setup/society-setup.ports';
import { memberOf } from '../../helpers/society-setup';
import { addResident, idem, mobile, owner, residentSociety, resetResidents } from '../../helpers/residents';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetResidents);

const HEADER =
  'Flat,Relation,Name,Mobile,Email,Date of birth,Share %,Primary,Residing,From date,Agreement start,Agreement end,Maintenance payer';
const csv = (rows: string[]) => `${HEADER}\n${rows.join('\n')}\n`;

type W = Awaited<ReturnType<typeof residentSociety>>;
const upload = (w: W, content: string, o: { purpose?: string } = {}) =>
  putPlaceholderFile({
    societyId: w.society.id!,
    ownerUserId: w.user.id,
    name: 'residents.csv',
    content: Buffer.from(content),
    ...(o.purpose ? { purpose: o.purpose } : {}),
  });

async function run(w: W, content: string, mode: 'DRY_RUN' | 'COMMIT', extra: Record<string, unknown> = {}) {
  const start = await w.c(
    'post',
    '/residents/import',
    { fileId: upload(w, content), mode, ...extra },
    { headers: idem() },
  );
  expect(start.status, JSON.stringify(start.body)).toBe(202);
  expect(start.body.data).toMatchObject({ status: 'QUEUED' });
  expect(start.body.data.jobId).toMatch(/^imp_[0-9a-f]{8}$/);
  await drainQueues();
  const st = await w.c('get', `/residents/import/${start.body.data.jobId}`);
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const file = placeholderFiles.get(st.body.data.resultFileId)!;
  const lines = file.content
    .toString()
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n')
    .slice(1);
  return {
    status: st.body.data,
    jobId: start.body.data.jobId as string,
    results: lines.map(l => l.split(',').pop()!),
  };
}

describe('bulk import (8.12, BR-09-1 to 14)', () => {
  it('T09-45 a dry run reports an unknown flat and a bad mobile and creates nothing; the commit runs twice without duplicates', async () => {
    const w = await residentSociety({ flats: 4 });
    const content = csv([
      'A-101,OWNER,Ravi Shah,9820011121,ravi@mail.in,,,Y,Y,2019-04-01,,,',
      'A-102,OWNER,Meera Iyer,9820022122,,,,,,01/04/2020,,,',
      'ZZ-999,OWNER,Unknown Flat,9820033333,,,,,,,,,',
      'A-103,FAMILY,Bad Mobile,12345,,,,,,,,,',
    ]);
    const dry = await run(w, content, 'DRY_RUN');
    expect(dry.status).toMatchObject({
      status: 'COMPLETED',
      mode: 'DRY_RUN',
      totalRows: 4,
      okRows: 2,
      errorRows: 2,
    });
    expect(dry.results).toEqual(['OK', 'OK', 'UNIT_NOT_FOUND', 'VALIDATION_FAILED']);
    expect(await Resident.count({ where: { societyId: w.society.id! } })).toBe(0);
    expect(await UnitResident.count({ where: { societyId: w.society.id! } })).toBe(0);
    const first = await run(w, content, 'COMMIT');
    expect(first.status).toMatchObject({ okRows: 2, errorRows: 2 });
    expect(first.results).toEqual(['OK', 'OK', 'UNIT_NOT_FOUND', 'VALIDATION_FAILED']);
    const ravi = (await Resident.findOne({ where: { mobile: '9820011121' } }))!;
    expect([ravi.source, ravi.email]).toEqual(['IMPORT', 'ravi@mail.in']);
    expect(await UnitResident.findOne({ where: { residentId: ravi.id! } })).toMatchObject({
      relation: 'OWNER',
      isPrimary: true,
      fromDate: '2019-04-01',
      source: 'IMPORT',
    });
    expect(
      (await UnitResident.findOne({
        where: { residentId: (await Resident.findOne({ where: { mobile: '9820022122' } }))!.id! },
      }))!.fromDate,
    ).toBe('2020-04-01');
    const second = await run(w, content, 'COMMIT');
    expect(second.results).toEqual([
      'ALREADY_IMPORTED',
      'ALREADY_IMPORTED',
      'UNIT_NOT_FOUND',
      'VALIDATION_FAILED',
    ]);
    expect(await Resident.count({ where: { societyId: w.society.id! } })).toBe(2);
    expect(await UnitResident.count({ where: { societyId: w.society.id! } })).toBe(2);
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'residents.import.started' } }),
    ).toBe(3);
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'residents.import.completed' } }),
    ).toBe(3);
    // the result file never carries a full mobile number
    const file = [...placeholderFiles.values()].filter(f => f.name.startsWith('residents-import-')).pop()!;
    expect(file.content.toString()).not.toContain('9820011121');
  });

  it('applies the row rules: second owner, duplicate mobile with another name, co-owner shares, family without a mobile, rows of a rerun', async () => {
    const w = await residentSociety({ flats: 3 });
    const m = mobile();
    const res = await run(
      w,
      csv([
        'A-101,OWNER,Ravi Shah,9820011121,,,,,,2019-04-01,,,',
        'A-101,OWNER,Second Owner,9820044444,,,,,,,,,',
        `A-102,OWNER,Meera Iyer,${m},,,,,,,,,`,
        `A-103,OWNER,Someone Else,${m},,,,,,,,,`,
        'A-101,FAMILY,Anita Shah,,,1990-05-05,,,,,,,',
        'A-101,CARETAKER,Sunita Bai,,,,,,,,,,',
      ]),
      'COMMIT',
    );
    expect(res.results).toEqual(['OK', 'OWNER_ALREADY_EXISTS', 'OK', 'RESIDENT_MOBILE_EXISTS', 'OK', 'OK']);
    const fam = (await UnitResident.findAll({ where: { societyId: w.society.id!, relation: 'FAMILY' } }))[0]!;
    expect([fam.familyRelation, fam.tenancyId]).toEqual(['RELATIVE', null]);
    const again = await run(
      w,
      csv(['A-101,FAMILY,Anita Shah,,,1990-05-05,,,,,,,', 'A-101,CARETAKER,Sunita Bai,,,,,,,,,,']),
      'COMMIT',
    );
    expect(again.results).toEqual(['ALREADY_IMPORTED', 'ALREADY_IMPORTED']);
  });

  it('shares of one flat in the file are checked together: 60 and 40 are written, 60 and 30 refuse both rows', async () => {
    const w = await residentSociety({ flats: 3 });
    const res = await run(
      w,
      csv([
        'A-101,OWNER,Owner One,9820011121,,,60,Y,,2019-04-01,,,',
        'A-101,CO_OWNER,Owner Two,9820022122,,,40,,,2019-04-01,,,',
        'A-102,OWNER,Owner Three,9820033333,,,60,,,,,,',
        'A-102,CO_OWNER,Owner Four,9820044444,,,30,,,,,,',
      ]),
      'COMMIT',
    );
    expect(res.results).toEqual(['OK', 'OK', 'OWNERSHIP_SHARE_INVALID', 'OWNERSHIP_SHARE_INVALID']);
    const rows = await UnitResident.findAll({
      where: { societyId: w.society.id!, toDate: null },
      order: [['id', 'ASC']],
    });
    expect(rows.map(r => [r.relation, r.sharePercent, r.isPrimary])).toEqual([
      ['OWNER', '60.0000', true],
      ['CO_OWNER', '40.0000', false],
    ]);
  });

  it('TENANT rows become ACTIVE tenancies (source IMPORT, police NOT_SUBMITTED) and need an owner and valid dates', async () => {
    const w = await residentSociety({ flats: 5 });
    const res = await run(
      w,
      csv([
        'A-101,OWNER,Ravi Shah,9820011121,,,,,,2019-04-01,,,',
        'A-101,TENANT,Neha Verma,9820055555,,,,,,,2026-10-01,2027-09-30,TENANT',
        'A-102,TENANT,No Owner Tenant,9820066666,,,,,,,2026-10-01,2027-09-30,',
        'A-103,OWNER,Meera Iyer,9820077777,,,,,,,,,',
        'A-103,TENANT,Bad Dates,9820088888,,,,,,,2027-09-30,2026-10-01,',
        'A-103,TENANT,Long Tenancy,9820099999,,,,,,,2026-10-01,2033-10-01,',
        'A-101,TENANT,Second Tenant,9820012345,,,,,,,2026-10-01,2027-09-30,',
        'A-103,TENANT,Future Tenant,9820023456,,,,,,,2026-12-01,2027-11-30,',
      ]),
      'COMMIT',
    );
    expect(res.results).toEqual([
      'OK',
      'OK',
      'OWNER_REQUIRED',
      'OK',
      'TENANCY_DATES_INVALID',
      'TENANCY_DATES_INVALID',
      'TENANCY_ALREADY_ACTIVE',
      'OK',
    ]);
    const tenancies = await Tenancy.findAll({ where: { societyId: w.society.id! }, order: [['id', 'ASC']] });
    expect(tenancies.map(t => [t.status, t.source, t.policeVerificationStatus, t.maintenancePayer])).toEqual([
      ['ACTIVE', 'IMPORT', 'NOT_SUBMITTED', 'TENANT'],
      ['APPROVED', 'IMPORT', 'NOT_SUBMITTED', 'OWNER'],
    ]);
    const neha = (await Resident.findOne({ where: { mobile: '9820055555' } }))!;
    const tl = (await UnitResident.findOne({ where: { residentId: neha.id!, relation: 'TENANT' } }))!;
    expect([tl.tenancyId, tl.isResiding, tl.fromDate]).toEqual([tenancies[0]!.id, true, '2026-10-01']);
    const future = (await UnitResident.findOne({ where: { tenancyId: tenancies[1]!.id! } }))!;
    expect(future.isResiding).toBe(false);
  });

  it('inviteAll invites every new resident with a mobile after the commit', async () => {
    const w = await residentSociety({ flats: 2 });
    await run(
      w,
      csv(['A-101,OWNER,Ravi Shah,9820011121,,,,,,,,,', 'A-102,OWNER,No Phone,,,,,,,,,,']),
      'COMMIT',
      { inviteAll: true },
    );
    expect(await Invitation.count({ where: { societyId: w.society.id!, status: 'PENDING' } })).toBe(1);
  });

  it('refuses a file with missing columns (IMPORT_FORMAT_INVALID), too many rows (IMPORT_TOO_LARGE), another purpose, another society and a second running import', async () => {
    const w = await residentSociety();
    const other = await residentSociety({ name: 'Other CHS' });
    const post = (b: Record<string, unknown>) =>
      w.c('post', '/residents/import', { mode: 'DRY_RUN', ...b }, { headers: idem() });
    const noName = await post({ fileId: upload(w, 'Flat,Relation,Mobile\nA-101,OWNER,9820011121\n') });
    expect([noName.status, noName.body.code]).toEqual([422, 'IMPORT_FORMAT_INVALID']);
    const big = await post({
      fileId: upload(w, csv(Array.from({ length: 5001 }, () => 'A-101,FAMILY,Some Name,,,,,,,,,,'))),
    });
    expect([big.status, big.body.code]).toEqual([422, 'IMPORT_TOO_LARGE']);
    const wrong = await post({ fileId: upload(w, csv([]), { purpose: 'KYC_DOCUMENT' }) });
    expect([wrong.status, wrong.body.code]).toEqual([422, 'FILE_NOT_LINKABLE']);
    const foreign = await post({ fileId: upload(other, csv([])) });
    expect([foreign.status, foreign.body.code]).toEqual([404, 'FILE_NOT_FOUND']);
    await kv().setIfAbsent(`res:import-lock:${w.society.id}`, 'busy', 60);
    const running = await post({ fileId: upload(w, csv(['A-101,OWNER,Ravi Shah,9820011121,,,,,,,,,'])) });
    expect([running.status, running.body.code]).toEqual([409, 'IMPORT_RUNNING']);
    await kv().cacheDel(`res:import-lock:${w.society.id}`);
    expect((await post({ fileId: 1, mode: 'LATER' })).status).toBe(400);
    expect((await w.c('post', '/residents/import', { fileId: 1, mode: 'COMMIT' })).status).toBe(400); // key required
  });

  it('only the admin who started a job reads it (404 IMPORT_JOB_NOT_FOUND); an accountant cannot import (403)', async () => {
    const w = await residentSociety();
    const r = await run(w, csv(['A-101,OWNER,Ravi Shah,9820011121,,,,,,,,,']), 'DRY_RUN');
    const sa = await memberOf(w.society, 'society_admin');
    const peek = await sa.c('get', `/residents/import/${r.jobId}`);
    expect([peek.status, peek.body.code]).toEqual([404, 'IMPORT_JOB_NOT_FOUND']);
    expect((await w.c('get', '/residents/import/imp_00000000')).body.code).toBe('IMPORT_JOB_NOT_FOUND');
    expect((await w.c('get', '/residents/import/nonsense')).status).toBe(400);
    const acc = await memberOf(w.society, 'accountant');
    expect(
      (await acc.c('post', '/residents/import', { fileId: 1, mode: 'DRY_RUN' }, { headers: idem() })).body
        .code,
    ).toBe('PERMISSION_DENIED');
    setNow('2026-11-01T04:30:00Z');
  });
});

describe('CSV export (8.12)', () => {
  it('exports one row per open link with the documented columns, audited, and needs a recent sign-in', async () => {
    const w = await residentSociety({ flats: 2 });
    await addResident(w.c, {
      name: 'Ravi Shah',
      mobile: '9820011121',
      email: 'ravi@mail.in',
      link: owner(w.unit(1).id),
    });
    await addResident(w.c, { name: 'No Link Person', mobile: '9820022122' });
    const r = await w.c('get', '/residents/export');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ rowCount: 2 });
    expect(r.body.data.downloadUrl).toMatch(/\/api\/v1\/dev\/files\//);
    const file = placeholderFiles.get(r.body.data.fileId)!;
    const lines = file.content
      .toString()
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Resident id,Name,Mobile,Email,Flat,Relation,Share %,Primary,Residing,From,To,Has login,KYC status',
    );
    expect(lines[1]).toMatch(/^\d+,No Link Person,9820022122,,,,,,,,,N,NONE$/);
    expect(lines[2]).toMatch(
      /^\d+,Ravi Shah,9820011121,ravi@mail.in,A-101,OWNER,100.00,Y,Y,2019-04-01,,N,NONE$/,
    );
    const log = (await AuditLog.findOne({
      where: { societyId: w.society.id!, action: 'residents.resident.exported' },
    }))!;
    expect(log.after).toMatchObject({ rowCount: 2 });
    const filtered = await w.c('get', '/residents/export', undefined, { query: { relation: 'OWNER' } });
    expect(filtered.body.data.rowCount).toBe(1);
    setNow('2026-11-01T04:37:00Z');
    const stale = await w.c('get', '/residents/export');
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
  });

  it('is limited to 10 exports an hour per user (429)', async () => {
    const w = await residentSociety({ flats: 1 });
    for (let i = 0; i < 10; i++) expect((await w.c('get', '/residents/export')).status).toBe(200);
    const r = await w.c('get', '/residents/export');
    expect([r.status, r.body.code]).toEqual([429, 'RATE_LIMITED']);
  });
});
