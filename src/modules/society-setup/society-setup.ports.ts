import type { Transaction } from 'sequelize';
import { UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { placeholderFiles } from '../societies/societies.ports';

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
  };
}

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
  },
};

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
