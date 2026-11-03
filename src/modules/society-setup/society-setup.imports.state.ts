import { kv } from '../../lib/kv';
import { addDays, now, nowMs } from '../../lib/clock';
import type { ImportCounts, ImportMode, MappedSheet, RowIssue } from './society-setup.imports.rules';

/**
 * Import state (BR-08-35): one JSON value per import under `ss:import:<importId>` with a 24 hour life, the parsed rows
 * under `ss:import:<importId>:rows`, and the society lock `ss:import-lock:<societyId>` (set only when absent, 1 hour).
 * All of it goes through `lib/kv`: Redis when `REDIS_URL` is set, memory otherwise. The state is a single value, so
 * the final status and its result are written together (one `SET`, the same guarantee as a Redis MULTI).
 */
export type ImportStatus =
  'VALIDATING' | 'VALIDATED' | 'COMMITTING' | 'COMMITTED' | 'COMMITTED_PARTIAL' | 'FAILED';
export type CommitPolicy = 'ALL_OR_NOTHING' | 'VALID_ROWS_ONLY';

export interface ImportIssue extends RowIssue {
  row: number;
}
export interface ImportResult {
  written: number;
  skipped: number;
  failureCode: string | null;
  failureMessage?: string;
}
export interface ImportState {
  importId: number;
  societyId: number;
  userId: number;
  fileId: number;
  fileName: string;
  mode: ImportMode;
  createMissingBuildings: boolean;
  status: ImportStatus;
  totalRows: number;
  counts: ImportCounts;
  errorsPreview: ImportIssue[];
  reportFileId: number | null;
  commitPolicy: CommitPolicy | null;
  result: ImportResult | null;
  /** Rows the dry run refused for the plan limit; the commit keeps them refused. */
  limitRows: number[];
  createdAt: string;
  expiresAt: string;
}

export const IMPORT_TTL_SECONDS = 24 * 3600;
const LOCK_TTL_SECONDS = 3600;
const stateKey = (id: number) => `ss:import:${id}`;
const rowsKey = (id: number) => `ss:import:${id}:rows`;
const lockKey = (societyId: number) => `ss:import-lock:${societyId}`;

export const nextImportId = (): Promise<number> => kv().counterIncr('ss:import:seq');

export function newState(
  p: Pick<
    ImportState,
    'importId' | 'societyId' | 'userId' | 'fileId' | 'fileName' | 'mode' | 'createMissingBuildings'
  >,
): ImportState {
  const at = now();
  return {
    ...p,
    status: 'VALIDATING',
    totalRows: 0,
    counts: { create: 0, update: 0, unchanged: 0, error: 0 },
    errorsPreview: [],
    reportFileId: null,
    commitPolicy: null,
    result: null,
    limitRows: [],
    createdAt: at.toISOString(),
    expiresAt: addDays(at, 1).toISOString(),
  };
}

const ttlLeft = (s: ImportState): number =>
  Math.max(1, Math.ceil((new Date(s.expiresAt).getTime() - nowMs()) / 1000));

export async function saveState(s: ImportState): Promise<void> {
  await kv().cacheSet(stateKey(s.importId), JSON.stringify(s), ttlLeft(s));
}
export async function loadState(importId: number): Promise<ImportState | null> {
  const raw = await kv().cacheGet(stateKey(importId));
  return raw ? (JSON.parse(raw) as ImportState) : null;
}
export async function saveRows(s: ImportState, sheet: MappedSheet): Promise<void> {
  await kv().cacheSet(rowsKey(s.importId), JSON.stringify(sheet), ttlLeft(s));
}
export async function loadRows(importId: number): Promise<MappedSheet | null> {
  const raw = await kv().cacheGet(rowsKey(importId));
  return raw ? (JSON.parse(raw) as MappedSheet) : null;
}

/** True when this call took the society's import lock. */
export const takeLock = (societyId: number, importId: number): Promise<boolean> =>
  kv().setIfAbsent(lockKey(societyId), String(importId), LOCK_TTL_SECONDS);
/** Releases the lock only when this import still holds it. */
export async function releaseLock(societyId: number, importId: number): Promise<void> {
  if ((await kv().cacheGet(lockKey(societyId))) === String(importId)) await kv().cacheDel(lockKey(societyId));
}
