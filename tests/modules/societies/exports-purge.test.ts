import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import {
  AuditLog,
  DataExport,
  Invitation,
  Society,
  SocietyLifecycleEvent,
  SocietyMember,
  closeDb,
  sequelize,
} from '../../../src/models';
import { addDays, advance, now, setNow } from '../../../src/lib/clock';
import { createInvitationCore } from '../../../src/modules/access-control/access-control.invitations.service';
import {
  buildExport,
  expireExports,
  exportProviders,
  registerExportProvider,
  setExportPartLimit,
  unregisterExportProvider,
} from '../../../src/modules/societies/societies.exports';
import {
  registerPurgeHandler,
  registerRetentionExpiryHandler,
  runFinancialRetention,
  runPurge,
  unregisterRetentionExpiryHandler,
} from '../../../src/modules/societies/societies.purge';
import { placeholderFiles, societyPorts } from '../../../src/modules/societies/societies.ports';
import { registerPlatformBilling } from '../../../src/modules/platform-billing/platform-billing.public';
import { readZip } from '../../../src/modules/societies/societies.zip';
import { systemCtx } from '../../../src/types/context';
import { as, idem, login, memberUser, resetLogins } from '../../helpers/access';
import { call } from '../../helpers/auth';
import { lifecycleSociety, platformAs, resetSocieties, settle } from '../../helpers/societies';

afterAll(closeDb);
beforeEach(async () => {
  setNow('2026-10-30T07:00:00Z');
  await resetSocieties();
  resetLogins();
  setNow('2026-10-30T07:00:00Z');
});

const fullRow = (societyId: number, o: Partial<Record<string, unknown>> = {}) =>
  DataExport.create({
    societyId,
    kind: 'FULL',
    requestedVia: 'SOCIETY',
    requestedByUserId: null,
    reason: null,
    includeDocuments: false,
    status: 'READY',
    progressPercent: 100,
    fileIds: [],
    partCount: 0,
    totalSizeBytes: 0,
    manifestSummary: null,
    attempts: 1,
    errorCode: null,
    startedAt: now(),
    completedAt: now(),
    expiresAt: addDays(now(), 7),
    downloadCount: 0,
    lastDownloadedAt: null,
    createdBy: null,
    updatedBy: null,
    ...o,
  } as never);

async function download(c: ReturnType<typeof as>, id: number, part = 1): Promise<Map<string, Buffer>> {
  const u = await c('get', `/data-exports/${id}/download-url`, undefined, { query: { part: String(part) } });
  if (u.status !== 200) throw new Error(JSON.stringify(u.body));
  const f = await call('get', u.body.data.url.replace('/api/v1', ''), undefined, { origin: null })
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return readZip(f.body as Buffer);
}

describe('society data export (8.24, 6.6, BR-05-22 to BR-05-24)', () => {
  it('T05-37 export is READY with a manifest whose row counts match the CSVs; money in paise and rupees; parts split', async () => {
    const s = await lifecycleSociety('ACTIVE', { plan: 'ENTERPRISE' });
    const chair = await memberUser(s, 'chairman');
    for (let i = 0; i < 4; i++) await memberUser(s, 'committee_member');
    await societyPorts().files.storeSystemFile({
      societyId: s.id!,
      purpose: 'EXPORT_FILE',
      content: Buffer.from('old export'),
      name: 'old.zip',
      contentType: 'application/zip',
      ownerUserId: null,
    });
    placeholderFiles.set(9001, {
      fileId: 9001,
      societyId: s.id!,
      purpose: 'NOTICE_ATTACHMENT',
      name: 'AGM notice.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 agm'),
      ownerUserId: null,
      status: 'CLEAN',
    });
    const c = as(await login(chair, { societyId: s.id! }));
    const r = await c('post', '/data-exports', {}, { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await settle();
    const e = (await c('get', `/data-exports/${r.body.data.id}`)).body.data;
    expect(e).toMatchObject({ status: 'READY', progressPercent: 100, partCount: 1, includeDocuments: true });
    expect(e.expiresAt).toBe('2026-11-06T07:00:00.000Z');
    expect(e.manifestSummary.documents).toBe(1);
    const zip = await download(c, e.id);
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    expect(manifest).toMatchObject({ societyId: s.id, kind: 'FULL', parts: 1 });
    for (const t of manifest.tables as { file: string; rows: number }[]) {
      const csv = zip
        .get(t.file)!
        .toString('utf8')
        .replace(/^\uFEFF/, '');
      expect(csv.trim().split('\r\n').length - 1, t.file).toBe(t.rows);
    }
    expect(
      manifest.tables.find((t: { file: string }) => t.file === 'data/access-control/members.csv').rows,
    ).toBe(5);
    const subs = zip.get('data/subscriptions/subscriptions.csv')!.toString('utf8');
    expect(subs.split('\r\n')[0]).toContain('customPricePerFlatPaise,customPricePerFlatRupees');
    expect(subs).toContain('2000,20.00');
    expect([...zip.keys()].some(k => k.startsWith('documents/NOTICE_ATTACHMENT/9001-AGM_notice.pdf'))).toBe(
      true,
    );
    expect([...zip.keys()].some(k => k.includes('old.zip'))).toBe(false);
    expect(zip.has('README.txt')).toBe(true);
    expect(await AuditLog.count({ where: { action: 'societies.data_export.downloaded' } })).toBe(1);
    expect((await DataExport.findByPk(e.id))!.downloadCount).toBe(1);
    // small part size: several parts, a manifest in every part
    setExportPartLimit(1500);
    advance(25 * 3_600_000);
    resetLogins();
    const c2 = as(await login(chair, { societyId: s.id! }));
    const r2 = await c2('post', '/data-exports', { includeDocuments: false }, { headers: idem() });
    await settle();
    const e2 = (await DataExport.findByPk(r2.body.data.id))!;
    expect(e2.status).toBe('READY');
    expect(e2.partCount).toBeGreaterThan(1);
    const last = await download(c2, e2.id!, e2.partCount);
    expect(JSON.parse(last.get('manifest.json')!.toString()).part).toBe(e2.partCount);
    expect(
      (
        await c2('get', `/data-exports/${e2.id}/download-url`, undefined, {
          query: { part: String(e2.partCount + 1) },
        })
      ).status,
    ).toBe(400);
  });

  it('T05-36 an export while one runs is 409; the third FULL export in 24 hours is 429', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const chair = await memberUser(s, 'chairman');
    const c = as(await login(chair, { societyId: s.id! }));
    const running = await fullRow(s.id!, { status: 'RUNNING' });
    const busy = await c('post', '/data-exports', {}, { headers: idem() });
    expect([busy.status, busy.body.code]).toEqual([409, 'EXPORT_ALREADY_RUNNING']);
    await running.update({ status: 'READY' });
    await fullRow(s.id!);
    const many = await c('post', '/data-exports', {}, { headers: idem() });
    expect([many.status, many.body.code]).toEqual([429, 'EXPORT_RATE_LIMITED']);
    await fullRow(s.id!, { kind: 'CLOSURE', requestedVia: 'SYSTEM' });
    expect(await DataExport.count({ where: { societyId: s.id!, kind: 'FULL' } })).toBe(2);
  });

  it('T05-38 download after expiry is 410; not ready is 409; download needs step-up; T05-41 another society export is 404', async () => {
    const s = await lifecycleSociety('ACTIVE', { name: 'A CHS' });
    const b = await lifecycleSociety('ACTIVE', { name: 'B CHS' });
    const chair = await memberUser(s, 'chairman');
    const c = as(await login(chair, { societyId: s.id! }));
    const queued = await fullRow(s.id!, { status: 'QUEUED', expiresAt: null });
    expect((await c('get', `/data-exports/${queued.id}/download-url`)).body.code).toBe('EXPORT_NOT_READY');
    await queued.update({ status: 'FAILED' });
    const old = await fullRow(s.id!, { expiresAt: addDays(now(), -1), partCount: 1, fileIds: [1] });
    const gone = await c('get', `/data-exports/${old.id}/download-url`);
    expect([gone.status, gone.body.code]).toEqual([410, 'EXPORT_EXPIRED']);
    const other = await fullRow(b.id!);
    for (const path of [`/data-exports/${other.id}`, `/data-exports/${other.id}/download-url`]) {
      const r = await c('get', path);
      expect([r.status, r.body.code], path).toEqual([404, 'DATA_EXPORT_NOT_FOUND']);
    }
    advance(6 * 60_000);
    expect((await c('get', `/data-exports/${old.id}/download-url`)).body.code).toBe('REAUTH_REQUIRED');
    expect((await c('post', '/data-exports', {}, { headers: idem() })).body.code).toBe('REAUTH_REQUIRED');
    // platform users list exports but get no download link
    const sa = await platformAs('super_admin');
    const list = await sa.c('get', `/platform/societies/${s.id}/data-exports`);
    expect(list.body.data.length).toBe(2);
    expect(JSON.stringify(list.body)).not.toContain('url');
  });

  it('expiry job deletes the files and marks EXPIRED; provider failure ends FAILED with PROVIDER_FAILED:<module> after 3 attempts', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const sa = await platformAs('super_admin');
    const r = await sa.c(
      'post',
      `/platform/societies/${s.id}/data-exports`,
      { reason: 'Customer asked by email', includeDocuments: false },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.requestedVia).toBe('PLATFORM');
    await settle();
    const e = (await DataExport.findByPk(r.body.data.id))!;
    expect(e.status).toBe('READY');
    setNow(addDays(now(), 8));
    expect((await expireExports()).expired).toBe(1);
    expect((await DataExport.findByPk(e.id!))!.status).toBe('EXPIRED');
    expect(placeholderFiles.get(e.fileIds![0]!)!.status).toBe('DELETED');
    registerExportProvider({
      module: 'broken',
      tables: [
        {
          name: 'broken',
          file: 'broken.csv',
          stream: () =>
            (async function* () {
              yield { a: 1 };
              throw new Error('boom');
            })(),
        },
      ],
    });
    try {
      const q = await fullRow(s.id!, { status: 'QUEUED', expiresAt: null, attempts: 0 });
      for (let i = 0; i < 3; i++) await buildExport(q.id!).catch(() => undefined);
      const failed = (await DataExport.findByPk(q.id!))!;
      expect([failed.status, failed.errorCode, failed.attempts]).toEqual([
        'FAILED',
        'PROVIDER_FAILED:broken',
        3,
      ]);
    } finally {
      unregisterExportProvider('broken');
    }
  });

  it('registry contract: every society table has an export provider, notes excluded', async () => {
    const rows = await sequelize.query<{ t: string }>(
      "SELECT DISTINCT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'societyId'",
      { type: QueryTypes.SELECT },
    );
    registerPlatformBilling(); // module 06 registers its provider at start-up
    const covered = new Set(exportProviders().flatMap(p => p.tables.map(t => t.name)));
    // audit_logs: module 07 audit export; idempotency_keys: request plumbing; society_notes: platform internal (BR-05-34);
    // member_grants, role_permissions: permission plumbing; entitlement_overrides, feature_flag_overrides: platform config;
    // number_sequences: platform numbering (society 0 series for module 06), internal and not society data
    const exempt = new Set([
      'audit_logs',
      'idempotency_keys',
      'society_notes',
      'member_grants',
      'role_permissions',
      'entitlement_overrides',
      'feature_flag_overrides',
      'sessions',
      'number_sequences',
    ]);
    const missing = rows.map(r => r.t).filter(t => !covered.has(t) && !exempt.has(t));
    expect(missing).toEqual([]);
    expect(covered.has('society_notes')).toBe(false);
  });
});

describe('purge and financial retention (BR-05-21, BR-05-38, 6.7)', () => {
  async function closedSociety() {
    const s = await lifecycleSociety('CLOSED', { name: 'Gone CHS' });
    const chair = await memberUser(s, 'chairman');
    await sequelize.transaction(t =>
      createInvitationCore(
        systemCtx('t'),
        { societyId: s.id!, name: 'Ravi Kumar', mobile: '9820055502', roleKey: 'secretary' },
        t,
      ),
    );
    let id = 100;
    for (const purpose of [
      'INVOICE_PDF',
      'RECEIPT_PDF',
      'PLATFORM_INVOICE_PDF',
      'VISITOR_PHOTO',
      'KYC_DOCUMENT',
      'TICKET_PHOTO',
    ])
      placeholderFiles.set(++id, {
        fileId: id,
        societyId: s.id!,
        purpose,
        name: `${purpose}.bin`,
        contentType: 'application/octet-stream',
        content: Buffer.from(purpose),
        ownerUserId: null,
        status: 'CLEAN',
      });
    await Society.update(
      {
        closedAt: new Date('2026-10-30T06:00:00Z'),
        purgeAfter: new Date('2027-01-28T06:00:00Z'),
        financialRetainUntil: '2035-03-31',
      } as never,
      { where: { id: s.id! } },
    );
    return { s, chair };
  }
  const filesOf = (sid: number) =>
    Object.fromEntries(
      [...placeholderFiles.values()].filter(f => f.societyId === sid).map(f => [f.purpose, f.status]),
    );

  it('T05-26 purge hold skips; after clearing it the society is purged: personal data anonymised, financial files kept', async () => {
    const { s } = await closedSociety();
    const auditBefore = await AuditLog.count();
    await Society.update(
      { purgeHoldReason: 'Legal dispute pending', purgeHoldSetAt: now() },
      { where: { id: s.id! } },
    );
    setNow('2027-01-22T06:00:00Z');
    expect((await runPurge()).warned).toBe(0); // on hold: no warning either
    setNow('2027-01-29T06:00:00Z');
    expect(await runPurge()).toEqual({ warned: 0, purged: 0, failed: 0 });
    await Society.update({ purgeHoldReason: null, purgeHoldSetAt: null }, { where: { id: s.id! } });
    expect((await runPurge()).purged).toBe(1);
    const r = (await Society.findByPk(s.id!))!;
    expect(r.purgedAt).not.toBeNull();
    expect(r.status).toBe('CLOSED');
    expect(await SocietyMember.count({ where: { societyId: s.id!, status: 'ACTIVE' } })).toBe(0);
    const inv = (await Invitation.findOne({ where: { societyId: s.id! } }))!;
    expect(inv.name).toBe(`Former member #${inv.id}`);
    expect(filesOf(s.id!)).toEqual({
      INVOICE_PDF: 'CLEAN',
      RECEIPT_PDF: 'CLEAN',
      PLATFORM_INVOICE_PDF: 'CLEAN',
      VISITOR_PHOTO: 'DELETED',
      KYC_DOCUMENT: 'DELETED',
      TICKET_PHOTO: 'DELETED',
    });
    const ev = (await SocietyLifecycleEvent.findOne({ where: { societyId: s.id!, eventType: 'PURGED' } }))!;
    expect((ev.metadata as { filesDeleted: number }).filesDeleted).toBe(3);
    expect(await AuditLog.count()).toBeGreaterThan(auditBefore); // audit rows are never deleted
    expect(await AuditLog.count({ where: { action: 'societies.society.purged' } })).toBe(1);
    expect((await runPurge()).purged).toBe(0);
  });

  it('purge warning 7 days ahead, once', async () => {
    const { s } = await closedSociety();
    setNow('2027-01-22T06:00:00Z');
    expect((await runPurge()).warned).toBe(1);
    expect((await runPurge()).warned).toBe(0);
    expect(
      await SocietyLifecycleEvent.count({ where: { societyId: s.id!, eventType: 'PURGE_WARNED' } }),
    ).toBe(1);
  });

  it('the purge registry refuses financial tables and module 06', () => {
    expect(() =>
      registerPurgeHandler({
        module: 'billing',
        order: 11,
        tables: ['invoices'],
        purge: async () => ({ deleted: 0, anonymised: 0 }),
      }),
    ).toThrow(/financial/);
    expect(() =>
      registerPurgeHandler({
        module: 'platform-billing',
        order: 6,
        tables: [],
        purge: async () => ({ deleted: 0, anonymised: 0 }),
      }),
    ).toThrow(/Module 06/);
  });

  it('T05-19d financial retention: nothing on 31 Mar 2035 (IST); on 1 Apr retained rows and files are deleted; a hold blocks it', async () => {
    const { s } = await closedSociety();
    await Society.update({ purgedAt: new Date('2027-01-29T06:00:00Z') }, { where: { id: s.id! } });
    const calls: number[] = [];
    registerRetentionExpiryHandler({
      module: 'billing',
      order: 11,
      deleteRetained: async id => (calls.push(id), { deleted: 42 }),
    });
    try {
      setNow('2035-03-31T12:00:00Z');
      expect(await runFinancialRetention()).toEqual({ done: 0, failed: 0 });
      await Society.update({ purgeHoldReason: 'Tax audit open' }, { where: { id: s.id! } });
      setNow('2035-04-01T00:00:00Z');
      expect(await runFinancialRetention()).toEqual({ done: 0, failed: 0 });
      await Society.update({ purgeHoldReason: null }, { where: { id: s.id! } });
      expect(await runFinancialRetention()).toEqual({ done: 1, failed: 0 });
      expect(calls).toEqual([s.id]);
      const r = (await Society.findByPk(s.id!))!;
      expect(r.financialPurgedAt).not.toBeNull();
      expect(filesOf(s.id!).INVOICE_PDF).toBe('DELETED');
      const ev = (await SocietyLifecycleEvent.findOne({
        where: { societyId: s.id!, eventType: 'FINANCIAL_PURGED' },
      }))!;
      expect(ev.metadata).toMatchObject({ handlers: { billing: { deleted: 42 } }, filesDeleted: 3 });
      expect(await AuditLog.count({ where: { action: 'societies.society.financial_records_deleted' } })).toBe(
        1,
      );
      expect((await runFinancialRetention()).done).toBe(0);
    } finally {
      unregisterRetentionExpiryHandler('billing');
    }
  });
});
