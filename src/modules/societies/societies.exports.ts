import { createHash } from 'node:crypto';
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { DataExport, Society, User, sequelize } from '../../models';
import type { ExportStatus } from '../../models/data-export.model';
import { addDays, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { enqueueAfterCommit } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, GoneError, NotFoundError, ValidationError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { setting, societyPorts } from './societies.ports';
import { AUDIT, JOBS, QUEUE } from './societies.types';
import { emitAfterCommit, groups, notifyAfterCommit } from './societies.notify';
import { ZipBuilder } from './societies.zip';

/** Full society data export (6.6, BR-05-22 to BR-05-24) and its provider registry. */

// ------------------------------------------------------------------ registry
export interface ExportTable {
  name: string;
  /** Path inside `data/<module>/`, e.g. `invoices.csv`. */
  file: string;
  stream(societyId: number): AsyncIterable<Record<string, unknown>>;
}
export interface ExportProvider {
  module: string;
  tables: ExportTable[];
}
const providers = new Map<string, ExportProvider>();

/** Every module that owns society tables registers one provider (idempotent by module). */
export function registerExportProvider(p: ExportProvider): void {
  providers.set(p.module, p);
}
export const exportProviders = (): ExportProvider[] => [...providers.values()];
/** Test helper. */
export const unregisterExportProvider = (module: string): boolean => providers.delete(module);

let partLimitBytes = 450 * 1024 * 1024;
/** Test helper: the part size at which a new zip part starts (450 MB in production). */
export function setExportPartLimit(bytes: number | null): void {
  partLimitBytes = bytes ?? 450 * 1024 * 1024;
}

// ------------------------------------------------------------------ CSV (UTF-8 BOM, RFC 4180, ISO dates, paise + rupees)
const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rupees = (paise: unknown) =>
  typeof paise === 'number' || (typeof paise === 'string' && /^-?\d+$/.test(paise))
    ? (Number(paise) / 100).toFixed(2)
    : '';

/** Adds a `…Rupees` column after every `…Paise` column. */
export function withRupees(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v;
    if (k.endsWith('Paise')) out[`${k.slice(0, -5)}Rupees`] = rupees(v);
  }
  return out;
}

export function toCsv(rows: Record<string, unknown>[]): { csv: Buffer; header: string[] } {
  const header: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(header.map(h => csvCell(r[h])).join(','));
  return { csv: Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'), header };
}

// ------------------------------------------------------------------ views
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
type ExportRow = DataExport & { requestedBy?: User | null };

export function exportView(e: ExportRow) {
  return {
    id: e.id!,
    kind: e.kind,
    requestedVia: e.requestedVia,
    requestedBy: e.requestedBy ? { id: e.requestedBy.id!, name: e.requestedBy.name ?? 'Member' } : null,
    reason: e.reason,
    status: e.status,
    progressPercent: e.progressPercent,
    includeDocuments: e.includeDocuments,
    partCount: e.partCount,
    totalSizeBytes: Number(e.totalSizeBytes),
    manifestSummary: e.manifestSummary
      ? {
          tables: e.manifestSummary.tables,
          rows: e.manifestSummary.rows,
          documents: e.manifestSummary.documents,
        }
      : null,
    errorCode: e.errorCode,
    startedAt: iso(e.startedAt),
    completedAt: iso(e.completedAt),
    expiresAt: iso(e.expiresAt),
    downloadCount: e.downloadCount,
    lastDownloadedAt: iso(e.lastDownloadedAt),
    createdAt: iso(e.createdAt),
  };
}
export type ExportView = ReturnType<typeof exportView>;

const include = [{ model: User, as: 'requestedBy', attributes: ['id', 'name'] }];
export const exportNotFound = () => new NotFoundError('DATA_EXPORT_NOT_FOUND', 'Export not found');

export async function listExports(
  societyId: number,
  q: { status?: ExportStatus; kind?: 'FULL' | 'CLOSURE'; page: number; limit: number },
) {
  const where: Record<string, unknown> = { societyId };
  if (q.status) where.status = q.status;
  if (q.kind) where.kind = q.kind;
  const { rows, count } = await DataExport.findAndCountAll({
    where,
    include,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  return { data: rows.map(r => exportView(r as ExportRow)), pagination: pageMeta(q.page, q.limit, count) };
}

export async function getExport(societyId: number, id: number): Promise<ExportView> {
  const e = (await DataExport.findOne({ where: { id, societyId }, include })) as ExportRow | null;
  if (!e) throw exportNotFound();
  return exportView(e);
}

// ------------------------------------------------------------------ request (8.17, 8.24)
const alreadyRunning = () =>
  new ConflictError('EXPORT_ALREADY_RUNNING', 'An export is already being prepared for this society');

export async function requestExport(
  ctx: Ctx,
  societyId: number,
  input: { includeDocuments: boolean; via: 'SOCIETY' | 'PLATFORM'; reason?: string },
): Promise<ExportView> {
  let id: number;
  try {
    id = await sequelize.transaction(async t => {
      const society = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!society) throw new NotFoundError('SOCIETY_NOT_FOUND', 'Society not found');
      if (society.purgedAt)
        throw new ConflictError('SOCIETY_PURGED', 'The data of this society has already been purged');
      if (input.via === 'SOCIETY' && society.status === 'CLOSED')
        throw new AppError(423, 'SOCIETY_CLOSED', 'This society is closed');
      const running = await DataExport.count({
        where: { societyId, status: { [Op.in]: ['QUEUED', 'RUNNING'] } },
        transaction: t,
      });
      if (running) throw alreadyRunning();
      const max = await setting('exports.maxPerSocietyPer24h');
      const recent = await DataExport.count({
        where: { societyId, kind: 'FULL', createdAt: { [Op.gt]: addDays(now(), -1) } },
        transaction: t,
      });
      if (recent >= max)
        throw new AppError(429, 'EXPORT_RATE_LIMITED', `At most ${max} full exports in 24 hours`);
      const e = await DataExport.create(
        {
          societyId,
          kind: 'FULL',
          requestedVia: input.via,
          requestedByUserId: ctx.user?.id ?? null,
          reason: input.reason ?? null,
          includeDocuments: input.includeDocuments,
          status: 'QUEUED',
          progressPercent: 0,
          fileIds: null,
          partCount: 0,
          totalSizeBytes: 0,
          manifestSummary: null,
          attempts: 0,
          errorCode: null,
          startedAt: null,
          completedAt: null,
          expiresAt: null,
          downloadCount: 0,
          lastDownloadedAt: null,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.exportRequested,
          entityType: 'data_export',
          entityId: e.id!,
          societyId,
          after: { kind: 'FULL', requestedVia: input.via, includeDocuments: input.includeDocuments },
          reason: input.reason ?? null,
        },
        t,
      );
      enqueueAfterCommit(t, QUEUE, JOBS.buildExport, { exportId: e.id! }, { jobId: `build-export:${e.id}` });
      return e.id!;
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw alreadyRunning();
    throw err;
  }
  return getExport(societyId, id);
}

/** Close transaction (BR-05-18, 14): a CLOSURE export is queued unless one is running (the job queues it when that ends). */
export async function queueClosureExport(
  ctx: Ctx,
  societyId: number,
  t: Transaction,
): Promise<number | null> {
  const running = await DataExport.findOne({
    where: { societyId, status: { [Op.in]: ['QUEUED', 'RUNNING'] } },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (running) return null;
  const e = await DataExport.create(
    {
      societyId,
      kind: 'CLOSURE',
      requestedVia: 'SYSTEM',
      requestedByUserId: null,
      reason: null,
      includeDocuments: true,
      status: 'QUEUED',
      progressPercent: 0,
      fileIds: null,
      partCount: 0,
      totalSizeBytes: 0,
      manifestSummary: null,
      attempts: 0,
      errorCode: null,
      startedAt: null,
      completedAt: null,
      expiresAt: null,
      downloadCount: 0,
      lastDownloadedAt: null,
      createdBy: null,
      updatedBy: null,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.exportRequested,
      entityType: 'data_export',
      entityId: e.id!,
      societyId,
      after: { kind: 'CLOSURE', requestedVia: 'SYSTEM' },
      actor: { userId: null, name: 'System', role: 'system' },
    },
    t,
  );
  enqueueAfterCommit(t, QUEUE, JOBS.buildExport, { exportId: e.id! }, { jobId: `build-export:${e.id}` });
  return e.id!;
}

export async function latestClosureExportId(societyId: number, t?: Transaction): Promise<number | null> {
  const e = await DataExport.findOne({
    where: { societyId, kind: 'CLOSURE' },
    order: [['id', 'DESC']],
    attributes: ['id'],
    transaction: t,
  });
  return e?.id ?? null;
}

// ------------------------------------------------------------------ download (BR-05-23, BR-05-24)
export async function downloadUrl(ctx: Ctx, societyId: number, id: number, part: number) {
  return sequelize.transaction(async t => {
    const e = await DataExport.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!e) throw exportNotFound();
    if (e.status === 'EXPIRED' || (e.status === 'READY' && e.expiresAt && e.expiresAt <= now()))
      throw new GoneError('EXPORT_EXPIRED', 'The download window of this export has passed');
    if (e.status !== 'READY') throw new ConflictError('EXPORT_NOT_READY', 'This export is not ready yet');
    if (part < 1 || part > e.partCount)
      throw new ValidationError([{ field: 'part', message: `Must be 1 to ${e.partCount}` }]);
    const fileId = (e.fileIds ?? [])[part - 1]!;
    const link = await societyPorts().files.downloadUrl(fileId, 5);
    e.downloadCount += 1;
    e.lastDownloadedAt = now();
    await e.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.exportDownloaded,
        entityType: 'data_export',
        entityId: e.id!,
        societyId,
        after: { part },
      },
      t,
    );
    const society = await Society.findByPk(societyId, { attributes: ['slug'], transaction: t });
    const sizes = (e.manifestSummary as { partSizes?: number[] } | null)?.partSizes;
    return {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      fileName: partName(society?.slug ?? 'society', e.startedAt ?? e.createdAt!, part),
      sizeBytes: sizes?.[part - 1] ?? null,
    };
  });
}

const stamp = (d: Date) => {
  const x = new Date(d.getTime() + 5.5 * 3_600_000).toISOString();
  return `${x.slice(0, 4)}${x.slice(5, 7)}${x.slice(8, 10)}-${x.slice(11, 13)}${x.slice(14, 16)}`;
};
export const partName = (slug: string, at: Date, part: number) =>
  `${slug}-export-${stamp(at)}-part-${String(part).padStart(3, '0')}.zip`;

// ------------------------------------------------------------------ build job (6.6)
const README = `SocietyApp data export

data/<module>/<table>.csv   One CSV per table. UTF-8 with BOM, comma separated, first row is the header.
                            Times are ISO 8601 UTC, dates YYYY-MM-DD. Money is integer paise in ...Paise
                            columns, with a ...Rupees column (2 decimals) next to it.
documents/<purpose>/        Files uploaded to the society (when documents were included).
manifest.json               What this archive contains, row counts and SHA-256 of every document.

To open a CSV in Excel: Data > From Text/CSV, pick the file, choose UTF-8 and comma.
`;

const MAX_ATTEMPTS = 3;

/** `societies:build-export`. Exits unless QUEUED or RUNNING; a retry starts again and deletes partial files. */
export async function buildExport(exportId: number): Promise<void> {
  const e = await DataExport.findByPk(exportId);
  if (!e || (e.status !== 'QUEUED' && e.status !== 'RUNNING')) return;
  const society = await Society.findByPk(e.societyId);
  if (!society) return;
  for (const f of e.fileIds ?? []) await societyPorts().files.deleteFile(f);
  e.status = 'RUNNING';
  e.startedAt = now();
  e.attempts += 1;
  e.progressPercent = 0;
  e.fileIds = null;
  e.partCount = 0;
  await e.save();
  const progress = async (pct: number) => {
    e.progressPercent = Math.min(99, pct);
    await e.save({ fields: ['progressPercent', 'updatedAt'] });
    if (e.requestedByUserId)
      emitAfterCommit(null, [
        {
          userId: e.requestedByUserId,
          event: 'data_export.progress',
          payload: { exportId: e.id!, status: e.status, progressPercent: e.progressPercent },
        },
      ]);
  };

  const parts: ZipBuilder[] = [new ZipBuilder(e.startedAt)];
  const tables: { file: string; rows: number }[] = [];
  const files: { path: string; sha256: string }[] = [];
  let currentModule = '';
  const add = (name: string, data: Buffer) => {
    let z = parts[parts.length - 1]!;
    if (z.entries > 0 && z.size + ZipBuilder.estimate(name, data) > partLimitBytes) {
      z = new ZipBuilder(e.startedAt!);
      parts.push(z);
    }
    z.add(name, data);
  };
  try {
    const list = exportProviders();
    let done = 0;
    for (const p of list) {
      currentModule = p.module;
      for (const tbl of p.tables) {
        const rows: Record<string, unknown>[] = [];
        for await (const r of tbl.stream(e.societyId)) rows.push(withRupees(r));
        const path = `data/${p.module}/${tbl.file}`;
        add(path, toCsv(rows).csv);
        tables.push({ file: path, rows: rows.length });
      }
      done++;
      await progress(Math.round((done / Math.max(1, list.length)) * 90));
    }
    currentModule = '';
    if (e.includeDocuments)
      for (const d of await societyPorts().files.listSocietyDocuments(e.societyId)) {
        const safe = d.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
        const path = `documents/${d.purpose}/${d.fileId}-${safe}`;
        add(path, d.content);
        files.push({ path, sha256: createHash('sha256').update(d.content).digest('hex') });
      }
    const summary = {
      tables: tables.length,
      rows: tables.reduce((a, b) => a + b.rows, 0),
      documents: files.length,
    };
    const fileIds: number[] = [];
    const partSizes: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const z = parts[i]!;
      const manifest = {
        societyId: society.id,
        societyName: society.name,
        kind: e.kind,
        generatedAt: e.startedAt!.toISOString(),
        part: i + 1,
        parts: parts.length,
        tables,
        files,
      };
      z.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      z.add('README.txt', Buffer.from(README));
      const content = z.finish();
      const stored = await societyPorts().files.storeSystemFile({
        societyId: society.id!,
        purpose: 'EXPORT_FILE',
        content,
        name: partName(society.slug, e.startedAt!, i + 1),
        contentType: 'application/zip',
        ownerUserId: e.requestedByUserId,
      });
      fileIds.push(stored.fileId);
      partSizes.push(stored.sizeBytes);
      e.fileIds = [...fileIds];
      await e.save({ fields: ['fileIds', 'updatedAt'] });
    }
    const closureWindow = e.kind === 'CLOSURE' || society.status === 'CLOSED';
    const days = await setting(
      closureWindow ? 'exports.closureExportDownloadDays' : 'exports.fullExportDownloadDays',
    );
    await sequelize.transaction(async t => {
      e.status = 'READY';
      e.progressPercent = 100;
      e.completedAt = now();
      e.expiresAt = addDays(e.completedAt, days);
      e.partCount = parts.length;
      e.totalSizeBytes = partSizes.reduce((a, b) => a + b, 0);
      e.manifestSummary = { ...summary, partSizes } as never;
      await e.save({ transaction: t });
      await audit(
        { requestId: 'job', ip: '', userAgent: '' },
        {
          action: AUDIT.exportReady,
          entityType: 'data_export',
          entityId: e.id!,
          societyId: e.societyId,
          after: { parts: e.partCount, totalSizeBytes: e.totalSizeBytes, ...summary },
          actor: { userId: null, name: 'System', role: 'system' },
        },
        t,
      );
      notifyExport(t, e, 'data_export.ready', society.name);
    });
  } catch (err) {
    logger.warn({ err, exportId, module: currentModule }, 'export build failed');
    if (e.attempts < MAX_ATTEMPTS) throw err; // the queue retries; the next attempt starts from scratch
    await sequelize.transaction(async t => {
      e.status = 'FAILED';
      e.errorCode = (currentModule ? `PROVIDER_FAILED:${currentModule}` : 'STORAGE_ERROR').slice(0, 40);
      await e.save({ transaction: t });
      await audit(
        { requestId: 'job', ip: '', userAgent: '' },
        {
          action: AUDIT.exportFailed,
          entityType: 'data_export',
          entityId: e.id!,
          societyId: e.societyId,
          after: { errorCode: e.errorCode },
          actor: { userId: null, name: 'System', role: 'system' },
        },
        t,
      );
      notifyExport(t, e, 'data_export.failed', society.name);
    });
    for (const f of e.fileIds ?? []) await societyPorts().files.deleteFile(f);
  }
  await queueMissingClosureExport(e.societyId);
}

function notifyExport(t: Transaction, e: DataExport, template: string, societyName: string): void {
  const data = { societyName, exportId: e.id!, kind: e.kind, expiresAt: iso(e.expiresAt) };
  const sid = e.societyId;
  if (e.requestedVia === 'SOCIETY' && e.requestedByUserId)
    notifyAfterCommit(t, template, [e.requestedByUserId], data);
  else notifyAfterCommit(t, template, () => groups.exportViewers(sid), data);
}

/** A society closed while another export was running gets its CLOSURE export when that one ends (14). */
async function queueMissingClosureExport(societyId: number): Promise<void> {
  const s = await Society.findByPk(societyId, { attributes: ['id', 'status', 'closedAt', 'purgedAt'] });
  if (!s || s.status !== 'CLOSED' || s.purgedAt || !s.closedAt) return;
  const has = await DataExport.count({
    where: { societyId, kind: 'CLOSURE', createdAt: { [Op.gte]: s.closedAt } },
  });
  if (has) return;
  await sequelize.transaction(t =>
    queueClosureExport({ requestId: 'job', ip: '', userAgent: '' }, societyId, t),
  );
}

/** `societies:expire-exports` (hourly): READY past `expiresAt` → files deleted → EXPIRED; CLOSURE expiring in 3 days → notice. */
export async function expireExports(): Promise<{ expired: number; warned: number }> {
  const t0 = now();
  const due = await DataExport.findAll({ where: { status: 'READY', expiresAt: { [Op.lte]: t0 } } });
  let expired = 0;
  for (const e of due) {
    await sequelize.transaction(async t => {
      const row = await DataExport.findByPk(e.id!, { transaction: t, lock: t.LOCK.UPDATE });
      if (!row || row.status !== 'READY') return;
      for (const f of row.fileIds ?? []) await societyPorts().files.deleteFile(f);
      row.status = 'EXPIRED';
      await row.save({ transaction: t });
      await audit(
        { requestId: 'job', ip: '', userAgent: '' },
        {
          action: AUDIT.exportExpired,
          entityType: 'data_export',
          entityId: row.id!,
          societyId: row.societyId,
          actor: { userId: null, name: 'System', role: 'system' },
        },
        t,
      );
      expired++;
    });
  }
  // 3 days before a CLOSURE export expires (one notice per hourly window)
  const soon = await DataExport.findAll({
    where: {
      status: 'READY',
      kind: 'CLOSURE',
      expiresAt: { [Op.gt]: addDays(t0, 3), [Op.lte]: new Date(addDays(t0, 3).getTime() + 3_600_000) },
    },
  });
  for (const e of soon) {
    const s = await Society.findByPk(e.societyId, { attributes: ['id', 'name'] });
    notifyAfterCommit(null, 'data_export.expiring', () => groups.exportViewers(e.societyId), {
      societyName: s?.name,
      expiresAt: iso(e.expiresAt),
    });
  }
  return { expired, warned: soon.length };
}
