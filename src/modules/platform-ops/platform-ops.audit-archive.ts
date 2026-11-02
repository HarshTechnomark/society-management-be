import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Op } from 'sequelize';
import { AuditLog, PlatformSetting, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { env } from '../../lib/env';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { systemCtx } from '../../types/context';
import { AUDIT, ENTITY } from './platform-ops.types';
import { getPlatformSetting, seedPlatformSettings } from './platform-ops.settings.service';
import { opsPorts } from './platform-ops.ports';
import { notifyNow, platformUsersWith } from './platform-ops.notify';

/**
 * Audit archive (module 07 section 6.6, BR-07-47), job `platform-ops:audit-archive`: one month per run. This file is the
 * only code that deletes `audit_logs` rows (a lint rule forbids the statement anywhere else).
 */
const BATCH = 5000;
const MANIFEST_KEY = 'audit.archiveManifest';

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

const pad = (n: number) => String(n).padStart(2, '0');
export const monthOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
const monthStart = (m: string) => new Date(`${m}-01T00:00:00.000Z`);
const nextMonth = (m: string) => {
  const d = monthStart(m);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
};

/** `<env>/<prefix>/<yyyy>/<mm>/audit_logs-<yyyy>-<mm>[-p<part>].ndjson.gz` */
export function archiveObjectKey(month: string, part: number): string {
  const [y, m] = month.split('-');
  return `${env().NODE_ENV}/${env().AUDIT_ARCHIVE_PREFIX}/${y}/${m}/audit_logs-${y}-${m}${part > 1 ? `-p${part}` : ''}.ndjson.gz`;
}

async function readManifest(): Promise<ManifestEntry[]> {
  return (await getPlatformSetting(MANIFEST_KEY)) as unknown as ManifestEntry[];
}

/** Locks the manifest row `FOR UPDATE` and lets `fn` change the list. */
async function updateManifest(fn: (list: ManifestEntry[]) => ManifestEntry[]): Promise<void> {
  await seedPlatformSettings();
  await sequelize.transaction(async t => {
    const row = await PlatformSetting.findOne({
      where: { settingKey: MANIFEST_KEY },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row) return;
    const next = fn([...((row.valueJson as ManifestEntry[]) ?? [])]);
    await row.update({ valueJson: next, version: row.version + 1 }, { transaction: t });
  });
  await kv().cacheDel(`ps:${MANIFEST_KEY}`);
}

async function deleteRows(minId: number, maxId: number, cutoff: Date): Promise<void> {
  // the only DELETE on audit_logs in the code base (rows are archived and verified first)
  for (let a = minId; a <= maxId; a += BATCH)
    await sequelize.query('DELETE FROM audit_logs WHERE id BETWEEN :a AND :b AND createdAt < :cutoff', {
      replacements: { a, b: Math.min(a + BATCH - 1, maxId), cutoff },
    });
}

export interface ArchiveResult {
  archivedMonth: string | null;
  rows: number;
  purged: number;
  paused?: boolean;
}

export async function runAuditArchive(): Promise<ArchiveResult> {
  const result: ArchiveResult = { archivedMonth: null, rows: 0, purged: 0 };
  if (await getPlatformSetting('audit.archivePaused')) return { ...result, paused: true };
  const months = await getPlatformSetting('audit.archiveAfterMonths');
  const t0 = now();
  const cutoff = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() - months, 1));
  const sys = systemCtx('job');
  const manifest = await readManifest();

  // a crash between upload and delete: finish the delete of the UPLOADED entry first
  const pending = manifest.find(e => e.status === 'UPLOADED');
  if (pending) {
    await deleteRows(pending.minId, pending.maxId, cutoff);
    await completeEntry(pending, sys);
    result.archivedMonth = pending.month;
    result.rows = pending.rowCount;
  } else {
    const oldest = (await AuditLog.findOne({
      where: { createdAt: { [Op.lt]: cutoff } },
      order: [['createdAt', 'ASC']],
      attributes: ['createdAt'],
    })) as AuditLog | null;
    if (oldest) {
      const month = monthOf(oldest.createdAt!);
      const part = Math.max(0, ...manifest.filter(e => e.month === month).map(e => e.part)) + 1;
      const entry = await uploadMonth(month, part);
      if (entry) {
        await updateManifest(l => [...l, entry]);
        await deleteRows(entry.minId, entry.maxId, cutoff);
        await completeEntry(entry, sys);
        result.archivedMonth = month;
        result.rows = entry.rowCount;
      }
    }
  }
  result.purged = await purgeOld();
  return result;
}

async function completeEntry(e: ManifestEntry, sys: ReturnType<typeof systemCtx>): Promise<void> {
  await updateManifest(l =>
    l.map(x => (x.month === e.month && x.part === e.part ? { ...x, status: 'COMPLETED' as const } : x)),
  );
  await sequelize.transaction(t =>
    audit(
      sys,
      {
        action: AUDIT.auditArchived,
        entityType: ENTITY.auditLog,
        entityId: `${e.month}-p${e.part}`,
        after: { month: e.month, part: e.part, rowCount: e.rowCount, sha256: e.sha256 },
      },
      t,
    ),
  );
}

/** Steps 5 and 6: stream the month into a gzip NDJSON object, re-read it and compare count and hash. */
async function uploadMonth(month: string, part: number): Promise<ManifestEntry | null> {
  const from = monthStart(month);
  const to = nextMonth(month);
  const hash = createHash('sha256');
  const lines: string[] = [];
  let rowCount = 0;
  let minId = 0;
  let maxId = 0;
  let after = 0;
  for (;;) {
    const rows = await AuditLog.findAll({
      where: { createdAt: { [Op.gte]: from, [Op.lt]: to }, id: { [Op.gt]: after } },
      order: [['id', 'ASC']],
      limit: BATCH,
    });
    if (!rows.length) break;
    for (const r of rows) {
      const line = `${JSON.stringify(r.toJSON())}\n`;
      hash.update(line);
      lines.push(line);
      rowCount += 1;
      minId = minId || r.id!;
      maxId = r.id!;
    }
    after = rows[rows.length - 1]!.id!;
  }
  if (!rowCount) return null;
  const sha256 = hash.digest('hex');
  const key = archiveObjectKey(month, part);
  const storage = opsPorts().storage;
  await storage.putObject(key, gzipSync(Buffer.from(lines.join(''))), 'application/gzip');
  let ok = false;
  try {
    const back = await storage.getObject(key);
    if (back) {
      const text = gunzipSync(back);
      ok =
        text.toString('utf8').split('\n').filter(Boolean).length === rowCount &&
        createHash('sha256').update(text).digest('hex') === sha256;
    }
  } catch (err) {
    logger.warn({ err, month }, 'archive verification could not read the object');
  }
  if (!ok) {
    await storage.deleteObject(key);
    await notifyNow('platform.audit_archive.failed', () => platformUsersWith('platform.settings.edit'), {
      month,
      part,
    });
    throw new Error(`Audit archive verification failed for ${month}`);
  }
  return {
    month,
    part,
    objectKey: key,
    rowCount,
    minId,
    maxId,
    sha256,
    status: 'UPLOADED',
    archivedAt: now().toISOString(),
  };
}

/** Step 9: archives whose month ended more than 8 years ago are deleted and marked PURGED (never removed from the manifest). */
async function purgeOld(): Promise<number> {
  const t0 = now();
  const limit = new Date(Date.UTC(t0.getUTCFullYear() - 8, t0.getUTCMonth(), t0.getUTCDate()));
  const old = (await readManifest()).filter(e => e.status === 'COMPLETED' && nextMonth(e.month) < limit);
  for (const e of old) await opsPorts().storage.deleteObject(e.objectKey);
  if (old.length)
    await updateManifest(l =>
      l.map(x =>
        old.some(o => o.month === x.month && o.part === x.part) ? { ...x, status: 'PURGED' as const } : x,
      ),
    );
  return old.length;
}
