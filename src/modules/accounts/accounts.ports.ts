import type { Transaction } from 'sequelize';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import type { Ctx } from '../../types/context';
import type {
  ApprovalRequestInput,
  ApprovalResult,
  ApprovalTypeHooks,
  ApprovalsPort,
  NotificationsPort,
} from '../billing/billing.ports';

export type { ApprovalRequestInput, ApprovalResult, ApprovalTypeHooks, ApprovalsPort, NotificationsPort };

/**
 * What module 13 needs from modules 14 (approvals), 16 (notifications), 21 (vendors, vendor bills) and 24 (reports cache). Each port
 * has a placeholder that behaves as the spec describes and records its calls; the owning module replaces it at start-up with
 * `setAccountsPorts({...})` (tests do the same). Same pattern as `payments.ports.ts`. In production `assertAccountsPortsReady()`
 * refuses to start while approvals or notifications are still placeholders. The journal engine is NOT a port: it is real in
 * this module, and `registerAccounts()` installs it behind the module 11 and 12 journal ports.
 */

// ------------------------------------------------------------------ module 21 vendors and vendor bills
export interface VendorsPort {
  /** `vendorId` of an expense (BR-13-28). Placeholder: no vendor exists, so an expense with a vendor is refused by its part. */
  exists(societyId: number, vendorId: number): Promise<boolean>;
  /** Placeholder: no bill exists. */
  getBill(
    societyId: number,
    vendorBillId: number,
  ): Promise<{ id: number; vendorId: number; payablePaise: number } | null>;
  /** BR-13-28: called on posting an expense of type `VENDOR_BILL`; module 21 may reject with `422 VENDOR_BILL_NOT_PAYABLE`. Placeholder: records. */
  recordPayment(
    ctx: Ctx,
    vendorBillId: number,
    input: { expenseId: number; amountPaise: number },
    t: Transaction,
  ): Promise<void>;
  /** Called on reversal of such an expense. Placeholder: records. */
  reversePayment(ctx: Ctx, vendorBillId: number, expenseId: number, t: Transaction): Promise<void>;
}

// ------------------------------------------------------------------ module 24 reports cache (section 8.21)
export interface ReportsCachePort {
  /** `reportsCache.touch(societyId, 'finance')` after commit of every posting, reversal and status change. Never throws. */
  touch(societyId: number, area: 'finance'): void | Promise<void>;
}

export interface AccountsPorts {
  approvals: ApprovalsPort;
  notifications: NotificationsPort;
  vendors: VendorsPort;
  reportsCache: ReportsCachePort;
}
export type AccountsPortName = keyof AccountsPorts;

export interface AccountsPortCall {
  fn: string;
  input: unknown;
  t?: Transaction;
}
/** Every call a placeholder received (tests assert the calls). */
export const accountsPortCalls: AccountsPortCall[] = [];
const record = (fn: string, input: unknown, t?: Transaction) => {
  accountsPortCalls.push({ fn, input, t });
};

let fakeSeq = 0;
/** Registered type hooks (placeholder); the real module 14 keeps its own registry. */
export const placeholderAccountsApprovalTypes = new Map<string, ApprovalTypeHooks>();
export interface PlaceholderAccountsApproval {
  id: number;
  type: string;
  entityType: string;
  entityId: number;
  societyId: number | null;
  requestedBy: number | null;
  /** The `payload` of the request (13.2 fund transfers read it back on approval; module 14 keeps it on the request row). */
  payload?: Record<string, unknown>;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'CANCELLED';
}
/** Requests the placeholder `approvals.request` created: the development approvals page (`?source=accounts`) decides them. */
export const placeholderAccountsApprovals = new Map<number, PlaceholderAccountsApproval>();

export const defaultAccountsPorts: AccountsPorts = {
  approvals: {
    registerType: def => {
      placeholderAccountsApprovalTypes.set(def.type, def);
    },
    request: async (ctx, input, t) => {
      record('approvals.request', input, t);
      const id = ++fakeSeq;
      placeholderAccountsApprovals.set(id, {
        id,
        payload: input.payload,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        societyId: ctx.society?.id ?? null,
        requestedBy: ctx.user?.id ?? null,
        status: 'PENDING',
      });
      return { id, status: 'PENDING' };
    },
    resubmit: async (_ctx, id, input, t) => {
      record('approvals.resubmit', { id, ...input }, t);
      const r = placeholderAccountsApprovals.get(id);
      if (r) r.status = 'PENDING';
    },
    cancel: async (_ctx, id, reason, t) => {
      record('approvals.cancel', { id, reason }, t);
      const r = placeholderAccountsApprovals.get(id);
      if (r) r.status = 'CANCELLED';
    },
    lockOpenForEntity: async (societyId, entityType, entityId) => {
      const open = [...placeholderAccountsApprovals.values()].find(
        r =>
          r.status === 'PENDING' &&
          r.societyId === societyId &&
          r.entityType === entityType &&
          r.entityId === entityId,
      );
      return open ? { id: open.id, type: open.type } : null;
    },
  },
  notifications: {
    send: async (template, userIds, data) => {
      record('notifications.send', { template, userIds, data });
      try {
        await notify(
          template,
          userIds.map(userId => ({ userId })),
          data,
        );
      } catch (err) {
        logger.error({ err, template }, 'accounts notify failed');
      }
    },
  },
  vendors: {
    exists: async () => false,
    getBill: async () => null,
    recordPayment: async (_ctx, vendorBillId, input, t) =>
      record('vendors.recordPayment', { vendorBillId, ...input }, t),
    reversePayment: async (_ctx, vendorBillId, expenseId, t) =>
      record('vendors.reversePayment', { vendorBillId, expenseId }, t),
  },
  reportsCache: {
    touch: (societyId, area) => record('reports.touch', { societyId, area }),
  },
};

let current: AccountsPorts = defaultAccountsPorts;
const replaced = new Set<AccountsPortName>();
export const accountsPorts = (): AccountsPorts => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setAccountsPorts(p?: { [K in keyof AccountsPorts]?: Partial<AccountsPorts[K]> }): void {
  if (!p) {
    current = defaultAccountsPorts;
    replaced.clear();
    accountsPortCalls.length = 0;
    placeholderAccountsApprovals.clear();
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
    replaced.add(k as AccountsPortName);
  }
  current = next as unknown as AccountsPorts;
}

/** Ports whose placeholder is not allowed in production. */
export const PRODUCTION_REQUIRED_PORTS: readonly AccountsPortName[] = ['approvals', 'notifications'];
export const fakePortsInUse = (): AccountsPortName[] =>
  PRODUCTION_REQUIRED_PORTS.filter(n => !replaced.has(n));
export function assertAccountsPortsReady(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv !== 'production') return;
  const fakes = fakePortsInUse();
  if (fakes.length)
    throw new Error(`Accounts ports still use the placeholder in production: ${fakes.join(', ')}`);
}
