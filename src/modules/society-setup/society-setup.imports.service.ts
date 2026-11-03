import { QueryTypes, type Transaction } from 'sequelize';
import { Building, Society, Unit, sequelize } from '../../models';
import { enqueue } from '../../lib/queue';
import { emitToUser } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { societyPorts } from '../societies/societies.ports';
import { toCsv } from './society-setup.csv';
import { adjustFlats, isCountable } from './society-setup.limits';
import { notifyUser } from './society-setup.notify';
import { createBuildingCore } from './society-setup.buildings.service';
import { setupPorts } from './society-setup.ports';
import { actorCtx, invalidState, isUniqueViolation } from './society-setup.shared';
import { billingArea } from './society-setup.units.service';
import { get as getSetting } from './society-setup.settings.service';
import { AUDIT, ENTITY, JOBS, SOCIETY_SETUP_QUEUE, type AreaBasis } from './society-setup.types';
import { parseImportFile } from './society-setup.imports.parse';
import {
  mapSheet,
  planImport,
  type ImportMode,
  type Plan,
  type PlannedRow,
  type UnitValues,
} from './society-setup.imports.rules';
import {
  loadRows,
  loadState,
  newState,
  nextImportId,
  releaseLock,
  saveRows,
  saveState,
  takeLock,
  type CommitPolicy,
  type ImportIssue,
  type ImportState,
} from './society-setup.imports.state';

/**
 * Unit import (module 08 sections 6.2, 8.15 to 8.17, 9.1). The routes only create or move the Redis state and enqueue;
 * the jobs `validate-import` and `commit-import` do the work. A job exits unless the state is in the status it expects,
 * so a retry or a second worker changes nothing.
 */
const PREVIEW_ERRORS = 50;
const INSERT_CHUNK = 100;

const notFound = () => new NotFoundError('IMPORT_NOT_FOUND', 'Import not found or expired');
const inProgress = () =>
  new AppError(409, 'IMPORT_IN_PROGRESS', 'Another import of this society is still running');

const link = (importId: number) => `/settings/structure?import=${importId}`;

async function ownState(societyId: number, importId: number): Promise<ImportState> {
  const s = await loadState(importId);
  if (!s || s.societyId !== societyId) throw notFound();
  return s;
}

function emitUpdated(s: ImportState): void {
  emitToUser(s.userId, 'setup.import.updated', { importId: s.importId, status: s.status, counts: s.counts });
}

// ------------------------------------------------------------------ routes
export async function startImport(
  ctx: Ctx,
  societyId: number,
  input: { fileId: number; mode: ImportMode; createMissingBuildings: boolean },
): Promise<{ importId: number; status: 'VALIDATING' }> {
  const userId = ctx.user!.id;
  const file = await setupPorts().files.getImportFile(societyId, userId, input.fileId);
  const importId = await nextImportId();
  if (!(await takeLock(societyId, importId))) throw inProgress();
  try {
    await saveState(
      newState({
        importId,
        societyId,
        userId,
        fileId: input.fileId,
        fileName: file.name.slice(0, 200),
        mode: input.mode,
        createMissingBuildings: input.createMissingBuildings,
      }),
    );
    await enqueue(SOCIETY_SETUP_QUEUE, JOBS.validateImport, {
      importId,
      societyId,
      userId,
      requestId: ctx.requestId,
    });
  } catch (err) {
    await releaseLock(societyId, importId);
    throw err;
  }
  return { importId, status: 'VALIDATING' };
}

export async function getImport(societyId: number, importId: number) {
  const s = await ownState(societyId, importId);
  return {
    importId: s.importId,
    status: s.status,
    mode: s.mode,
    fileName: s.fileName,
    totalRows: s.totalRows,
    counts: s.counts,
    errorsPreview: s.errorsPreview,
    reportFileId: s.reportFileId,
    commitPolicy: s.commitPolicy,
    result: s.result,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
  };
}

export async function commitImport(
  ctx: Ctx,
  societyId: number,
  importId: number,
  commitPolicy: CommitPolicy,
): Promise<{ importId: number; status: 'COMMITTING' }> {
  const s = await ownState(societyId, importId);
  if (s.status !== 'VALIDATED') throw invalidState('Only a checked import can be committed');
  if (commitPolicy === 'ALL_OR_NOTHING' && s.counts.error > 0)
    throw new UnprocessableError('IMPORT_HAS_ERRORS', 'The sheet has rows with problems', [
      { field: 'commitPolicy', message: `${s.counts.error} rows have problems` },
    ]);
  if (s.counts.create + s.counts.update === 0)
    throw new UnprocessableError('IMPORT_NOTHING_TO_COMMIT', 'There is nothing to write', [
      { field: 'importId', message: 'No row would be created or updated' },
    ]);
  if (!(await takeLock(societyId, importId))) throw inProgress();
  try {
    s.status = 'COMMITTING';
    s.commitPolicy = commitPolicy;
    await saveState(s);
    await enqueue(SOCIETY_SETUP_QUEUE, JOBS.commitImport, {
      importId,
      societyId,
      userId: ctx.user!.id,
      requestId: ctx.requestId,
    });
  } catch (err) {
    await releaseLock(societyId, importId);
    throw err;
  }
  emitUpdated(s);
  return { importId, status: 'COMMITTING' };
}

// ------------------------------------------------------------------ report
async function writeReport(s: ImportState, rows: PlannedRow[]): Promise<number | null> {
  const errors = rows.filter(r => r.action === 'ERROR');
  if (!errors.length) return null;
  const content = toCsv(
    ['Row', 'Column', 'Value', 'Code', 'Message'],
    errors.map(r => [r.row, r.issue!.column, r.issue!.value, r.issue!.code, r.issue!.message]),
  );
  const f = await societyPorts().files.storeSystemFile({
    societyId: s.societyId,
    purpose: 'EXPORT_FILE',
    content,
    name: `unit-import-${s.importId}-errors.csv`,
    contentType: 'text/csv',
    ownerUserId: s.userId,
  });
  return f.fileId;
}

const issuesOf = (rows: PlannedRow[]): ImportIssue[] =>
  rows
    .filter(r => r.action === 'ERROR')
    .slice(0, PREVIEW_ERRORS)
    .map(r => ({ row: r.row, ...r.issue! }));

const failureOf = (err: unknown): { code: string; message: string } =>
  err instanceof AppError
    ? { code: err.code, message: err.message }
    : { code: 'INTERNAL_ERROR', message: 'The import failed. Try again.' };

// ------------------------------------------------------------------ job: validate-import
export interface ImportJobData {
  importId: number;
  societyId: number;
  userId: number;
  requestId: string;
}

export async function runValidateImport(d: ImportJobData): Promise<void> {
  const s = await loadState(d.importId);
  if (!s || s.societyId !== d.societyId || s.status !== 'VALIDATING') return;
  try {
    const file = await setupPorts().files.getImportFile(s.societyId, s.userId, s.fileId);
    const sheet = mapSheet(await parseImportFile(file.content));
    const plan = await planImport({
      societyId: s.societyId,
      mode: s.mode,
      createMissingBuildings: s.createMissingBuildings,
      sheet,
    });
    s.status = 'VALIDATED';
    s.totalRows = sheet.rows.length;
    s.counts = plan.counts;
    s.errorsPreview = issuesOf(plan.rows);
    s.limitRows = plan.limitRows;
    s.reportFileId = await writeReport(s, plan.rows);
    await saveRows(s, sheet);
  } catch (err) {
    const f = failureOf(err);
    if (f.code === 'INTERNAL_ERROR') logger.error({ err, importId: s.importId }, 'import validation failed');
    s.status = 'FAILED';
    s.result = { written: 0, skipped: 0, failureCode: f.code, failureMessage: f.message };
  }
  await saveState(s);
  await releaseLock(s.societyId, s.importId);
  emitUpdated(s);
  await notifyUser('setup.import.validated', s.societyId, s.userId, {
    importId: s.importId,
    status: s.status,
    counts: s.counts,
    failureCode: s.result?.failureCode ?? null,
    link: link(s.importId),
  });
}

// ------------------------------------------------------------------ job: commit-import
async function lockSociety(societyId: number, t: Transaction): Promise<void> {
  await sequelize.query('SELECT id FROM societies WHERE id = :societyId FOR UPDATE', {
    replacements: { societyId },
    type: QueryTypes.SELECT,
    transaction: t,
  });
}

/** Writes the plan inside the commit transaction. Returns the number of units written. */
async function writePlan(
  ctx: Ctx,
  s: ImportState,
  plan: Plan,
  basis: AreaBasis,
  t: Transaction,
): Promise<number> {
  const societyId = s.societyId;
  const userId = ctx.user?.id ?? null;
  const buildingIds = new Map<string, number>();
  for (const r of plan.rows) if (r.buildingId !== null) buildingIds.set(r.buildingCode, r.buildingId);

  if (plan.newBuildings.size) {
    const [max] = (await Building.findAll({
      where: { societyId },
      attributes: ['sortOrder'],
      order: [['sortOrder', 'DESC']],
      limit: 1,
      transaction: t,
    })) as { sortOrder: number }[];
    let sortOrder = (max?.sortOrder ?? 0) + 1;
    for (const [code, span] of plan.newBuildings) {
      const b = await createBuildingCore(
        ctx,
        societyId,
        {
          code,
          name: `Tower ${code}`,
          kind: 'TOWER',
          floorsAboveGround: Math.max(span.maxFloor, 0),
          basements: Math.max(0, -span.minFloor),
          sortOrder: Math.min(sortOrder++, 9999),
        },
        t,
      );
      buildingIds.set(code, b.id!);
    }
  }

  const creates = plan.rows.filter(r => r.action === 'CREATE');
  const updates = plan.rows.filter(r => r.action === 'UPDATE');
  let delta = creates.filter(r => isCountable(r.create!.unitType)).length;
  for (const r of updates) {
    const u = r.update!;
    const nextType = u.set.unitType ?? u.unit.unitType;
    delta += Number(isCountable(nextType)) - Number(isCountable(u.unit.unitType));
  }
  await adjustFlats(ctx, societyId, delta, t);

  for (let i = 0; i < creates.length; i += INSERT_CHUNK) {
    const rows = creates.slice(i, i + INSERT_CHUNK).map(r => {
      const v = r.create as UnitValues;
      return {
        societyId,
        buildingId: buildingIds.get(r.buildingCode)!,
        unitNumber: r.unitNumber,
        label: `${r.buildingCode}-${r.unitNumber}`,
        floor: v.floor,
        positionOnFloor: null,
        unitType: v.unitType,
        bhk: v.bhk,
        carpetAreaSqft: v.carpetAreaSqft,
        builtUpAreaSqft: v.builtUpAreaSqft,
        superBuiltUpAreaSqft: v.superBuiltUpAreaSqft,
        areaSqft: billingArea(v, basis),
        undividedSharePct: v.undividedSharePct,
        isBillable: v.isBillable,
        possessionDate: v.possessionDate,
        notes: v.notes,
        status: 'ACTIVE' as const,
        archivedAt: null,
        archivedReason: null,
        archivedBy: null,
        version: 1,
        createdBy: userId,
        updatedBy: userId,
      };
    });
    try {
      await Unit.bulkCreate(rows as never, { transaction: t });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new UnprocessableError('IMPORT_STALE', 'Some units were created by someone else meanwhile');
      throw err;
    }
  }

  for (const r of updates) {
    const { unit, set, before } = r.update!;
    unit.set(set as never);
    unit.areaSqft = billingArea(unit, basis);
    unit.version += 1;
    unit.updatedBy = userId;
    await unit.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.unitUpdated,
        entityType: ENTITY.unit,
        entityId: unit.id,
        entityLabel: unit.label,
        societyId,
        before,
        after: set,
      },
      t,
    );
  }
  return creates.length + updates.length;
}

export async function runCommitImport(d: ImportJobData): Promise<void> {
  const s = await loadState(d.importId);
  if (!s || s.societyId !== d.societyId || s.status !== 'COMMITTING' || !s.commitPolicy) return;
  const policy = s.commitPolicy;
  try {
    const society = await Society.findByPk(s.societyId, { attributes: ['status'] });
    if (society?.status === 'SUSPENDED' || society?.status === 'CLOSED')
      throw new AppError(423, `SOCIETY_${society.status}`, `The society is ${society.status.toLowerCase()}`);
    const sheet = await loadRows(s.importId);
    if (!sheet) throw notFound();
    const ctx = await actorCtx(s.userId, d.requestId);
    const basis = (await getSetting(s.societyId, 'billing.areaBasis')) as AreaBasis;
    const { plan, written } = await sequelize.transaction(async t => {
      if ('undividedSharePct' in sheet.columns) await lockSociety(s.societyId, t);
      const plan = await planImport({
        societyId: s.societyId,
        mode: s.mode,
        createMissingBuildings: s.createMissingBuildings,
        sheet,
        t,
        carryLimitRows: new Set(s.limitRows),
      });
      if (policy === 'ALL_OR_NOTHING' && plan.counts.error > 0)
        throw new UnprocessableError(
          'IMPORT_STALE',
          'The data changed since the check. Upload the sheet again.',
          [{ field: 'importId', message: `${plan.counts.error} rows now have problems` }],
        );
      const written = await writePlan(ctx, s, plan, basis, t);
      await audit(
        ctx,
        {
          action: AUDIT.importCommitted,
          entityType: ENTITY.import,
          entityId: s.importId,
          entityLabel: s.fileName,
          societyId: s.societyId,
          after: {
            mode: s.mode,
            commitPolicy: policy,
            totalRows: sheet.rows.length,
            counts: plan.counts,
            written,
            skipped: sheet.rows.length - written,
          },
        },
        t,
      );
      return { plan, written };
    });
    s.counts = plan.counts;
    s.errorsPreview = issuesOf(plan.rows);
    s.reportFileId = (await writeReport(s, plan.rows)) ?? s.reportFileId;
    s.status = plan.counts.error > 0 ? 'COMMITTED_PARTIAL' : 'COMMITTED';
    s.result = { written, skipped: sheet.rows.length - written, failureCode: null };
  } catch (err) {
    const f = failureOf(err);
    if (f.code === 'INTERNAL_ERROR') logger.error({ err, importId: s.importId }, 'import commit failed');
    s.status = 'FAILED';
    s.result = { written: 0, skipped: 0, failureCode: f.code, failureMessage: f.message };
  }
  await saveState(s);
  await releaseLock(s.societyId, s.importId);
  emitUpdated(s);
  await notifyUser(
    s.status === 'FAILED' ? 'setup.import.failed' : 'setup.import.committed',
    s.societyId,
    s.userId,
    {
      importId: s.importId,
      written: s.result?.written ?? 0,
      skipped: s.result?.skipped ?? 0,
      failureCode: s.result?.failureCode ?? null,
      link: link(s.importId),
    },
  );
}
