import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ESLint } from 'eslint';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, PlatformSetting, Society, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import {
  runAuditArchive,
  archiveObjectKey,
} from '../../../src/modules/platform-ops/platform-ops.audit-archive';
import {
  csvCell,
  decodeCursor,
  encodeCursor,
  maskContacts,
} from '../../../src/modules/platform-ops/platform-ops.audit.service';
import {
  placeholderObjects,
  setPlatformOpsPorts,
} from '../../../src/modules/platform-ops/platform-ops.ports';
import {
  clearSettingsCache,
  getPlatformSetting,
  seedPlatformSettings,
} from '../../../src/modules/platform-ops/platform-ops.settings.service';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { as, login, memberUser, resetLogins } from '../../helpers/access';
import { lifecycleSociety, platformAs } from '../../helpers/societies';
import { resetOps } from '../../helpers/platform-ops';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
});

/** Sign-in and society set-up write audit rows of their own; tests that count rows start from an empty table. */
const clearAudit = async () => {
  await sequelize.query('DELETE FROM audit_logs');
};

let n = 0;
const row = (o: Partial<Record<string, unknown>> = {}) => {
  n += 1;
  return AuditLog.create({
    societyId: null,
    actorUserId: 5,
    actorName: 'Meera Iyer',
    actorRole: 'treasurer',
    supportGrantId: null,
    action: 'finance.invoice.created',
    entityType: 'invoice',
    entityId: String(n),
    entityLabel: `Invoice ${n}`,
    before: null,
    after: null,
    reason: null,
    ip: '203.0.113.24',
    userAgent: 'Mozilla/5.0',
    requestId: `req_${n}`,
    createdAt: new Date('2026-10-29T08:00:00Z'),
    ...o,
  } as never);
};
const days = (d: number) => new Date(Date.UTC(2026, 9, 30 - d, 8));
const manifest = async () => (await getPlatformSetting('audit.archiveManifest')) as unknown as any[];

describe('platform audit viewer (8.9, BR-07-44)', () => {
  it('T07-41 a range over 366 days is 400; society filter and cursor paging return each row once, newest first', async () => {
    const admin = await platformAs('super_admin');
    const s1 = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    const s2 = await lifecycleSociety('ACTIVE', { name: 'Green Park CHS' });
    await clearAudit();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await row({ societyId: s2.id, createdAt: days(i) })).id!);
    await row({ societyId: s1.id, createdAt: days(1) });
    await row({ societyId: s2.id, createdAt: days(30) }); // outside 7 days
    const big = await admin.c('get', '/platform/audit-logs', undefined, {
      query: { societyId: String(s2.id), from: '2025-09-01', to: '2026-10-30' },
    });
    expect(big.status).toBe(400);
    expect(big.body.code).toBe('AUDIT_RANGE_TOO_LARGE');
    expect(
      (
        await admin.c('get', '/platform/audit-logs', undefined, {
          query: { from: '2025-10-30', to: '2026-10-30' },
        })
      ).status,
    ).toBe(200); // 366 days exactly
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await admin.c('get', '/platform/audit-logs', undefined, {
        query: {
          societyId: String(s2.id),
          from: '2026-10-23',
          to: '2026-10-30',
          limit: '2',
          ...(cursor ? { cursor } : {}),
        },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      seen.push(...r.body.data.items.map((i: any) => i.id));
      expect(
        r.body.data.items.every((i: any) => i.society.id === s2.id && i.society.name === 'Green Park CHS'),
      ).toBe(true);
      expect(r.body.pagination.limit).toBe(2);
      if (!r.body.pagination.hasMore) {
        expect(r.body.pagination.nextCursor).toBeNull();
        break;
      }
      cursor = r.body.pagination.nextCursor;
    }
    expect(seen).toEqual([...ids].sort((a, b) => b - a)); // ids descending, no duplicates, the 30-day-old row is out
    expect(
      (await admin.c('get', '/platform/audit-logs', undefined, { query: { cursor: 'not-a-cursor' } })).body
        .code,
    ).toBe('INVALID_CURSOR');
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });

  it('filters: platform-only rows, action prefix and exact, entity, search, actor and source', async () => {
    const admin = await platformAs('super_admin', 'Asha Admin');
    const s = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    await clearAudit();
    await row({
      societyId: s.id,
      action: 'platform.ticket.created',
      entityType: 'platform_ticket',
      entityId: '9',
      entityLabel: 'TKT-000009',
      actorRole: 'super_admin',
      actorUserId: admin.user.id,
    });
    await row({
      societyId: s.id,
      action: 'platform.ticket.updated',
      entityType: 'platform_ticket',
      entityId: '9',
      entityLabel: 'TKT-000009',
      actorRole: 'super_admin',
    });
    await row({
      societyId: null,
      action: 'platform.setting.updated',
      entityType: 'platform_setting',
      entityId: 'support.autoCloseDays',
      entityLabel: null,
      actorRole: 'super_admin',
    });
    await row({ societyId: s.id, action: 'finance.invoice.created', actorRole: 'treasurer' });
    await row({
      societyId: s.id,
      action: 'platform_billing.invoice.paid',
      actorRole: 'system',
      actorName: 'System',
    });
    await row({ societyId: s.id, action: 'society.member.joined', actorRole: 'chairman', supportGrantId: 3 });
    const q = (query: Record<string, string>) => admin.c('get', '/platform/audit-logs', undefined, { query });
    const list = async (query: Record<string, string>) => (await q(query)).body.data.items as any[];
    expect((await list({ societyId: 'platform' })).map(i => i.action)).toEqual(['platform.setting.updated']);
    expect((await list({ action: 'platform.ticket.*' })).map(i => i.action).sort()).toEqual([
      'platform.ticket.created',
      'platform.ticket.updated',
    ]);
    expect((await list({ action: 'platform.' })).length).toBe(3);
    expect((await list({ action: 'platform.ticket.created' })).length).toBe(1);
    expect((await list({ entityType: 'platform_ticket', entityId: '9' })).length).toBe(2);
    expect((await list({ q: 'TKT-0000' })).length).toBe(2); // entityLabel prefix
    expect((await list({ q: 'support.autoCloseDays' })).length).toBe(1); // entityId exact
    expect((await list({ actorUserId: String(admin.user.id) })).length).toBe(1);
    expect((await list({ actorRole: 'treasurer' })).length).toBe(1);
    const src = async (source: string) => (await list({ source })).map(i => i.action).sort();
    expect(await src('SYSTEM_JOB')).toEqual(['platform_billing.invoice.paid']);
    expect(await src('PLATFORM_CONSOLE')).toEqual([
      'platform.setting.updated',
      'platform.ticket.created',
      'platform.ticket.updated',
    ]);
    expect(await src('SUPPORT_ACCESS')).toEqual(['society.member.joined']);
    expect(await src('ADMIN_APP')).toEqual(['finance.invoice.created']);
    const all = await list({});
    expect(all.find(i => i.action === 'society.member.joined').source).toBe('Support access');
    expect(all.find(i => i.action === 'platform.setting.updated').source).toBe('Platform console');
    expect(all.find(i => i.action === 'platform_billing.invoice.paid').source).toBe('System job');
    expect((await q({ action: 'Bad Action!' })).status).toBe(400);
    expect((await q({ source: 'NOPE' })).status).toBe(400);
    expect((await q({ from: '2026-10-30', to: '2026-10-01' })).status).toBe(400);
  });

  it('the audit row object has the documented fields; a missing id is 404 AUDIT_LOG_NOT_FOUND; archivedBefore shows the cutoff', async () => {
    const admin = await platformAs('super_admin');
    const s = await lifecycleSociety('ACTIVE', { name: 'Krishna Kunj' });
    const a = await row({
      societyId: s.id,
      action: 'platform.society.suspended',
      entityType: 'society',
      entityId: String(s.id),
      entityLabel: 'Krishna Kunj',
      before: { status: 'PAST_DUE' },
      after: { status: 'SUSPENDED' },
      reason: 'Unpaid for 45 days after dunning',
      actorRole: 'super_admin',
    });
    const r = await admin.c('get', `/platform/audit-logs/${a.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      id: a.id,
      society: { id: s.id, name: 'Krishna Kunj' },
      actor: { userId: 5, name: 'Meera Iyer', role: 'super_admin' },
      supportGrantId: null,
      source: 'Platform console',
      action: 'platform.society.suspended',
      entityType: 'society',
      before: { status: 'PAST_DUE' },
      after: { status: 'SUSPENDED' },
      reason: 'Unpaid for 45 days after dunning',
      ip: '203.0.113.24',
      requestId: expect.stringMatching(/^req_/),
    });
    expect((await admin.c('get', '/platform/audit-logs/999999999')).body.code).toBe('AUDIT_LOG_NOT_FOUND');
    const recent = await admin.c('get', '/platform/audit-logs');
    expect(recent.body.data.archivedBefore).toBeNull();
    const old = await admin.c('get', '/platform/audit-logs', undefined, {
      query: { from: '2024-08-01', to: '2024-09-30' },
    });
    expect(old.body.data.archivedBefore).toBe('2024-10-01'); // 24 months before October 2026
    const support = await platformAs('platform_support');
    expect((await support.c('get', '/platform/audit-logs')).status).toBe(200);
    expect((await support.c('get', '/platform/audit-logs/export')).status).toBe(403);
    expect(
      (await support.c('post', '/platform/audit-logs/archives/download-url', { month: '2024-09' })).status,
    ).toBe(403);
  });
});

describe('society audit viewer (8.9, BR-07-45)', () => {
  async function two() {
    const sky = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    const green = await lifecycleSociety('ACTIVE', { name: 'Green Park CHS' });
    const chair = await memberUser(sky, 'chairman', { name: 'Rajesh' });
    return { sky, green, chair };
  }

  it("T07-42 another society's audit row is 404 AUDIT_LOG_NOT_FOUND and never in the list", async () => {
    const { sky, green, chair } = await two();
    const c = as(await login(chair, { societyId: sky.id! }));
    await clearAudit();
    const mine = await row({ societyId: sky.id });
    const theirs = await row({ societyId: green.id });
    await row({ societyId: null, action: 'platform.setting.updated' });
    const list = await c('get', '/audit-logs');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.items.map((i: any) => i.id)).toEqual([mine.id]); // no other society, no NULL-society row
    const r = await c('get', `/audit-logs/${theirs.id}`);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('AUDIT_LOG_NOT_FOUND');
    expect((await c('get', `/audit-logs/${mine.id}`)).status).toBe(200);
    expect(
      (
        await c('get', '/audit-logs', undefined, { query: { societyId: String(green.id) } })
      ).body.data.items.map((i: any) => i.id),
    ).toEqual([mine.id]); // an unknown query key is ignored
  });

  it('T07-43 a platform action shows as SocietyApp Support with no IP and no user agent', async () => {
    const { sky, chair } = await two();
    await platformAs('super_admin', 'Asha Admin');
    const a = await row({
      societyId: sky.id,
      action: 'platform.society.suspended',
      actorRole: 'super_admin',
      actorName: 'Asha Admin',
      actorUserId: 77,
      supportGrantId: null,
      ip: '203.0.113.99',
      userAgent: 'Mozilla/5.0 (Platform)',
    });
    const c = as(await login(chair, { societyId: sky.id! }));
    const r = await c('get', `/audit-logs/${a.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.actor).toEqual({ userId: null, name: 'SocietyApp Support', role: 'platform' });
    expect(r.body.data.ip).toBeNull();
    expect(r.body.data.userAgent).toBeNull();
    expect(r.body.data.source).toBe('SocietyApp Support');
    expect(JSON.stringify(r.body)).not.toContain('Asha');
    expect(JSON.stringify(r.body)).not.toContain('203.0.113.99');
    const list = await c('get', '/audit-logs');
    expect(JSON.stringify(list.body)).not.toContain('Asha');
  });

  it('contact fields in before and after are masked unless the viewer holds residents.contacts.view', async () => {
    const { sky, chair } = await two();
    const auditor = await memberUser(sky, 'auditor', { name: 'Auditor' });
    const a = await row({
      societyId: sky.id,
      before: { mobile: '9820011111', note: 'x' },
      after: { mobile: '9820022222', email: 'a@b.in', nested: { phone: '9820033333' } },
    });
    const chairman = as(await login(chair, { societyId: sky.id! }));
    const full = await chairman('get', `/audit-logs/${a.id}`);
    expect(full.body.data.after.nested.phone).not.toBe('••••••');
    const masked = await as(await login(auditor, { societyId: sky.id! }))('get', `/audit-logs/${a.id}`);
    expect(masked.status, JSON.stringify(masked.body)).toBe(200);
    expect(JSON.stringify(masked.body.data.after)).not.toContain('9820033333');
    expect(JSON.stringify(masked.body.data.before)).not.toContain('9820011111');
    expect(masked.body.data.before.note).toBe('x');
    expect(maskContacts({ email: 'asha@example.com', other: 1 })).toEqual({
      email: 'a****@example.com',
      other: 1,
    });
  });

  it('society routes need settings.audit_log.view and .export; they work for a suspended society', async () => {
    const { sky, chair } = await two();
    const secretary = await memberUser(sky, 'secretary', { name: 'Sunita' });
    const committee = await memberUser(sky, 'committee_member', { name: 'Committee' });
    expect((await as(await login(committee, { societyId: sky.id! }))('get', '/audit-logs')).status).toBe(403);
    const sec = as(await login(secretary, { societyId: sky.id! }));
    expect((await sec('get', '/audit-logs')).status).toBe(200);
    expect((await sec('get', '/audit-logs/export')).status).toBe(403); // view only
    await sequelize.query(
      'UPDATE societies SET status = "SUSPENDED", suspensionCause = "MANUAL" WHERE id = :id',
      { replacements: { id: sky.id } },
    );
    await flushAcl();
    expect((await as(await login(chair, { societyId: sky.id! }))('get', '/audit-logs')).status).toBe(200);
  });
});

describe('CSV export (BR-07-46)', () => {
  it('T07-44 a reason starting with =SUM( is written with a leading quote; the export is audited with filters and the row count', async () => {
    const admin = await platformAs('super_admin');
    const s = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    await clearAudit();
    await row({
      societyId: s.id,
      action: 'platform.society.suspended',
      reason: '=SUM(A1:A9)',
      entityLabel: '+cmd|calc',
      actorName: 'Asha, "Admin"',
    });
    await row({ societyId: s.id, action: 'platform.society.reactivated', reason: '@mention' });
    const r = await admin.c('get', '/platform/audit-logs/export', undefined, {
      query: { societyId: String(s.id), from: '2026-10-01', to: '2026-10-30' },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="platform-audit-2026-10-01-2026-10-30.csv"',
    );
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Time,Society id,Society,Actor,Role,Source,Action,Entity type,Entity id,Entity,Reason,IP,Request id',
    );
    expect(lines).toHaveLength(3);
    expect(r.text).toContain(",'=SUM(A1:A9),");
    expect(r.text).toContain(",'+cmd|calc,");
    expect(r.text).toContain(",'@mention,");
    expect(r.text).toContain('"Asha, ""Admin"""');
    const a = await AuditLog.findOne({ where: { action: 'platform.audit_log.exported' } });
    expect(a!.societyId).toBeNull();
    expect(a!.after).toMatchObject({
      rows: 2,
      filters: { societyId: String(s.id), from: '2026-10-01', to: '2026-10-30' },
    });
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('over 100000 rows is 422 EXPORT_TOO_LARGE before anything is streamed; the 11th export in an hour is 429', async () => {
    const admin = await platformAs('super_admin');
    await sequelize
      .query(
        `INSERT INTO audit_logs (societyId, actorUserId, actorName, actorRole, action, entityType, entityId, createdAt)
       SELECT NULL, 1, 'Bulk', 'system', 'bulk.test.row', 'bulk', n, '2026-10-28 00:00:00.000'
       FROM (WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 100001) SELECT n FROM seq) t`,
      )
      .catch(async () => {
        await sequelize.query('SET SESSION cte_max_recursion_depth = 200000');
        await sequelize.query(
          `INSERT INTO audit_logs (societyId, actorUserId, actorName, actorRole, action, entityType, entityId, createdAt)
         SELECT NULL, 1, 'Bulk', 'system', 'bulk.test.row', 'bulk', n, '2026-10-28 00:00:00.000'
         FROM (WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 100001) SELECT n FROM seq) t`,
        );
      });
    expect(await AuditLog.count({ where: { action: 'bulk.test.row' } })).toBe(100001);
    const r = await admin.c('get', '/platform/audit-logs/export', undefined, {
      query: { action: 'bulk.test.row', from: '2026-10-01', to: '2026-10-30' },
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('EXPORT_TOO_LARGE');
    expect(await AuditLog.count({ where: { action: 'platform.audit_log.exported' } })).toBe(0);
    for (let i = 0; i < 9; i++)
      expect(
        (
          await admin.c('get', '/platform/audit-logs/export', undefined, {
            query: { action: 'none.such.action' },
          })
        ).status,
      ).toBe(200);
    const eleventh = await admin.c('get', '/platform/audit-logs/export', undefined, {
      query: { action: 'none.such.action' },
    });
    expect(eleventh.status).toBe(429);
    expect(await AuditLog.count({ where: { action: 'bulk.test.row' } })).toBe(100001);
  }, 60_000);

  it('the society export is audited with the society id and uses the society file name and masking', async () => {
    const sky = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    const chair = await memberUser(sky, 'chairman', { name: 'Rajesh' });
    await row({
      societyId: sky.id,
      action: 'platform.society.suspended',
      actorRole: 'super_admin',
      actorName: 'Asha Admin',
      ip: '203.0.113.99',
    });
    await platformAs('super_admin');
    const c = as(await login(chair, { societyId: sky.id! }));
    const r = await c('get', '/audit-logs/export', undefined, {
      query: { from: '2026-10-01', to: '2026-10-30' },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="audit-trail-2026-10-01-2026-10-30.csv"',
    );
    expect(r.text).toContain('SocietyApp Support');
    expect(r.text).not.toContain('Asha');
    expect(r.text).not.toContain('203.0.113.99');
    const a = await AuditLog.findOne({ where: { action: 'society.audit_log.exported' } });
    expect(a!.societyId).toBe(sky.id);
  });
});

describe('audit archive (6.6, BR-07-47, T07-45, T07-46)', () => {
  const key = (m: string, part = 1) => archiveObjectKey(m, part);

  it('T07-45 archives September 2024 with today 2026-10-30: object, manifest COMPLETED, rows deleted, October 2024 untouched', async () => {
    const admin = await platformAs('super_admin');
    const sept = [];
    for (let i = 0; i < 3; i++) sept.push(await row({ createdAt: new Date(`2024-09-1${i}T10:00:00Z`) }));
    for (let i = 0; i < 2; i++) await row({ createdAt: new Date(`2024-10-0${i + 1}T10:00:00Z`) });
    const recent = await row({ createdAt: new Date('2026-10-29T10:00:00Z') });
    const r = await runAuditArchive();
    expect(r).toMatchObject({ archivedMonth: '2024-09', rows: 3 });
    expect(await AuditLog.count({ where: { id: sept.map(x => x.id!) } })).toBe(0);

    const rows = await AuditLog.findAll({ order: [['id', 'ASC']] });
    expect(rows.filter(x => x.createdAt!.toISOString().startsWith('2024-10')).length).toBe(2);
    expect(rows.some(x => x.id === recent.id)).toBe(true);
    const m = await manifest();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      month: '2024-09',
      part: 1,
      objectKey: 'test/platform/audit-archive/2024/09/audit_logs-2024-09.ndjson.gz',
      rowCount: 3,
      minId: sept[0]!.id,
      maxId: sept[2]!.id,
      status: 'COMPLETED',
    });
    const obj = placeholderObjects.get(key('2024-09'))!;
    const text = gunzipSync(obj);
    expect(text.toString().trim().split('\n')).toHaveLength(3);
    expect(createHash('sha256').update(text).digest('hex')).toBe(m[0].sha256);
    expect((await AuditLog.findOne({ where: { action: 'platform.audit_log.archived' } }))!.actorRole).toBe(
      'system',
    );
    // the archive screen lists it; a download URL needs step-up and a completed entry
    const list = await admin.c('get', '/platform/audit-logs/archives');
    expect(list.body.data).toMatchObject({ cutoff: '2024-10-01', archiveAfterMonths: 24, paused: false });
    expect(list.body.data.items[0]).toMatchObject({
      month: '2024-09',
      part: 1,
      rowCount: 3,
      status: 'COMPLETED',
    });
    expect(list.body.data.items[0].objectKey).toBeUndefined();
    const url = await admin.c('post', '/platform/audit-logs/archives/download-url', { month: '2024-09' });
    expect(url.status, JSON.stringify(url.body)).toBe(200);
    expect(url.body.data.url).toContain('audit_logs-2024-09.ndjson.gz');
    expect(new Date(url.body.data.expiresAt).toISOString()).toBe('2026-10-30T04:05:00.000Z');
    expect(
      await AuditLog.findOne({ where: { action: 'platform.audit_archive.download_issued' } }),
    ).not.toBeNull();
    expect(
      (await admin.c('post', '/platform/audit-logs/archives/download-url', { month: '2024-08' })).body.code,
    ).toBe('ARCHIVE_NOT_FOUND');
    expect(
      (await admin.c('post', '/platform/audit-logs/archives/download-url', { month: '2024-09', part: 2 }))
        .body.code,
    ).toBe('ARCHIVE_NOT_FOUND');
    expect(
      (await admin.c('post', '/platform/audit-logs/archives/download-url', { month: '2024-13' })).status,
    ).toBe(400);
    setNow('2026-10-30T04:06:00Z');
    expect(
      (await admin.c('post', '/platform/audit-logs/archives/download-url', { month: '2024-09' })).body.code,
    ).toBe('REAUTH_REQUIRED');
  });

  it('one month per run (oldest first); a second run with nothing old does nothing; late rows of an archived month become part 2', async () => {
    await row({ createdAt: new Date('2024-08-05T10:00:00Z') });
    await row({ createdAt: new Date('2024-09-05T10:00:00Z') });
    expect((await runAuditArchive()).archivedMonth).toBe('2024-08');
    expect((await runAuditArchive()).archivedMonth).toBe('2024-09');
    expect((await runAuditArchive()).archivedMonth).toBeNull();
    await row({ createdAt: new Date('2024-08-20T10:00:00Z') }); // clock skew: a row for a month already archived
    const r = await runAuditArchive();
    expect(r).toMatchObject({ archivedMonth: '2024-08', rows: 1 });
    const m = await manifest();
    expect(m.map(e => `${e.month}:p${e.part}:${e.status}`)).toEqual([
      '2024-08:p1:COMPLETED',
      '2024-09:p1:COMPLETED',
      '2024-08:p2:COMPLETED',
    ]);
    expect(placeholderObjects.has(key('2024-08', 2))).toBe(true);
    expect(key('2024-08', 2)).toMatch(/audit_logs-2024-08-p2\.ndjson\.gz$/);
  });

  it('T07-46 a verification mismatch deletes the object, deletes no rows, notifies and fails the job', async () => {
    await platformAs('super_admin', 'Asha Admin');
    const a = await row({ createdAt: new Date('2024-09-05T10:00:00Z') });
    await row({ createdAt: new Date('2024-09-06T10:00:00Z') });
    setPlatformOpsPorts({
      storage: {
        putObject: async (k, body) => {
          placeholderObjects.set(
            k,
            gzipSync(Buffer.concat([gunzipSync(body), Buffer.from('{"corrupt":true}\n')])),
          );
        },
      },
    });
    await expect(runAuditArchive()).rejects.toThrow(/verification failed/);
    expect(placeholderObjects.size).toBe(0);
    expect(await AuditLog.count({ where: { action: 'finance.invoice.created' } })).toBe(2); // nothing was deleted
    expect(await AuditLog.findByPk(a.id!)).not.toBeNull();
    expect(await manifest()).toEqual([]);
    const mail = (await listInbox()).filter(
      m => m.subject === 'Audit archive of 2024-09 failed verification',
    );
    expect(mail.length).toBeGreaterThan(0);
    setPlatformOpsPorts();
    expect((await runAuditArchive()).archivedMonth).toBe('2024-09'); // the next run succeeds
  });

  it('a legal hold stops archiving; an UPLOADED entry resumes at the delete step; objects older than 8 years are PURGED but stay listed', async () => {
    const a = await row({ createdAt: new Date('2024-09-05T10:00:00Z') });
    await seedPlatformSettings();
    await PlatformSetting.update({ valueJson: true }, { where: { settingKey: 'audit.archivePaused' } });
    await clearSettingsCache();
    expect(await runAuditArchive()).toMatchObject({ paused: true, archivedMonth: null });
    expect(await AuditLog.findByPk(a.id!)).not.toBeNull();
    await PlatformSetting.update({ valueJson: false }, { where: { settingKey: 'audit.archivePaused' } });
    // a crash after the upload: the entry is UPLOADED and the rows are still there
    const entry = {
      month: '2024-09',
      part: 1,
      objectKey: key('2024-09'),
      rowCount: 1,
      minId: a.id,
      maxId: a.id,
      sha256: 'abc',
      status: 'UPLOADED',
      archivedAt: '2026-10-29T02:30:00.000Z',
    };
    const old = {
      month: '2016-01',
      part: 1,
      objectKey: key('2016-01'),
      rowCount: 5,
      minId: 1,
      maxId: 5,
      sha256: 'def',
      status: 'COMPLETED',
      archivedAt: '2016-03-01T02:30:00.000Z',
    };
    placeholderObjects.set(key('2016-01'), Buffer.from('old'));
    await PlatformSetting.update(
      { valueJson: [old, entry] },
      { where: { settingKey: 'audit.archiveManifest' } },
    );
    await clearSettingsCache();
    const r = await runAuditArchive();
    expect(r).toMatchObject({ archivedMonth: '2024-09', purged: 1 });
    expect(await AuditLog.findByPk(a.id!)).toBeNull();
    const m = await manifest();
    expect(m.map(e => `${e.month}:${e.status}`)).toEqual(['2016-01:PURGED', '2024-09:COMPLETED']);
    expect(placeholderObjects.has(key('2016-01'))).toBe(false);
  });

  it('the no-audit-delete lint rule forbids DELETE FROM audit_logs outside the archive file', async () => {
    const eslint = new ESLint();
    const code =
      "export const q = 'DELETE FROM audit_logs WHERE id < 5';\nexport const t = `delete   from audit_logs`;\n";
    const bad = await eslint.lintText(code, {
      filePath: 'src/modules/platform-ops/platform-ops.something.ts',
    });
    expect(bad[0]!.messages.filter(m => m.ruleId === 'no-restricted-syntax')).toHaveLength(2);
    const ok = await eslint.lintText(code, {
      filePath: 'src/modules/platform-ops/platform-ops.audit-archive.ts',
    });
    expect(ok[0]!.messages.filter(m => m.ruleId === 'no-restricted-syntax')).toHaveLength(0);
    void Society;
    void days;
  });
});
