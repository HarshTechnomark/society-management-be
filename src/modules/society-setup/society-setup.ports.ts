import type { Transaction } from 'sequelize';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { nextPlaceholderFileId, placeholderFiles, societyPorts } from '../societies/societies.ports';

/**
 * What module 08 needs from modules that are not built yet. The default is a small placeholder that behaves as the spec
 * describes; the owner calls `setSetupPorts({...})` at start-up (tests do the same).
 */
export interface SetupPorts {
  files: {
    /**
     * Module 01 `files.service.link(ctx, [fileId], 'society', societyId, 'SOCIETY_LOGO')` (BR-08-5): throws
     * `422 FILE_NOT_LINKABLE` when the file has the wrong purpose, society or state.
     */
    linkSocietyLogo(ctx: Ctx, fileId: number, societyId: number, t: Transaction): Promise<void>;
    /**
     * The uploaded import file (BR-08-33, section 8.15). The real module 01 files service must: throw
     * `404 FILE_NOT_FOUND` for an unknown file, another society's file or a file the caller did not upload; throw
     * `422 FILE_NOT_LINKABLE` when the purpose is not `IMPORT_FILE`; throw `409 IMPORT_FILE_NOT_READY` unless the virus
     * scan status is `CLEAN`; and return the bytes (at most 20 MB) with the original file name.
     */
    getImportFile(
      societyId: number,
      userId: number,
      fileId: number,
    ): Promise<{ fileId: number; name: string; contentType: string; content: Buffer }>;
  };
  /** Module 09 (not built yet). */
  residents: {
    /** Section 6.5 step 5: sends the welcome invites of a society that just went live. Idempotent in module 09. */
    sendWelcomeInvites(ctx: Ctx, societyId: number): Promise<void>;
  };
}

/** Files put into the memory store as not yet scanned clean (the `409 IMPORT_FILE_NOT_READY` path). */
const notScannedFiles = new Set<number>();

/** Societies the default `residents.sendWelcomeInvites` placeholder was called for (tests read it). */
export const welcomeInviteCalls: number[] = [];

const notLinkable = () =>
  new UnprocessableError('FILE_NOT_LINKABLE', 'This file cannot be used as the society logo', [
    { field: 'logoFileId', message: 'Upload the logo again' },
  ]);

export const defaultSetupPorts: SetupPorts = {
  files: {
    linkSocietyLogo: async (_ctx, fileId, societyId) => {
      const f = placeholderFiles.get(fileId);
      if (!f || f.purpose !== 'SOCIETY_LOGO' || f.status !== 'CLEAN') throw notLinkable();
      if (f.societyId !== null && f.societyId !== societyId) throw notLinkable();
    },
    getImportFile: async (societyId, userId, fileId) => {
      const f = placeholderFiles.get(fileId);
      if (!f || f.status === 'DELETED' || f.societyId !== societyId || f.ownerUserId !== userId)
        throw new NotFoundError('FILE_NOT_FOUND', 'File not found');
      if (f.purpose !== 'IMPORT_FILE')
        throw new UnprocessableError('FILE_NOT_LINKABLE', 'This file cannot be used for an import', [
          { field: 'fileId', message: 'Upload the sheet again as an import file' },
        ]);
      if (notScannedFiles.has(fileId))
        throw new AppError(409, 'IMPORT_FILE_NOT_READY', 'The file has not been scanned clean yet');
      return { fileId, name: f.name, contentType: f.contentType, content: f.content };
    },
  },
  residents: {
    sendWelcomeInvites: async (_ctx, societyId) => {
      welcomeInviteCalls.push(societyId);
      logger.info({ societyId }, 'module 09 is not built: welcome invites not sent (placeholder port)');
    },
  },
};

/**
 * Puts a file into the memory store behind the placeholder `files.getImportFile` and returns its id. Development and
 * tests only (`POST /dev/files` uses it); the real module 01 files service has its own upload flow.
 */
export function putPlaceholderFile(input: {
  societyId: number;
  ownerUserId: number;
  name: string;
  content: Buffer;
  purpose?: string;
  contentType?: string;
  /** `PENDING` or `INFECTED` makes `getImportFile` answer `409 IMPORT_FILE_NOT_READY`. */
  scan?: 'CLEAN' | 'PENDING' | 'INFECTED';
}): number {
  const fileId = nextPlaceholderFileId();
  placeholderFiles.set(fileId, {
    fileId,
    societyId: input.societyId,
    purpose: input.purpose ?? 'IMPORT_FILE',
    name: input.name,
    contentType: input.contentType ?? 'application/octet-stream',
    content: input.content,
    ownerUserId: input.ownerUserId,
    status: 'CLEAN',
  });
  if (input.scan && input.scan !== 'CLEAN') notScannedFiles.add(fileId);
  return fileId;
}

let current: SetupPorts = defaultSetupPorts;
export const setupPorts = (): SetupPorts => current;
export function setSetupPorts(p?: { [K in keyof SetupPorts]?: Partial<SetupPorts[K]> }): void {
  if (!p) {
    current = defaultSetupPorts;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as SetupPorts;
}

/**
 * Placeholder behind `GET /files/:id/download-url` (development and test only, until module 01 provides the route): the
 * file must belong to the society (the import report or export file). The real route also checks the caller's permission.
 */
export async function placeholderDownloadUrl(
  societyId: number,
  fileId: number,
): Promise<{ url: string; expiresAt: Date }> {
  const f = placeholderFiles.get(fileId);
  if (!f || f.status !== 'CLEAN' || f.societyId !== societyId)
    throw new NotFoundError('FILE_NOT_FOUND', 'File not found');
  return societyPorts().files.downloadUrl(fileId, 5);
}
