import ExcelJS from 'exceljs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, Building, Unit, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { kv } from '../../../src/lib/kv';
import { placeholderFiles } from '../../../src/modules/societies/societies.ports';
import {
  putPlaceholderFile,
  setSetupPorts,
  welcomeInviteCalls,
} from '../../../src/modules/society-setup/society-setup.ports';
import { registerGoLiveHook } from '../../../src/modules/society-setup/society-setup.onboarding.service';
import { queueGoLiveInvites, runGoLiveInvites } from '../../../src/modules/society-setup/society-setup.jobs';
import { escapeCsvInjection, toCsv } from '../../../src/modules/society-setup/society-setup.csv';
import { events, inboxFor } from '../../helpers/auth';
import {
  flatsUsed,
  idemKey,
  makeBuilding,
  makeUnit,
  memberOf,
  resetSetup,
  setupSociety,
} from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetSetup();
  events.length = 0;
  welcomeInviteCalls.length = 0;
});

type Client = Awaited<ReturnType<typeof setupSociety>>['c'];
const HEADER = 'Building,Flat No,Floor,Type,Carpet,Notes';
const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join('\n'), 'utf8');

const upload = (
  s: { society: { id?: number }; user: { id?: number } },
  content: Buffer,
  name = 'flats.csv',
) => putPlaceholderFile({ societyId: s.society.id!, ownerUserId: s.user.id!, name, content });
async function startImport(
  s: Awaited<ReturnType<typeof setupSociety>>,
  content: Buffer,
  o: { mode?: string; createMissingBuildings?: boolean; name?: string } = {},
) {
  const fileId = upload(s, content, o.name);
  const r = await s.c(
    'post',
    '/units/imports',
    { fileId, mode: o.mode ?? 'CREATE_ONLY', createMissingBuildings: o.createMissingBuildings ?? false },
    { headers: idemKey() },
  );
  return r;
}
async function dryRun(s: Awaited<ReturnType<typeof setupSociety>>, content: Buffer, o = {}) {
  const r = await startImport(s, content, o);
  expect(r.status).toBe(202);
  await drainQueues();
  const g = await s.c('get', `/units/imports/${r.body.data.importId}`);
  return g.body.data as any;
}
const commit = async (c: Client, importId: number, commitPolicy: string) => {
  const r = await c('post', `/units/imports/${importId}/commit`, { commitPolicy }, { headers: idemKey() });
  await drainQueues();
  return r;
};
const status = async (c: Client, importId: number) =>
  (await c('get', `/units/imports/${importId}`)).body.data as any;
const audits = (societyId: number, action: string) => AuditLog.findAll({ where: { societyId, action } });
const readFile = (id: number) => placeholderFiles.get(id)!.content.toString('utf8');

async function withBuilding(o: { plan?: 'STARTER' | 'STANDARD'; flats?: number } = {}) {
  const s = await setupSociety(o);
  const b = await makeBuilding(s.c, { code: 'A', floorsAboveGround: 20 });
  return { ...s, b };
}

/** Holds the validation job until `release()` so the VALIDATING state can be observed. */
function holdValidation(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(res => (release = res));
  const seen = new Set<number>();
  setSetupPorts({
    files: {
      getImportFile: async (societyId, userId, fileId) => {
        // the route reads the file first (answers at once), the job reads it second (waits)
        if (seen.has(fileId)) await gate;
        seen.add(fileId);
        const f = placeholderFiles.get(fileId)!;
        if (f.societyId !== societyId || f.ownerUserId !== userId) throw new Error('file');
        return { fileId, name: f.name, contentType: f.contentType, content: f.content };
      },
    },
  });
  return { release };
}

describe('POST /units/imports (8.15) and the dry run', () => {
  it('202 VALIDATING, then VALIDATED with counts, the row total and the realtime event', async () => {
    const s = await withBuilding();
    const r = await startImport(s, csv('A,101,1,Flat,900,', 'A,102,1,Flat,950,'));
    expect(r.status).toBe(202);
    expect(r.body.data).toEqual({ importId: expect.any(Number), status: 'VALIDATING' });
    await drainQueues();
    const d = await status(s.c, r.body.data.importId);
    expect(d).toMatchObject({
      status: 'VALIDATED',
      mode: 'CREATE_ONLY',
      fileName: 'flats.csv',
      totalRows: 2,
      counts: { create: 2, update: 0, unchanged: 0, error: 0 },
      errorsPreview: [],
      reportFileId: null,
      commitPolicy: null,
      result: null,
    });
    expect(Date.parse(d.expiresAt) - Date.parse(d.createdAt)).toBe(24 * 3600_000);
    expect(events.some(e => e.event === 'setup.import.updated' && e.payload.status === 'VALIDATED')).toBe(
      true,
    );
    expect(await Unit.count({ where: { societyId: s.society.id! } })).toBe(0);
  });

  it('file errors: unknown file, someone else file, not scanned, wrong purpose', async () => {
    const s = await withBuilding();
    const post = (fileId: number) =>
      s.c('post', '/units/imports', { fileId, mode: 'CREATE_ONLY' }, { headers: idemKey() });
    expect((await post(999999)).body.code).toBe('FILE_NOT_FOUND');
    const other = await memberOf(s.society, 'secretary');
    const theirs = putPlaceholderFile({
      societyId: s.society.id!,
      ownerUserId: other.user.id!,
      name: 'x.csv',
      content: csv(),
    });
    expect((await post(theirs)).body.code).toBe('FILE_NOT_FOUND');
    const pending = putPlaceholderFile({
      societyId: s.society.id!,
      ownerUserId: s.user.id!,
      name: 'x.csv',
      content: csv(),
      scan: 'PENDING',
    });
    expect([(await post(pending)).status, (await post(pending)).body.code]).toEqual([
      409,
      'IMPORT_FILE_NOT_READY',
    ]);
    const logo = putPlaceholderFile({
      societyId: s.society.id!,
      ownerUserId: s.user.id!,
      name: 'x.png',
      content: csv(),
      purpose: 'SOCIETY_LOGO',
    });
    expect([(await post(logo)).status, (await post(logo)).body.code]).toEqual([422, 'FILE_NOT_LINKABLE']);
  });

  it('BR-08-33 a bad file ends FAILED: empty, missing required header, too many rows', async () => {
    const s = await withBuilding();
    const empty = await dryRun(s, Buffer.from(''));
    expect([empty.status, empty.result.failureCode]).toEqual(['FAILED', 'IMPORT_FILE_INVALID']);
    const noUnit = await dryRun(s, Buffer.from('Building,Floor\nA,1\n'));
    expect([noUnit.status, noUnit.result.failureCode]).toEqual(['FAILED', 'IMPORT_FILE_INVALID']);
    const many = await dryRun(
      s,
      Buffer.from([HEADER, ...Array.from({ length: 5001 }, (_, i) => `A,${1000 + i},1,Flat,,`)].join('\n')),
    );
    expect([many.status, many.result.failureCode]).toEqual(['FAILED', 'IMPORT_TOO_MANY_ROWS']);
    expect(await kv().cacheGet(`ss:import-lock:${s.society.id}`)).toBeNull();
  });

  it('BR-08-33 reads an XLSX file, formulas as their cached value', async () => {
    const s = await withBuilding();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Flats');
    ws.addRow(['Tower', 'Flat', 'Floor', 'Carpet']);
    ws.addRow(['A', '301', 3, { formula: '100*9', result: 900 }]);
    ws.addRow(['A', '302', 3, 910]);
    const content = Buffer.from(await wb.xlsx.writeBuffer());
    const d = await dryRun(s, content, { name: 'flats.xlsx' });
    expect(d).toMatchObject({ status: 'VALIDATED', counts: { create: 2, error: 0 } });
    await commit(s.c, d.importId, 'ALL_OR_NOTHING');
    const u = await Unit.findOne({ where: { societyId: s.society.id!, unitNumber: '301' } });
    expect(u!.carpetAreaSqft).toBe('900.000');
  });

  it('row codes: REQUIRED, INVALID_NUMBER, INVALID_ENUM, UNKNOWN_BUILDING, DUPLICATE_IN_FILE, FLOOR_OUT_OF_RANGE, UNIT_EXISTS', async () => {
    const s = await withBuilding();
    await makeUnit(s.c, s.b.id, '101', 1);
    const d = await dryRun(
      s,
      csv(
        'A,,1,Flat,900,',
        'A,102,1,Flat,eight fifty,',
        'A,103,1,Villa,,',
        'Z,104,1,Flat,,',
        'A,105,1,Flat,,',
        'A,105,1,Flat,,',
        'A,106,99,Flat,,',
        'A,101,1,Flat,,',
        'A,107,1,Flat,,',
      ),
    );
    expect(d.totalRows).toBe(9);
    expect(d.counts).toEqual({ create: 2, update: 0, unchanged: 0, error: 7 });
    expect(d.errorsPreview.map((e: any) => [e.row, e.code])).toEqual([
      [2, 'REQUIRED'],
      [3, 'INVALID_NUMBER'],
      [4, 'INVALID_ENUM'],
      [5, 'UNKNOWN_BUILDING'],
      [7, 'DUPLICATE_IN_FILE'],
      [8, 'FLOOR_OUT_OF_RANGE'],
      [9, 'UNIT_EXISTS'],
    ]);
    expect(d.errorsPreview[2]).toMatchObject({ column: 'Type', value: 'Villa' });
    expect(typeof d.reportFileId).toBe('number');
    expect(d.errorsPreview[4].message).toContain('row 6');
  });

  it('BR-08-34 UPSERT updates changed columns, keeps empty cells, marks identical rows UNCHANGED', async () => {
    const s = await withBuilding();
    await makeUnit(s.c, s.b.id, '101', 1, { carpetAreaSqft: '900', notes: 'keep me' });
    await makeUnit(s.c, s.b.id, '102', 1, { carpetAreaSqft: '800' });
    const d = await dryRun(s, csv('A,101,1,Flat,950,', 'A,102,1,Flat,800,', 'A,103,1,Flat,700,'), {
      mode: 'UPSERT',
    });
    expect(d.counts).toEqual({ create: 1, update: 1, unchanged: 1, error: 0 });
    const r = await commit(s.c, d.importId, 'ALL_OR_NOTHING');
    expect([r.status, r.body.data]).toEqual([202, { importId: d.importId, status: 'COMMITTING' }]);
    const after = await status(s.c, d.importId);
    expect(after).toMatchObject({
      status: 'COMMITTED',
      commitPolicy: 'ALL_OR_NOTHING',
      result: { written: 2, skipped: 1, failureCode: null },
    });
    const u = await Unit.findOne({ where: { societyId: s.society.id!, unitNumber: '101' } });
    expect([u!.carpetAreaSqft, u!.notes, u!.version]).toEqual(['950.000', 'keep me', 2]);
    expect((await audits(s.society.id!, 'setup.unit.updated')).length).toBe(1);
    expect((await audits(s.society.id!, 'setup.import.committed')).length).toBe(1);
  });

  it('BR-08-34 rows beyond the remaining limit.flats are LIMIT_EXCEEDED in file order', async () => {
    const s = await withBuilding({ plan: 'STARTER', flats: 298 });
    const d = await dryRun(s, csv('A,101,1,Flat,,', 'A,102,1,Flat,,', 'A,103,1,Flat,,'));
    expect(d.counts).toEqual({ create: 2, update: 0, unchanged: 0, error: 1 });
    expect(d.errorsPreview[0]).toMatchObject({ row: 4, code: 'LIMIT_EXCEEDED' });
    const r = await commit(s.c, d.importId, 'VALID_ROWS_ONLY');
    expect(r.status).toBe(202);
    expect(await flatsUsed(s.society.id!)).toBe(300);
    expect(await Unit.count({ where: { societyId: s.society.id! } })).toBe(2);
  });

  it('createMissingBuildings makes a TOWER named "Tower <code>" at commit, not at the dry run', async () => {
    const s = await withBuilding();
    const d = await dryRun(s, csv('Q,101,2,Flat,,'), { createMissingBuildings: true });
    expect(d.counts.create).toBe(1);
    expect(await Building.count({ where: { societyId: s.society.id!, code: 'Q' } })).toBe(0);
    await commit(s.c, d.importId, 'ALL_OR_NOTHING');
    const q = await Building.findOne({ where: { societyId: s.society.id!, code: 'Q' } });
    expect([q!.name, q!.kind]).toEqual(['Tower Q', 'TOWER']);
    expect(await Unit.count({ where: { societyId: s.society.id!, buildingId: q!.id! } })).toBe(1);
  });
});

describe('commit rules (8.17, BR-08-35, BR-08-36)', () => {
  const rows312 = () =>
    csv(
      ...Array.from({ length: 312 }, (_, i) => {
        const bad = [10, 50, 100, 200, 300].includes(i);
        return `A,${1000 + i},${1 + (i % 20)},Flat,${bad ? 'eight fifty' : 800 + (i % 50)},`;
      }),
    );

  it('T08-21 312 rows with 5 errors, VALID_ROWS_ONLY: COMMITTED_PARTIAL, 307 written, report has the 5 error rows', async () => {
    const s = await withBuilding();
    const d = await dryRun(s, rows312());
    expect([d.totalRows, d.counts]).toEqual([312, { create: 307, update: 0, unchanged: 0, error: 5 }]);
    expect(d.errorsPreview).toHaveLength(5);
    const r = await commit(s.c, d.importId, 'VALID_ROWS_ONLY');
    expect(r.status).toBe(202);
    const after = await status(s.c, d.importId);
    expect(after.status).toBe('COMMITTED_PARTIAL');
    expect(after.result).toEqual({ written: 307, skipped: 5, failureCode: null });
    expect(await Unit.count({ where: { societyId: s.society.id! } })).toBe(307);
    expect(await flatsUsed(s.society.id!)).toBe(307);
    const report = readFile(after.reportFileId).split('\r\n').filter(Boolean);
    expect(report).toHaveLength(6);
    expect(report[1]).toContain('INVALID_NUMBER');
    expect(
      events.some(e => e.event === 'setup.import.updated' && e.payload.status === 'COMMITTED_PARTIAL'),
    ).toBe(true);
    const sum = (await audits(s.society.id!, 'setup.import.committed'))[0]!;
    expect(JSON.stringify(sum.after)).toContain('307');
  });

  it('T08-22 ALL_OR_NOTHING with errors: 422 IMPORT_HAS_ERRORS and nothing written, import stays VALIDATED', async () => {
    const s = await withBuilding();
    const d = await dryRun(s, csv('A,101,1,Flat,,', 'A,102,1,Flat,xx,'));
    const r = await commit(s.c, d.importId, 'ALL_OR_NOTHING');
    expect([r.status, r.body.code]).toEqual([422, 'IMPORT_HAS_ERRORS']);
    expect(await Unit.count({ where: { societyId: s.society.id! } })).toBe(0);
    expect((await status(s.c, d.importId)).status).toBe('VALIDATED');
  });

  it('T08-23 a unit created by someone else between dry run and commit: FAILED IMPORT_STALE, nothing written', async () => {
    const s = await withBuilding();
    const d = await dryRun(s, csv('A,101,1,Flat,,', 'A,102,1,Flat,,'));
    await makeUnit(s.c, s.b.id, '102', 1);
    await commit(s.c, d.importId, 'ALL_OR_NOTHING');
    const after = await status(s.c, d.importId);
    expect(after.status).toBe('FAILED');
    expect(after.result).toMatchObject({ written: 0, failureCode: 'IMPORT_STALE' });
    expect(await Unit.count({ where: { societyId: s.society.id! } })).toBe(1);
    expect(await kv().cacheGet(`ss:import-lock:${s.society.id}`)).toBeNull();
  });

  it('BR-08-36 VALID_ROWS_ONLY skips a row that went stale and reports it', async () => {
    const s = await withBuilding();
    const d = await dryRun(s, csv('A,101,1,Flat,,', 'A,102,1,Flat,,'));
    await makeUnit(s.c, s.b.id, '102', 1);
    await commit(s.c, d.importId, 'VALID_ROWS_ONLY');
    const after = await status(s.c, d.importId);
    expect(after.status).toBe('COMMITTED_PARTIAL');
    expect(after.result).toMatchObject({ written: 1, skipped: 1 });
    expect(after.errorsPreview[0].code).toBe('UNIT_EXISTS');
  });

  it('T08-24 a second import while one is VALIDATING: 409 IMPORT_IN_PROGRESS (and after it ends a new one is accepted)', async () => {
    const s = await withBuilding();
    const hold = holdValidation();
    const first = await startImport(s, csv('A,101,1,Flat,,'));
    expect(first.status).toBe(202);
    const second = await startImport(s, csv('A,102,1,Flat,,'));
    expect([second.status, second.body.code]).toEqual([409, 'IMPORT_IN_PROGRESS']);
    hold.release();
    await drainQueues();
    setSetupPorts();
    expect((await startImport(s, csv('A,102,1,Flat,,'))).status).toBe(202);
  });

  it('commit while another import holds the lock: 409 IMPORT_IN_PROGRESS', async () => {
    const s = await withBuilding();
    const d = await dryRun(s, csv('A,101,1,Flat,,'));
    await kv().setIfAbsent(`ss:import-lock:${s.society.id}`, '999', 3600);
    const r = await s.c(
      'post',
      `/units/imports/${d.importId}/commit`,
      { commitPolicy: 'ALL_OR_NOTHING' },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([409, 'IMPORT_IN_PROGRESS']);
  });

  it('commit states: INVALID_STATE unless VALIDATED, IMPORT_NOTHING_TO_COMMIT, a second commit is INVALID_STATE', async () => {
    const s = await withBuilding();
    const hold = holdValidation();
    const started = await startImport(s, csv('A,101,1,Flat,,'));
    const early = await s.c(
      'post',
      `/units/imports/${started.body.data.importId}/commit`,
      { commitPolicy: 'VALID_ROWS_ONLY' },
      { headers: idemKey() },
    );
    expect([early.status, early.body.code]).toEqual([409, 'INVALID_STATE']);
    hold.release();
    await drainQueues();
    setSetupPorts();
    const empty = await dryRun(s, csv('Z,101,1,Flat,,'));
    const r = await commit(s.c, empty.importId, 'VALID_ROWS_ONLY');
    expect([r.status, r.body.code]).toEqual([422, 'IMPORT_NOTHING_TO_COMMIT']);
    const ok = await commit(s.c, started.body.data.importId, 'ALL_OR_NOTHING');
    expect(ok.status).toBe(202);
    const again = await commit(s.c, started.body.data.importId, 'ALL_OR_NOTHING');
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('share totals: a running total over 100 in the building is SHARE_TOTAL_EXCEEDS_100', async () => {
    const s = await withBuilding();
    const d = await dryRun(
      s,
      Buffer.from('Building,Flat No,Floor,Share %\nA,101,1,60\nA,102,1,30\nA,103,1,20\n'),
    );
    expect(d.errorsPreview.map((e: any) => [e.row, e.code])).toEqual([[4, 'SHARE_TOTAL_EXCEEDS_100']]);
  });

  it('GET and commit of an unknown, expired or other society import are 404 IMPORT_NOT_FOUND', async () => {
    const s = await withBuilding();
    const other = await withBuilding();
    const d = await dryRun(s, csv('A,101,1,Flat,,'));
    expect((await other.c('get', `/units/imports/${d.importId}`)).body.code).toBe('IMPORT_NOT_FOUND');
    expect(
      (
        await other.c(
          'post',
          `/units/imports/${d.importId}/commit`,
          { commitPolicy: 'ALL_OR_NOTHING' },
          { headers: idemKey() },
        )
      ).body.code,
    ).toBe('IMPORT_NOT_FOUND');
    expect((await s.c('get', '/units/imports/987654')).status).toBe(404);
    await kv().cacheDel(`ss:import:${d.importId}`);
    expect((await s.c('get', `/units/imports/${d.importId}`)).body.code).toBe('IMPORT_NOT_FOUND');
  });

  it('another holder of residents.units.import can read the import of a colleague', async () => {
    const s = await withBuilding();
    const d = await dryRun(s, csv('A,101,1,Flat,,'));
    const sec = await memberOf(s.society, 'secretary');
    expect((await sec.c('get', `/units/imports/${d.importId}`)).status).toBe(200);
  });

  it('notifications: validated and committed reach the importer; a failed commit sends setup.import.failed', async () => {
    const s = await withBuilding();
    const d = await dryRun(s, csv('A,101,1,Flat,,'));
    await commit(s.c, d.importId, 'ALL_OR_NOTHING');
    const mail = await inboxFor(s.user.email!);
    const subjects = mail.map(m => m.subject ?? '').join('|');
    expect(subjects).toContain('Import finished');
    const f = await dryRun(s, csv('A,201,1,Flat,,'));
    await makeUnit(s.c, s.b.id, '201', 1);
    await commit(s.c, f.importId, 'ALL_OR_NOTHING');
    const subjects2 = (await inboxFor(s.user.email!)).map(m => m.subject ?? '').join('|');
    expect(subjects2).toContain('Import failed');
  });

  it('roles without residents.units.import are refused; auditors cannot import', async () => {
    const s = await withBuilding();
    const guard = await memberOf(s.society, 'security_supervisor');
    const r = await guard.c(
      'post',
      '/units/imports',
      { fileId: 1, mode: 'CREATE_ONLY' },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });
});

describe('POST /units/export (8.18) and the download placeholder', () => {
  it('T08-25 writes a CSV with the note escaped, audits setup.unit.exported, emits setup.export.ready and mails the requester', async () => {
    const s = await withBuilding();
    await makeUnit(s.c, s.b.id, '101', 1, { notes: '=SUM(A1)', carpetAreaSqft: '900' });
    await makeUnit(s.c, s.b.id, '102', 2, { notes: 'plain, with comma' });
    const r = await s.c('post', '/units/export', { status: 'ALL' }, { headers: idemKey() });
    expect([r.status, r.body.data]).toEqual([202, { queued: true }]);
    await drainQueues();
    const ev = events.find(e => e.event === 'setup.export.ready')!;
    expect(ev.room).toBe(`user:${s.user.id}`);
    const text = readFile(ev.payload.fileId as number);
    const lines = text.replace('﻿', '').split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(
      'Building,Flat No,Floor,Type,BHK,Carpet Area,Built-up Area,Super Built-up Area,Share %,Billable,Possession Date,Notes,Label,Area Sqft,Status',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("'=SUM(A1)");
    expect(lines[2]).toContain('"plain, with comma"');
    const a = await audits(s.society.id!, 'setup.unit.exported');
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0]!.after)).toContain('"rowCount":2');
    const file = placeholderFiles.get(ev.payload.fileId as number)!;
    expect([file.purpose, file.ownerUserId, file.societyId]).toEqual([
      'EXPORT_FILE',
      s.user.id,
      s.society.id,
    ]);
  });

  it('status ACTIVE leaves out archived units; buildingId filters; an unknown building is 404 BUILDING_NOT_FOUND', async () => {
    const s = await withBuilding();
    const b2 = await makeBuilding(s.c, { code: 'B' });
    const u = await makeUnit(s.c, s.b.id, '101', 1);
    await makeUnit(s.c, s.b.id, '102', 1);
    await makeUnit(s.c, b2.id, '201', 1);
    await s.c(
      'post',
      `/units/${u.id}/archive`,
      { reason: 'merged flat', version: u.version },
      { headers: idemKey() },
    );
    await s.c('post', '/units/export', { buildingId: s.b.id }, { headers: idemKey() });
    await drainQueues();
    const fileId = events.find(e => e.event === 'setup.export.ready')!.payload.fileId as number;
    expect(readFile(fileId).split('\r\n').filter(Boolean)).toHaveLength(2);
    const bad = await s.c('post', '/units/export', { buildingId: 99999999 }, { headers: idemKey() });
    expect([bad.status, bad.body.code]).toEqual([404, 'BUILDING_NOT_FOUND']);
  });

  it('BR-08-37 is 10 per hour per user: the 11th is 429 RATE_LIMITED', async () => {
    const s = await withBuilding();
    for (let i = 0; i < 10; i++)
      expect((await s.c('post', '/units/export', {}, { headers: idemKey() })).status).toBe(202);
    const r = await s.c('post', '/units/export', {}, { headers: idemKey() });
    expect([r.status, r.body.code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('GET /files/:id/download-url answers for the society own files only', async () => {
    const s = await withBuilding();
    const other = await withBuilding();
    const d = await dryRun(s, csv('A,,1,Flat,,'));
    const ok = await s.c('get', `/files/${d.reportFileId}/download-url`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.url).toBe(`/api/v1/dev/files/${d.reportFileId}`);
    expect((await other.c('get', `/files/${d.reportFileId}/download-url`)).body.code).toBe('FILE_NOT_FOUND');
  });
});

describe('CSV injection helper (BR-08-37)', () => {
  it('prefixes text starting with = + - @ tab or CR, leaves numbers and plain text', () => {
    for (const t of ['=1+1', '+1', '-1', '@x', '\tx', '\rx']) expect(escapeCsvInjection(t)).toBe(`'${t}`);
    expect(escapeCsvInjection('hello')).toBe('hello');
    const out = toCsv(['a'], [[-1], ['-x']]).toString('utf8');
    expect(out).toContain('\r\n-1\r\n');
    expect(out).toContain("'-x");
  });
});

describe('go-live invites job (6.5 step 5, T08-30)', () => {
  it('queues one job per society (jobId go-live:<id>) after the go-live commit and calls module 09 through the port', async () => {
    const s = await setupSociety();
    await s.c('patch', '/society', {
      version: 1,
      registrationNo: 'PNA/HSG/1234/2009',
      reason: 'Registration certificate',
    });
    const b = await makeBuilding(s.c, { floorsAboveGround: 5 });
    await makeUnit(s.c, b.id, '101', 1, { carpetAreaSqft: '900' });
    for (const k of ['PROFILE', 'STRUCTURE', 'UNITS', 'BILLING'])
      expect((await s.c('post', `/onboarding/steps/${k}/complete`, {})).status, k).toBe(200);
    for (const k of ['RESIDENTS', 'PAYMENTS', 'COMMITTEE'])
      expect(
        (await s.c('post', `/onboarding/steps/${k}/skip`, { reason: 'Later after the AGM' })).status,
      ).toBe(200);
    registerGoLiveHook(queueGoLiveInvites);
    const spy = vi.fn(async (_ctx: unknown, _societyId: number) => undefined);
    setSetupPorts({ residents: { sendWelcomeInvites: spy } });
    expect(spy).not.toHaveBeenCalled();
    const first = await s.c('post', '/onboarding/go-live', {}, { headers: idemKey() });
    expect(first.status).toBe(200);
    await drainQueues();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(s.society.id);
    const second = await s.c('post', '/onboarding/go-live', {}, { headers: idemKey() });
    expect(second.body.code).toBe('ALREADY_LIVE');
    await drainQueues();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the default module 09 placeholder only records the call', async () => {
    await runGoLiveInvites({ societyId: 77, requestId: 'r', actorUserId: null });
    expect(welcomeInviteCalls).toEqual([77]);
  });
});
