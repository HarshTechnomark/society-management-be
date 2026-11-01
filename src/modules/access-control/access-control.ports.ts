import type { Transaction } from 'sequelize';
import { SocietyMember } from '../../models';
import type { Invitation } from '../../models/invitation.model';
import { PaymentRequiredError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import type { ActiveSupportGrant, LimitKey, UnitLink } from './access-control.types';

/**
 * Ports module 03 consumes from other modules (section 8.21). Each default is a small placeholder that behaves as the spec
 * describes until the owning module exists; the owner calls `setAccessPorts({...})` at start-up (tests do the same).
 */
export interface AccessPorts {
  /** Module 04. `consumeLimit` throws `402 USAGE_LIMIT_EXCEEDED`. */
  entitlements: {
    /** `societyId` is required when `ctx.society` is not set (system contexts). */
    consumeLimit(
      ctx: Ctx,
      key: LimitKey,
      amount: number,
      opts: { transaction: Transaction; societyId?: number },
    ): Promise<void>;
    releaseLimit(
      ctx: Ctx,
      key: LimitKey,
      amount: number,
      opts: { transaction: Transaction; societyId?: number },
    ): Promise<void>;
    /** `limit` null means unlimited; `used` is the current consumption. */
    getLimit(societyId: number, key: LimitKey): Promise<{ limit: number | null; used: number }>;
    planKeyFor(societyId: number): Promise<string>;
  };
  /** Module 05. */
  support: {
    getActiveGrant(platformUserId: number, societyId: number): Promise<ActiveSupportGrant | null>;
  };
  /** Module 09. Links with `toDate` NULL or today or later, resident ACTIVE. */
  residents: {
    getActiveUnitLinks(societyId: number, userId: number): Promise<UnitLink[]>;
    /** Module 09 calls back into `onResidentInvitationAccepted` when an invitation carries a `residentId`. */
    onResidentInvitationAccepted(tx: Transaction, invitation: Invitation, userId: number): Promise<void>;
    /** Module 08 unit labels for the member drawer. */
    getUnitLabels(societyId: number, unitIds: number[]): Promise<Record<number, string>>;
  };
  /** Module 14. */
  approvals: {
    onMemberEnded(ctx: Ctx, societyId: number, userId: number, tx: Transaction): Promise<void>;
  };
  /** Module 01 file service: stores an export and returns a short-lived download link. */
  files: {
    storeExport(
      ctx: Ctx,
      input: { name: string; contentType: string; content: string },
    ): Promise<{ fileId: number; downloadUrl: string; expiresAt: Date }>;
  };
}

const noop = async () => {};
const exports_ = new Map<number, { name: string; contentType: string; content: string; expiresAt: Date }>();
let exportSeq = 0;
/** Placeholder file store for exports (memory); `dev.routes.ts` serves it outside production. */
export const placeholderExports = exports_;

export const defaultAccessPorts: AccessPorts = {
  entitlements: {
    consumeLimit: noop,
    releaseLimit: noop,
    getLimit: async (societyId, key) => ({
      limit: null,
      used:
        key === 'limit.admin_seats'
          ? await SocietyMember.count({
              where: { societyId, status: ['ACTIVE', 'SUSPENDED'] },
              include: [
                { association: 'Role', where: { consumesSeat: true }, attributes: [], required: true },
              ],
            })
          : 0,
    }),
    planKeyFor: async () => 'STANDARD',
  },
  support: { getActiveGrant: async () => null },
  residents: {
    getActiveUnitLinks: async () => [],
    onResidentInvitationAccepted: noop,
    getUnitLabels: async () => ({}),
  },
  approvals: { onMemberEnded: noop },
  files: {
    storeExport: async (_ctx, input) => {
      const fileId = ++exportSeq;
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      exports_.set(fileId, { ...input, expiresAt });
      return { fileId, downloadUrl: `/api/v1/dev/exports/${fileId}`, expiresAt };
    },
  },
};

let current: AccessPorts = defaultAccessPorts;
export const accessPorts = (): AccessPorts => current;

/** Replace some ports (module start-up, or tests). Pass nothing to restore the placeholders. */
export function setAccessPorts(p?: { [K in keyof AccessPorts]?: Partial<AccessPorts[K]> }): void {
  if (!p) {
    current = defaultAccessPorts;
    return;
  }
  const next: any = { ...current };
  for (const [k, v] of Object.entries(p)) next[k] = { ...(current as any)[k], ...v };
  current = next as AccessPorts;
}

/** `402 USAGE_LIMIT_EXCEEDED` with the limit name (helper for fakes and the real module 04). */
export const usageLimitExceeded = (key: LimitKey) =>
  new PaymentRequiredError('USAGE_LIMIT_EXCEEDED', `Plan limit reached (${key})`);
