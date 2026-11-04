import type { Transaction } from 'sequelize';
import { addMinutes, now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { SETTING_DEFAULTS, type SettingKey } from './societies.types';

/**
 * Functions module 05 needs from modules that are not built yet (01 files service, 06 platform billing, 07 platform
 * settings, 08 units and onboarding, 12 payments, 17 gate). Each default is a small placeholder that behaves as the
 * spec describes until the owner exists; the owner calls `setSocietyPorts({...})` at start-up (tests do the same).
 * Every call that changes something is also recorded in `portCalls` so tests can assert it ran in the caller's transaction.
 */
export interface StoredFile {
  fileId: number;
  societyId: number | null;
  purpose: string;
  name: string;
  contentType: string;
  content: Buffer;
  ownerUserId: number | null;
  status: 'CLEAN' | 'DELETED';
}

export interface SocietyPorts {
  /** Module 07 `platform_settings`; code defaults until module 07 exists. */
  settings: { get(key: SettingKey): Promise<number> };
  /** Module 06. */
  billing: { hasOverdueInvoice(societyId: number, t?: Transaction): Promise<boolean> };
  /** Module 17: revokes every paired guard device of the society inside the close transaction. */
  guardDevices: { revokeAllForSociety(ctx: Ctx, societyId: number, t: Transaction): Promise<number> };
  /** Module 12: cancels autopay mandates at closure. */
  autopay: { cancelAllForSociety(ctx: Ctx, societyId: number, t: Transaction): Promise<number> };
  /** Module 08: units and onboarding progress (null while not built). */
  units: { count(societyId: number): Promise<number | null> };
  onboarding: { progressPercent(societyId: number): Promise<number | null> };
  /** Module 12: collected ÷ billed for invoices due in the month (`YYYY-MM`); null when nothing was billed. */
  collections: { efficiency(societyId: number, month: string): Promise<number | null> };
  /** Module 01 files service. */
  files: {
    storeSystemFile(input: {
      societyId: number;
      purpose: 'EXPORT_FILE' | 'PLATFORM_INVOICE_PDF' | 'INVOICE_PDF';
      content: Buffer;
      name: string;
      contentType: string;
      ownerUserId: number | null;
    }): Promise<{ fileId: number; sizeBytes: number }>;
    /** Short-lived URL issued after the module's own permission check (module 01 "module 05 decides"). */
    downloadUrl(fileId: number, ttlMinutes: number): Promise<{ url: string; expiresAt: Date }>;
    deleteFile(fileId: number): Promise<void>;
    /** `CLEAN` society files for the export (purposes other than EXPORT_FILE and IMPORT_FILE). */
    listSocietyDocuments(
      societyId: number,
    ): Promise<{ fileId: number; purpose: string; name: string; content: Buffer }[]>;
    /** Purge (BR-05-21): delete the society's files except the financial purposes. */
    deleteNonFinancialFiles(societyId: number, keepPurposes: readonly string[]): Promise<number>;
    /** Financial retention end (BR-05-38): delete the retained financial files. */
    deleteFinancialFiles(societyId: number, purposes: readonly string[]): Promise<number>;
  };
}

export interface PortCall {
  fn: string;
  input: unknown;
  t?: Transaction;
}
export const portCalls: PortCall[] = [];

/** Placeholder file store (memory) until the module 01 files service exists; `GET /api/v1/dev/files/:id` serves it outside production. */
export const placeholderFiles = new Map<number, StoredFile>();
// Outside tests the ids start from the clock, so a restart never reuses an id that a database row still points to.
let fileSeq = process.env.NODE_ENV === 'test' ? 0 : Math.floor(Date.now() / 1000);
/** A fresh id from the same sequence `storeSystemFile` uses (module 08 puts import files into the memory store with it). */
export const nextPlaceholderFileId = (): number => ++fileSeq;

export const defaultSocietyPorts: SocietyPorts = {
  settings: { get: async key => SETTING_DEFAULTS[key] },
  billing: { hasOverdueInvoice: async () => false },
  guardDevices: {
    revokeAllForSociety: async (_ctx, societyId, t) => {
      portCalls.push({ fn: 'guardDevices.revokeAllForSociety', input: { societyId }, t });
      return 0;
    },
  },
  autopay: {
    cancelAllForSociety: async (_ctx, societyId, t) => {
      portCalls.push({ fn: 'autopay.cancelAllForSociety', input: { societyId }, t });
      return 0;
    },
  },
  units: { count: async () => null },
  onboarding: { progressPercent: async () => null },
  collections: { efficiency: async () => null },
  files: {
    storeSystemFile: async input => {
      const fileId = nextPlaceholderFileId();
      placeholderFiles.set(fileId, {
        fileId,
        societyId: input.societyId,
        purpose: input.purpose,
        name: input.name,
        contentType: input.contentType,
        content: input.content,
        ownerUserId: input.ownerUserId,
        status: 'CLEAN',
      });
      return { fileId, sizeBytes: input.content.length };
    },
    downloadUrl: async (fileId, ttlMinutes) => ({
      url: `/api/v1/dev/files/${fileId}`,
      expiresAt: addMinutes(now(), ttlMinutes),
    }),
    deleteFile: async fileId => {
      const f = placeholderFiles.get(fileId);
      if (f) f.status = 'DELETED';
    },
    listSocietyDocuments: async societyId =>
      [...placeholderFiles.values()]
        .filter(
          f =>
            f.societyId === societyId &&
            f.status === 'CLEAN' &&
            f.purpose !== 'EXPORT_FILE' &&
            f.purpose !== 'IMPORT_FILE',
        )
        .map(f => ({ fileId: f.fileId, purpose: f.purpose, name: f.name, content: f.content })),
    deleteNonFinancialFiles: async (societyId, keep) => {
      let n = 0;
      for (const f of placeholderFiles.values())
        if (f.societyId === societyId && f.status === 'CLEAN' && !keep.includes(f.purpose)) {
          f.status = 'DELETED';
          n++;
        }
      return n;
    },
    deleteFinancialFiles: async (societyId, purposes) => {
      let n = 0;
      for (const f of placeholderFiles.values())
        if (f.societyId === societyId && f.status === 'CLEAN' && purposes.includes(f.purpose)) {
          f.status = 'DELETED';
          n++;
        }
      return n;
    },
  },
};

let current: SocietyPorts = defaultSocietyPorts;
export const societyPorts = (): SocietyPorts => current;

/** Replace some ports (owner modules at start-up, or tests). Pass nothing to restore the placeholders. */
export function setSocietyPorts(p?: { [K in keyof SocietyPorts]?: Partial<SocietyPorts[K]> }): void {
  if (!p) {
    current = defaultSocietyPorts;
    portCalls.length = 0;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as SocietyPorts;
}

export const setting = (key: SettingKey): Promise<number> => current.settings.get(key);
