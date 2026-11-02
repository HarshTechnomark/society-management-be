import { Op, type WhereOptions } from 'sequelize';
import { AuditLog, Role, Society, sequelize } from '../../models';
import { addDays, now } from '../../lib/clock';
import { maskEmail, maskPhone } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY } from './platform-ops.types';
import { getPlatformSetting } from './platform-ops.settings.service';
import { opsPorts } from './platform-ops.ports';
import { archiveObjectKey } from './platform-ops.audit-archive';

/** Audit log viewers, CSV export and the archive list and download (module 07 section 8.9, BR-07-44 to BR-07-46). */
export const SOURCES = [
  'SUPPORT_ACCESS',
  'SYSTEM_JOB',
  'PLATFORM_CONSOLE',
  'API_KEY',
  'GUARD_CONSOLE',
  'STAFF_APP',
  'RESIDENT_APP',
  'ADMIN_APP',
] as const;
export type SourceKey = (typeof SOURCES)[number];
const SOURCE_LABEL: Record<SourceKey, string> = {
  SUPPORT_ACCESS: 'Support access',
  SYSTEM_JOB: 'System job',
  PLATFORM_CONSOLE: 'Platform console',
  API_KEY: 'API key',
  GUARD_CONSOLE: 'Guard console',
  STAFF_APP: 'Staff app',
  RESIDENT_APP: 'Resident app',
  ADMIN_APP: 'Admin app',
};
const STAFF = ['maintenance_staff', 'vendor'];
const RESIDENT = ['owner', 'tenant', 'family_member'];
export const EXPORT_LIMIT = 100_000;

export interface AuditFilter {
  societyId?: string;
  actorUserId?: number;
  actorRole?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  source?: SourceKey;
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;

async function platformRoleKeys(): Promise<string[]> {
  return (await Role.findAll({ where: { scope: 'platform' }, attributes: ['key'] })).map(r => r.key);
}

/** The source label of a row, in the order of section 8.9. */
export function sourceOf(
  row: { supportGrantId: number | null; actorRole: string },
  platformKeys: string[],
): SourceKey {
  if (row.supportGrantId !== null) return 'SUPPORT_ACCESS';
  if (row.actorRole === 'system') return 'SYSTEM_JOB';
  if (platformKeys.includes(row.actorRole)) return 'PLATFORM_CONSOLE';
  if (row.actorRole === 'api_key') return 'API_KEY';
  if (row.actorRole === 'guard') return 'GUARD_CONSOLE';
  if (STAFF.includes(row.actorRole)) return 'STAFF_APP';
  if (RESIDENT.includes(row.actorRole)) return 'RESIDENT_APP';
  return 'ADMIN_APP';
}

function sourceCondition(source: SourceKey, platformKeys: string[]): WhereOptions {
  const noGrant = { supportGrantId: null };
  const known = ['system', ...platformKeys, 'api_key', 'guard', ...STAFF, ...RESIDENT];
  switch (source) {
    case 'SUPPORT_ACCESS':
      return { supportGrantId: { [Op.ne]: null } };
    case 'SYSTEM_JOB':
      return { ...noGrant, actorRole: 'system' };
    case 'PLATFORM_CONSOLE':
      return { ...noGrant, actorRole: { [Op.in]: platformKeys.length ? platformKeys : ['-'] } };
    case 'API_KEY':
      return { ...noGrant, actorRole: 'api_key' };
    case 'GUARD_CONSOLE':
      return { ...noGrant, actorRole: 'guard' };
    case 'STAFF_APP':
      return { ...noGrant, actorRole: { [Op.in]: STAFF } };
    case 'RESIDENT_APP':
      return { ...noGrant, actorRole: { [Op.in]: RESIDENT } };
    case 'ADMIN_APP':
      return { ...noGrant, actorRole: { [Op.notIn]: known } };
  }
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

/** Date range of the query (BR-07-44): default the last 30 days, at most 366 days. */
export function auditRange(
  from?: string,
  to?: string,
): { from: Date; to: Date; fromDay: string; toDay: string } {
  const toDay = to ?? ymd(now());
  const fromDay = from ?? ymd(addDays(new Date(`${toDay}T00:00:00Z`), -29));
  const start = new Date(`${fromDay}T00:00:00Z`);
  const end = new Date(`${toDay}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  if (days > 366) throw new AppError(400, 'AUDIT_RANGE_TOO_LARGE', 'Choose a date range of at most 366 days');
  return { from: start, to: new Date(end.getTime() + DAY), fromDay, toDay };
}

export const encodeCursor = (id: number) => Buffer.from(String(id)).toString('base64url');
export function decodeCursor(c: string): number {
  const id = Number(Buffer.from(c, 'base64url').toString());
  if (!Number.isInteger(id) || id <= 0 || encodeCursor(id) !== c)
    throw new AppError(400, 'INVALID_CURSOR', 'The page cursor is not valid');
  return id;
}

async function buildWhere(
  f: AuditFilter,
  forcedSociety: number | null,
): Promise<{ where: WhereOptions; range: ReturnType<typeof auditRange> }> {
  const range = auditRange(f.from, f.to);
  const and: WhereOptions[] = [{ createdAt: { [Op.gte]: range.from, [Op.lt]: range.to } }];
  if (forcedSociety !== null) and.push({ societyId: forcedSociety });
  else if (f.societyId === 'platform') and.push({ societyId: null });
  else if (f.societyId) and.push({ societyId: Number(f.societyId) });
  if (f.actorUserId) and.push({ actorUserId: f.actorUserId });
  if (f.actorRole) and.push({ actorRole: f.actorRole });
  if (f.action) {
    const prefix = /(\.\*|\.)$/.test(f.action) ? f.action.replace(/\.?\*?$/, '.') : null;
    and.push(
      prefix ? { action: { [Op.like]: `${likeEscape(prefix)}%` } } : { action: f.action.replace(/\*$/, '') },
    );
  }
  if (f.entityType) and.push({ entityType: f.entityType });
  if (f.entityId) and.push({ entityId: f.entityId });
  if (f.q) and.push({ [Op.or]: [{ entityId: f.q }, { entityLabel: { [Op.like]: `${likeEscape(f.q)}%` } }] });
  if (f.source) and.push(sourceCondition(f.source, await platformRoleKeys()));
  return { where: { [Op.and]: and }, range };
}

// ------------------------------------------------------------------ views
export async function archiveCutoff(): Promise<Date> {
  const months = await getPlatformSetting('audit.archiveAfterMonths');
  const t = now();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - months, 1));
}

export function platformRow(r: AuditLog, societies: Map<number, string>, platformKeys: string[]) {
  return {
    id: r.id!,
    createdAt: r.createdAt,
    society: r.societyId ? { id: r.societyId, name: societies.get(r.societyId) ?? null } : null,
    actor: { userId: r.actorUserId, name: r.actorName, role: r.actorRole },
    supportGrantId: r.supportGrantId,
    source: SOURCE_LABEL[sourceOf(r, platformKeys)],
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    entityLabel: r.entityLabel,
    before: r.before,
    after: r.after,
    reason: r.reason,
    ip: r.ip,
    userAgent: r.userAgent,
    requestId: r.requestId,
  };
}

const CONTACT_KEY = /mobile|phone|email/i;
/** BR-07-45: diff values under contact keys are masked unless the viewer may see contacts. */
export function maskContacts<T>(v: T, depth = 0): T {
  if (depth > 8 || v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(x => maskContacts(x, depth + 1)) as T;
  if (typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      out[k] =
        CONTACT_KEY.test(k) && (typeof x === 'string' || typeof x === 'number')
          ? typeof x === 'string' && x.includes('@')
            ? maskEmail(x)
            : maskPhone(String(x)) === String(x)
              ? '••••••'
              : maskPhone(String(x))
          : maskContacts(x, depth + 1);
    return out as T;
  }
  return v;
}

export function societyRow(r: AuditLog, platformKeys: string[], canSeeContacts: boolean) {
  const isPlatform = platformKeys.includes(r.actorRole);
  const src = sourceOf(r, platformKeys);
  const diff = <T>(x: T) => (canSeeContacts ? x : maskContacts(x));
  return {
    id: r.id!,
    createdAt: r.createdAt,
    actor: isPlatform
      ? { userId: null, name: 'SocietyApp Support', role: 'platform' }
      : { userId: r.actorUserId, name: r.actorName, role: r.actorRole },
    supportGrantId: r.supportGrantId,
    source: isPlatform ? 'SocietyApp Support' : SOURCE_LABEL[src],
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    entityLabel: r.entityLabel,
    before: diff(r.before),
    after: diff(r.after),
    reason: r.reason,
    ip: isPlatform ? null : r.ip,
    userAgent: isPlatform ? null : r.userAgent,
    requestId: r.requestId,
  };
}

async function page(f: AuditFilter, forcedSociety: number | null) {
  const { where, range } = await buildWhere(f, forcedSociety);
  const limit = f.limit ?? 20;
  const cursor = f.cursor ? decodeCursor(f.cursor) : null;
  const rows = await AuditLog.findAll({
    where: cursor ? { [Op.and]: [where, { id: { [Op.lt]: cursor } }] } : where,
    order: [['id', 'DESC']],
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const nextCursor = hasMore ? encodeCursor(items[items.length - 1]!.id!) : null;
  return { items, hasMore, nextCursor, limit, range };
}

export async function listPlatformAudit(f: AuditFilter) {
  const p = await page(f, null);
  const keys = await platformRoleKeys();
  const ids = [...new Set(p.items.map(i => i.societyId).filter((x): x is number => x !== null))];
  const names = new Map(
    ids.length
      ? (await Society.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'name'] })).map(
          s => [s.id!, s.name] as [number, string],
        )
      : [],
  );
  const cutoff = await archiveCutoff();
  return {
    data: {
      items: p.items.map(r => platformRow(r, names, keys)),
      archivedBefore: p.range.from < cutoff ? ymd(cutoff) : null,
    },
    pagination: { limit: p.limit, nextCursor: p.nextCursor, hasMore: p.hasMore },
  };
}

export async function getPlatformAuditRow(id: number) {
  const r = await AuditLog.findByPk(id);
  if (!r) throw new NotFoundError('AUDIT_LOG_NOT_FOUND', 'Audit entry not found');
  const names = new Map<number, string>();
  if (r.societyId) {
    const s = await Society.findByPk(r.societyId, { attributes: ['id', 'name'] });
    if (s) names.set(s.id!, s.name);
  }
  return platformRow(r, names, await platformRoleKeys());
}

export async function listSocietyAudit(ctx: Ctx, f: AuditFilter) {
  const p = await page(f, ctx.society!.id);
  const keys = await platformRoleKeys();
  const contacts = ctx.permissions?.has('residents.contacts.view') ?? false;
  const cutoff = await archiveCutoff();
  return {
    data: {
      items: p.items.map(r => societyRow(r, keys, contacts)),
      archivedBefore: p.range.from < cutoff ? ymd(cutoff) : null,
    },
    pagination: { limit: p.limit, nextCursor: p.nextCursor, hasMore: p.hasMore },
  };
}

export async function getSocietyAuditRow(ctx: Ctx, id: number) {
  const r = await AuditLog.findOne({ where: { id, societyId: ctx.society!.id } });
  if (!r) throw new NotFoundError('AUDIT_LOG_NOT_FOUND', 'Audit entry not found');
  return societyRow(r, await platformRoleKeys(), ctx.permissions?.has('residents.contacts.view') ?? false);
}

// ------------------------------------------------------------------ CSV export (BR-07-46)
/** A cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote, then quoted when needed. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const HEADER = [
  'Time',
  'Society id',
  'Society',
  'Actor',
  'Role',
  'Source',
  'Action',
  'Entity type',
  'Entity id',
  'Entity',
  'Reason',
  'IP',
  'Request id',
];

export interface PreparedExport {
  filename: string;
  rows: number;
  /** Writes the whole CSV in id order, batch by batch. */
  stream(write: (chunk: string) => Promise<void> | void): Promise<void>;
}

async function prepare(
  ctx: Ctx,
  f: AuditFilter,
  scope: { societyId: number | null; prefix: string; action: string },
): Promise<PreparedExport> {
  const { where, range } = await buildWhere({ ...f, cursor: undefined }, scope.societyId);
  const count = await AuditLog.count({ where });
  if (count > EXPORT_LIMIT)
    throw new UnprocessableError('EXPORT_TOO_LARGE', 'Too many rows to export. Narrow the filters.');
  const keys = await platformRoleKeys();
  const contacts = ctx.permissions?.has('residents.contacts.view') ?? false;
  await sequelize.transaction(t =>
    audit(
      ctx,
      {
        action: scope.action,
        entityType: ENTITY.auditLog,
        entityId: 'export',
        societyId: scope.societyId,
        after: {
          filters: { ...f, cursor: undefined, limit: undefined, from: range.fromDay, to: range.toDay },
          rows: count,
        },
      },
      t,
    ),
  );
  void contacts;
  const names = new Map<number, string>();
  return {
    filename: `${scope.prefix}-${range.fromDay}-${range.toDay}.csv`,
    rows: count,
    async stream(write) {
      await write(`${HEADER.join(',')}\r\n`);
      let before: number | null = null;
      for (;;) {
        const rows: AuditLog[] = await AuditLog.findAll({
          where: before ? { [Op.and]: [where, { id: { [Op.lt]: before } }] } : where,
          order: [['id', 'DESC']],
          limit: 2000,
        });
        if (!rows.length) break;
        const need = [
          ...new Set(rows.map(r => r.societyId).filter((x): x is number => x !== null && !names.has(x))),
        ];
        if (need.length)
          for (const s of await Society.findAll({
            where: { id: { [Op.in]: need } },
            attributes: ['id', 'name'],
          }))
            names.set(s.id!, s.name);
        let chunk = '';
        for (const r of rows) {
          const isPlatformActor = scope.societyId !== null && keys.includes(r.actorRole);
          const src = sourceOf(r, keys);
          chunk += `${[
            r.createdAt,
            r.societyId,
            r.societyId ? (names.get(r.societyId) ?? '') : '',
            isPlatformActor ? 'SocietyApp Support' : r.actorName,
            isPlatformActor ? 'platform' : r.actorRole,
            isPlatformActor ? 'SocietyApp Support' : SOURCE_LABEL[src],
            r.action,
            r.entityType,
            r.entityId,
            r.entityLabel,
            r.reason,
            isPlatformActor ? '' : r.ip,
            r.requestId,
          ]
            .map(csvCell)
            .join(',')}\r\n`;
        }
        await write(chunk);
        before = rows[rows.length - 1]!.id!;
        if (rows.length < 2000) break;
      }
    },
  };
}

export const preparePlatformExport = (ctx: Ctx, f: AuditFilter) =>
  prepare(ctx, f, { societyId: null, prefix: 'platform-audit', action: AUDIT.auditExported });
export const prepareSocietyExport = (ctx: Ctx, f: AuditFilter) =>
  prepare(ctx, f, { societyId: ctx.society!.id, prefix: 'audit-trail', action: AUDIT.societyAuditExported });

// ------------------------------------------------------------------ archives (8.9)
export interface ManifestEntry {
  month: string;
  part: number;
  objectKey: string;
  rowCount: number;
  minId: number;
  maxId: number;
  sha256: string;
  status: 'UPLOADED' | 'COMPLETED' | 'PURGED';
  archivedAt: string;
}

export async function listArchives() {
  const manifest = (await getPlatformSetting('audit.archiveManifest')) as unknown as ManifestEntry[];
  return {
    cutoff: ymd(await archiveCutoff()),
    archiveAfterMonths: await getPlatformSetting('audit.archiveAfterMonths'),
    paused: await getPlatformSetting('audit.archivePaused'),
    items: manifest.map(e => ({
      month: e.month,
      part: e.part,
      rowCount: e.rowCount,
      minId: e.minId,
      maxId: e.maxId,
      sha256: e.sha256,
      status: e.status,
      archivedAt: e.archivedAt,
    })),
  };
}

export async function archiveDownloadUrl(ctx: Ctx, input: { month: string; part: number }) {
  const manifest = (await getPlatformSetting('audit.archiveManifest')) as unknown as ManifestEntry[];
  const e = manifest.find(m => m.month === input.month && m.part === input.part && m.status === 'COMPLETED');
  if (!e) throw new NotFoundError('ARCHIVE_NOT_FOUND', 'No completed archive for that month');
  const signed = await opsPorts().storage.signedUrl(e.objectKey, 300);
  await sequelize.transaction(t =>
    audit(
      ctx,
      {
        action: AUDIT.auditDownloadIssued,
        entityType: ENTITY.auditLog,
        entityId: `${input.month}-p${input.part}`,
        after: { month: input.month, part: input.part },
      },
      t,
    ),
  );
  return signed;
}

export { archiveObjectKey };
