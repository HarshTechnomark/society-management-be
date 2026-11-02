import { placeholderFiles } from '../societies/societies.ports';
import type { Ctx } from '../../types/context';
import type { Transaction } from 'sequelize';
import { UnprocessableError } from '../../utils/errors';

/**
 * Functions module 07 needs from modules that are not built yet. Each default is a small placeholder that behaves as the
 * spec describes; the owner calls `setPlatformOpsPorts({...})` at start-up (tests do the same).
 *
 * `files`: module 01 files service (`files.service.link`, purpose `PLATFORM_ATTACHMENT`, section 8.3). The placeholder
 * checks the memory file store of module 05's placeholder (`placeholderFiles`) and keeps the links in memory.
 */
export interface Attachment {
  fileId: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: 'CLEAN' | 'DELETED';
}

export interface PlatformOpsPorts {
  files: {
    /** Checks every file is a clean `PLATFORM_ATTACHMENT` upload of the caller and links it to the message. */
    linkMessageFiles(
      ctx: Ctx,
      input: { fileIds: number[]; societyId: number; messageId: number },
      tx: Transaction,
    ): Promise<void>;
    /** Attachments of messages, by message id. */
    attachmentsFor(messageIds: number[]): Promise<Map<number, Attachment[]>>;
  };
}

const links = new Map<number, number[]>(); // messageId -> fileIds
export const placeholderLinks = links;

const notLinkable = () =>
  new UnprocessableError('FILE_NOT_LINKABLE', 'An attachment cannot be linked to this message');

export const defaultPlatformOpsPorts: PlatformOpsPorts = {
  files: {
    linkMessageFiles: async (ctx, input) => {
      const linkedAlready = new Set([...links.values()].flat());
      for (const id of input.fileIds) {
        const f = placeholderFiles.get(id);
        if (
          !f ||
          f.status !== 'CLEAN' ||
          f.purpose !== 'PLATFORM_ATTACHMENT' ||
          f.ownerUserId !== (ctx.user?.id ?? null) ||
          (f.societyId !== null && f.societyId !== input.societyId) ||
          linkedAlready.has(id)
        )
          throw notLinkable();
      }
      links.set(input.messageId, [...input.fileIds]);
    },
    attachmentsFor: async messageIds => {
      const out = new Map<number, Attachment[]>();
      for (const m of messageIds) {
        const ids = links.get(m);
        if (!ids) continue;
        out.set(
          m,
          ids.map(id => {
            const f = placeholderFiles.get(id)!;
            return {
              fileId: id,
              originalName: f.name,
              mimeType: f.contentType,
              sizeBytes: f.content.length,
              status: f.status,
            };
          }),
        );
      }
      return out;
    },
  },
};

let current: PlatformOpsPorts = defaultPlatformOpsPorts;
export const opsPorts = (): PlatformOpsPorts => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setPlatformOpsPorts(p?: {
  [K in keyof PlatformOpsPorts]?: Partial<PlatformOpsPorts[K]>;
}): void {
  if (!p) {
    current = defaultPlatformOpsPorts;
    links.clear();
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as PlatformOpsPorts;
}
