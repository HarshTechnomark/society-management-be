import type { Transaction } from 'sequelize';
import { logger } from '../../lib/logger';
import { NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { placeholderFiles, societyPorts } from '../societies/societies.ports';

/**
 * What module 09 needs from modules that are not built yet. Each default is a small placeholder that behaves as the spec
 * describes; the owner calls `setResidentPorts({...})` at start-up (tests do the same). Parts 2 and 3 of module 09 add their
 * own ports here (module 11 `invoices.createAdHoc`, module 13 `deposits`, module 14 `approvals`, module 23
 * `shareCertificates` and `ruleViolations`) beside the ones of part 1.
 */
export interface ResidentPorts {
  /** Module 01 files service. */
  files: {
    /**
     * `files.service.link(ctx, [fileId], 'resident_document', ..., purpose)` (BR-09-37, section 13): throws
     * `422 FILE_NOT_LINKABLE` unless the file exists, belongs to the society, was uploaded by `uploaderUserId`, is clean and
     * has the purpose (`KYC_DOCUMENT` or `RESIDENT_RECORD`).
     */
    linkDocument(
      ctx: Ctx,
      input: {
        fileId: number;
        purpose: 'KYC_DOCUMENT' | 'RESIDENT_RECORD';
        societyId: number;
        uploaderUserId: number;
      },
      t: Transaction,
    ): Promise<void>;
    /** Same for a profile or pet photo (purpose `USER_PHOTO`). */
    linkPhoto(ctx: Ctx, input: { fileId: number; societyId: number }, t: Transaction): Promise<void>;
    /** Unlinks a file so that module 01 deletes it later (document delete, anonymisation); runs after commit. */
    deleteFile(fileId: number): Promise<void>;
    /** `files.service.getDownloadUrl(ctx, fileId, { disposition })` after this module's own access check. */
    downloadUrl(
      ctx: Ctx,
      fileId: number,
      opts: { disposition: 'inline' | 'attachment' },
    ): Promise<{ url: string; expiresAt: Date }>;
  };
  /** Module 12: cancels the payer's AutoPay mandates and live payment orders for the unit (BR-09-18). */
  payments: { onUnitLinkEnded(ctx: Ctx, unitId: number, userId: number, t: Transaction): Promise<void> };
  /** Module 19: releases the resident's parking allotments and vehicle links on the unit (BR-09-18). */
  parking: { onUnitLinkEnded(ctx: Ctx, unitId: number, residentId: number, t: Transaction): Promise<void> };
  /** Module 24 `reportsCache.touch(societyId, 'residents')`, called after commit; never throws. */
  reportsCache: { touch(societyId: number, scope: 'residents'): void };
  /** Module 11 `unitLedger.balance(societyId, unitId)`: positive means the unit owes (paise). */
  unitLedger: { balance(societyId: number, unitId: number): Promise<number> };
  /** Module 17 `sos.getActive(societyId, sosId)`: `null` when unknown or of another society. */
  sos: {
    getActive(
      societyId: number,
      sosId: number,
    ): Promise<{ id: number; unitId: number; status: 'ACTIVE' | 'RESOLVED' } | null>;
  };
}

export interface ResidentPortCall {
  fn: string;
  input: unknown;
  t?: Transaction;
}
/** Every call a placeholder received (tests assert the calls and that they ran in the caller's transaction). */
export const residentPortCalls: ResidentPortCall[] = [];

const notLinkable = (field = 'fileId') =>
  new UnprocessableError('FILE_NOT_LINKABLE', 'This file cannot be used here', [
    { field, message: 'Upload the file again' },
  ]);

export const defaultResidentPorts: ResidentPorts = {
  files: {
    linkDocument: async (_ctx, i) => {
      const f = placeholderFiles.get(i.fileId);
      if (
        !f ||
        f.status !== 'CLEAN' ||
        f.purpose !== i.purpose ||
        f.societyId !== i.societyId ||
        f.ownerUserId !== i.uploaderUserId
      )
        throw notLinkable();
    },
    linkPhoto: async (_ctx, i) => {
      const f = placeholderFiles.get(i.fileId);
      if (!f || f.status !== 'CLEAN' || f.purpose !== 'USER_PHOTO' || f.societyId !== i.societyId)
        throw notLinkable('photoFileId');
    },
    deleteFile: async fileId => {
      residentPortCalls.push({ fn: 'files.deleteFile', input: { fileId } });
      await societyPorts().files.deleteFile(fileId);
    },
    downloadUrl: async (_ctx, fileId) => {
      const f = placeholderFiles.get(fileId);
      if (!f || f.status !== 'CLEAN') throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
      return societyPorts().files.downloadUrl(fileId, 5);
    },
  },
  payments: {
    onUnitLinkEnded: async (_ctx, unitId, userId, t) => {
      residentPortCalls.push({ fn: 'payments.onUnitLinkEnded', input: { unitId, userId }, t });
    },
  },
  parking: {
    onUnitLinkEnded: async (_ctx, unitId, residentId, t) => {
      residentPortCalls.push({ fn: 'parking.onUnitLinkEnded', input: { unitId, residentId }, t });
    },
  },
  reportsCache: {
    touch: (societyId, scope) => {
      residentPortCalls.push({ fn: 'reportsCache.touch', input: { societyId, scope } });
    },
  },
  unitLedger: { balance: async () => 0 },
  sos: { getActive: async () => null },
};

let current: ResidentPorts = defaultResidentPorts;
export const residentPorts = (): ResidentPorts => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setResidentPorts(p?: { [K in keyof ResidentPorts]?: Partial<ResidentPorts[K]> }): void {
  if (!p) {
    current = defaultResidentPorts;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as ResidentPorts;
}

/** After-commit helper: a port that throws never undoes the action it follows. */
export function touchReports(t: Transaction, societyId: number): void {
  t.afterCommit(() => {
    try {
      residentPorts().reportsCache.touch(societyId, 'residents');
    } catch (err) {
      logger.warn({ err }, 'reportsCache.touch failed');
    }
  });
}
