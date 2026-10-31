import type { Transaction } from 'sequelize';
import { User } from '../../models';
import type { Ctx } from '../../types/context';
import { NotFoundError, UnprocessableError } from '../../utils/errors';
import type { ClientApp, MembershipView } from './auth.types';

/**
 * Ports module 02 consumes from other modules (section 8.30). Each has a default stub that behaves as the spec
 * describes until the owning module exists. The owner calls `setAuthPorts({...})` at start-up to replace it.
 */
export interface SupportGrantInfo {
  grantId: number;
  societyId: number;
  scope: 'READ_ONLY' | 'READ_WRITE';
  endsAt: Date;
}

export interface AuthPorts {
  /** Module 03 */
  authAccess: {
    listMemberships(userId: number): Promise<MembershipView[]>;
    hasAppAccess(userId: number, app: ClientApp): Promise<boolean>;
    userRequiresMfa(userId: number): Promise<boolean>;
    getPermissions(userId: number, societyId: number): Promise<string[]>;
    /** Platform permission keys of the user's platform role (not in the spec port list; needed by 8.13 and 8.31). */
    getPlatformPermissions(userId: number): Promise<string[]>;
    deletionBlockers(userId: number): Promise<string[]>;
    onUserAnonymised(userId: number, t: Transaction): Promise<void>;
  };
  /** Module 01 files service: link and unlink a profile photo (`files.service.link(ctx, [id], 'user', userId, 'USER_PHOTO')`) */
  files: {
    linkUserPhoto(ctx: Ctx, fileId: number, userId: number, tx: Transaction): Promise<void>;
    unlinkUserPhoto(ctx: Ctx, fileId: number, tx: Transaction): Promise<void>;
  };
  /** Module 04 */
  entitlements: { getFeatures(societyId: number): Promise<string[]> };
  /** Module 05 */
  supportAccess: {
    validateForHandoff(userId: number, grantId: number): Promise<SupportGrantInfo>;
    markEntered(grantId: number, tx: Transaction): Promise<void>;
    isGrantActive(grantId: number): Promise<boolean>;
    getGrantSummary(grantId: number): Promise<{ id: number; scope: string; endsAt: Date }>;
  };
  /** Module 07 */
  getPlatformSetting(key: 'security.idleMinutes' | 'security.stepUpMinutes'): Promise<number>;
  /** Module 08 */
  societySettings: {
    getSessionPolicy(societyId: number): Promise<{ adminIdleMinutes: number; stepUpMinutes: number }>;
  };
  /** Module 09 */
  residentsHooks: {
    onUserMobileChanged(userId: number, oldMobile: string, newMobile: string, t: Transaction): Promise<void>;
    onUserAnonymised(userId: number, t: Transaction): Promise<void>;
  };
  /** Module 16 */
  communicationHooks: {
    onSessionRevoked(sessionId: number): Promise<void>;
    onUserAnonymised(userId: number, t: Transaction): Promise<void>;
  };
  /** Module 25 */
  residentApp: { onUserAnonymised(userId: number, t: Transaction): Promise<void> };
}

const noop = async () => {};

export const defaultPorts: AuthPorts = {
  authAccess: {
    listMemberships: async () => [],
    hasAppAccess: async (userId, app) => {
      if (app === 'RESIDENT') return true;
      if (app === 'PLATFORM') return Boolean((await User.findByPk(userId))?.platformRoleId);
      return false;
    },
    userRequiresMfa: async userId => Boolean((await User.findByPk(userId))?.platformRoleId),
    getPermissions: async () => [],
    getPlatformPermissions: async () => [],
    deletionBlockers: async userId =>
      (await User.findByPk(userId))?.platformRoleId ? ['PLATFORM_USER'] : [],
    onUserAnonymised: noop,
  },
  files: {
    linkUserPhoto: async () => {
      throw new UnprocessableError(
        'FILE_NOT_LINKABLE',
        'Profile photos are not available until the files service is built',
      );
    },
    unlinkUserPhoto: noop,
  },
  entitlements: { getFeatures: async () => [] },
  supportAccess: {
    validateForHandoff: async () => {
      throw new NotFoundError('NOT_FOUND', 'Support access is not available yet');
    },
    markEntered: noop,
    isGrantActive: async () => false,
    getGrantSummary: async () => {
      throw new NotFoundError('NOT_FOUND', 'Support access is not available yet');
    },
  },
  getPlatformSetting: async key => (key === 'security.idleMinutes' ? 30 : 5),
  societySettings: { getSessionPolicy: async () => ({ adminIdleMinutes: 30, stepUpMinutes: 5 }) },
  residentsHooks: { onUserMobileChanged: noop, onUserAnonymised: noop },
  communicationHooks: { onSessionRevoked: noop, onUserAnonymised: noop },
  residentApp: { onUserAnonymised: noop },
};

let current: AuthPorts = defaultPorts;
export const ports = (): AuthPorts => current;

/** Replace some ports (module start-up, or tests). Pass nothing to restore the stubs. */
export function setAuthPorts(p?: { [K in keyof AuthPorts]?: Partial<AuthPorts[K]> | AuthPorts[K] }): void {
  if (!p) {
    current = defaultPorts;
    return;
  }
  const next: any = { ...current };
  for (const [k, v] of Object.entries(p))
    next[k] = typeof v === 'function' ? v : { ...(current as any)[k], ...v };
  current = next as AuthPorts;
}
